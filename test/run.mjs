/**
 * dsh-credit-hub 测试套件：`node test/run.mjs`（系统 Node ≥ 22 或 DSH 内置运行时）。
 *
 * 覆盖：normalize（两种上游线格式 → 宿主块协议）、wire（消息/工具转换 + WorkBuddy
 * 出站修正）、sanitizeEfforts（宿主一票否决的元数据消毒）、hub 装配（目录/降级链/
 * 模型开关）、存储往返、WorkBuddy 运行时装配、网关 E2E（OpenAI/Anthropic/组合链/
 * 故障转移/自定义 Key 持久化）。
 */

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNormalizer } from '../src/normalize.js'
import { toChatMessages, toClaudeMessages, toChatTools, repairWorkbuddyBody } from '../src/wire.js'
import { sanitizeEfforts, finiteOr } from '../src/util.js'
import { createStores, mintKey } from '../src/store.js'
import { createHubRuntime } from '../src/hub.js'
import { createUpstreamRuntime } from '../src/aggregate.js'
import { createWorkbuddyRuntime } from '../src/workbuddy.js'
import { startGateway } from '../src/forward.js'
import { createPackBridge, parsePackModelId } from '../src/pack-bridge.js'
import { postSse } from '../src/http.js'
import { createRing } from '../src/util.js'

let failures = 0
const test = (name, fn) => {
  try { fn(); console.log(`ok   ${name}`) } catch (error) { failures += 1; console.log(`FAIL ${name}: ${error.message}`) }
}
const testAsync = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`) } catch (error) { failures += 1; console.log(`FAIL ${name}: ${error.message}`) }
}
const tmpDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const rmDir = async dir => fs.promises.rm(dir, { recursive: true, force: true })

// ── normalize ──────────────────────────────────────────────────────────────
test('normalize openai-chat full turn', () => {
  const chunks = []
  const n = createNormalizer('openai-chat', chunk => chunks.push(chunk))
  n.feed(JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] }))
  n.feed(JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }))
  n.feed(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"p' } }] } }] }))
  n.feed(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '":1}' } }] } }] }))
  n.feed(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  const types = chunks.map(c => c.type)
  assert(types.includes('block-start') && types.includes('reasoning-delta') && types.includes('text-delta') && types.includes('tool-call-delta'))
  const toolEnd = chunks.find(c => c.type === 'block-end' && c.block?.type === 'tool-call')
  assert.deepStrictEqual(JSON.parse(toolEnd.block.arguments), { p: 1 })
  assert.equal(toolEnd.block.name, 'read')
  assert.equal(chunks.find(c => c.type === 'usage').usage.inputTokens, 10)
  assert.equal(n.outcome().finish, 'tool_calls')
})

test('normalize anthropic full turn (usage merges across frames)', () => {
  const chunks = []
  const n = createNormalizer('anthropic-messages', chunk => chunks.push(chunk))
  n.feed(JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 7 } } }))
  n.feed(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }))
  n.feed(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }))
  n.feed(JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'grep' } }))
  n.feed(JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } }))
  n.feed(JSON.stringify({ type: 'content_block_stop', index: 1 }))
  n.feed(JSON.stringify({ type: 'content_block_stop', index: 0 }))
  n.feed(JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }))
  const toolEnd = chunks.find(c => c.type === 'block-end' && c.block?.type === 'tool-call')
  assert.equal(toolEnd.block.name, 'grep')
  assert.deepStrictEqual(JSON.parse(toolEnd.block.arguments), { q: 'x' })
  const outcome = n.outcome()
  assert.equal(outcome.usage.inputTokens, 7)
  assert.equal(outcome.usage.outputTokens, 3)
  assert.equal(outcome.finish, 'tool_use')
})

// ── wire ───────────────────────────────────────────────────────────────────
test('harness → chat messages with tool pairing', () => {
  const warnings = []
  const out = toChatMessages([
    { role: 'system', content: 'be nice' },
    { role: 'user', content: [{ type: 'text', text: 'list files' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'ls', arguments: '{"p":"/"}' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }] }] },
  ], warnings)
  assert.equal(out[0].role, 'system')
  assert.equal(out[2].tool_calls[0].function.name, 'ls')
  assert.equal(out[3].role, 'tool')
  assert.equal(out[3].tool_call_id, 'c1')
  assert.equal(out[3].content, 'a.txt')
})

test('harness → claude messages with tool_result merge', () => {
  const out = toClaudeMessages([
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'ls', arguments: '{}' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] }] },
    { role: 'user', content: 'thanks' },
  ])
  assert.equal(out.system, 'sys')
  assert.equal(out.messages.find(m => m.role === 'assistant').content[0].type, 'tool_use')
  const user = out.messages.find(m => m.role === 'user')
  assert.equal(user.content[0].type, 'tool_result')
  assert.equal(user.content[1].type, 'text')
})

test('workbuddy body repair', () => {
  const body = repairWorkbuddyBody({
    max_completion_tokens: 100,
    tool_choice: { type: 'function', function: { name: 'ls' } },
    tools: [{ type: 'function', function: { name: 'ls' } }],
  })
  assert.equal(body.max_tokens, 100)
  assert.equal(body.tool_choice, 'ls')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
})

test('chat tools from both shapes', () => {
  assert.equal(toChatTools([{ name: 'a', parameters: { type: 'object' } }])[0].function.name, 'a')
  assert.equal(toChatTools([{ type: 'function', function: { name: 'b', parameters: { type: 'object' } } }])[0].function.name, 'b')
})

// ── 元数据消毒（宿主一票否决的根因） ────────────────────────────────────────
test('sanitizeEfforts: hy4free 脏档位（重复/未知/大小写）', () => {
  const clean = sanitizeEfforts(['high', 'high', 'turbo', 'max', 'HIGH'], 'max')
  assert.deepEqual(clean.efforts, ['high', 'max'])
  assert.equal(clean.defaultEffort, 'max')
  assert.equal(sanitizeEfforts(['low', 'high'], 'ultra').defaultEffort, 'high')
  assert.equal(sanitizeEfforts(['turbo', 42, null]), undefined)
  assert.equal(sanitizeEfforts([]), undefined)
  assert.equal(finiteOr(Number.NaN, 128000), 128000)
  assert.equal(finiteOr(64000, 1), 64000)
})

// ── stores ─────────────────────────────────────────────────────────────────
test('stores round trip + key', async () => {
  const dir = tmpDir('ch-test-')
  const stores = createStores(dir)
  stores.settings.update(s => ({ ...s, gatewayPort: 9001 }))
  stores.accounts.update(a => ({ ...a, upstreams: [{ id: 'u1', apiKey: 'sk-test-1234567890' }] }))
  assert.equal(stores.settings.load().gatewayPort, 9001)
  assert.match(mintKey(), /^[A-Za-z0-9_-]{40,80}$/)
  stores.dispose()
  const stores2 = createStores(dir)
  assert.equal(stores2.settings.load().gatewayPort, 9001)
  stores2.dispose()
  await rmDir(dir)
})

// ── hub：目录 / 模型开关 / 降级链 / 未知模型 fail-fast ───────────────────────
const makeSource = (tag, answer, fail) => ({
  listModels: async () => fail ? [] : [{ id: `${tag}/m1`, source: tag === 'wb' ? 'workbuddy' : 'upstream', name: `M1 ${tag}`, contextWindow: 128000, maxOutput: 8192 }],
  streamTurn: async ({ onChunk }) => {
    if (fail) throw new Error(`${tag} down`)
    onChunk({ type: 'block-start', index: 0, blockType: 'text' })
    onChunk({ type: 'text-delta', index: 0, text: `${tag}-a` })
    onChunk({ type: 'text-delta', index: 0, text: `${tag}-b` })
    onChunk({ type: 'block-end', index: 0, block: { type: 'text', text: `${tag}-a${tag}-b` } })
    return { sawText: true, sawFinish: true, finish: 'stop', usage: { inputTokens: 5, outputTokens: 2 }, nextIndex: 1 }
  },
  status: () => ({ accounts: 1, ok: 1 }),
})

await testAsync('hub catalog + model toggle + combo failover + unknown fail-fast', async () => {
  const dir = tmpDir('ch-hub-')
  const stores = createStores(dir)
  const turns = []
  const workbuddy = makeSource('wb')
  const upstreams = makeSource('up')
  workbuddy.streamTurn = async ({ onChunk }) => { turns.push('wb'); throw new Error('wb down') }
  const hub = createHubRuntime({
    stores, workbuddy, upstreams, logger: console, warn: () => {},
    recordTurn: row => turns.push(`turn:${row.model}:${row.ok === true ? 'ok' : 'fail'}`),
  })
  await hub.setCombos([{ name: 'fast', strategy: 'fallback', chain: ['wb/m1', 'up/m1'] }])

  // 模型开关：禁用后从选择器隐藏，combo 成员仍可用
  stores.settings.update(s => ({ ...s, modelDisabled: { 'up/m1': true } }))
  const listed = await hub.adapter.listModels('credit-hub')
  assert.equal(listed.length, 2, 'disabled hidden from picker (combo + wb)')
  const rows = await hub.catalog(true)
  assert.equal(rows.find(r => r.id === 'combo/fast').combo.length, 2, 'chain members survive disable')

  // 降级链：wb 挂 → 自动换 up；usage 记录接通
  const chunks = []
  const call = await hub.adapter.prepareCall('credit-hub', 'combo/fast')
  for await (const chunk of call.stream({ model: 'combo/fast', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'up-aup-b')
  assert(chunks.some(c => c.type === 'finish' && c.reason.kind === 'stop'))
  assert(turns.includes('turn:up/m1:ok'))

  // 未知模型 fail-fast
  await assert.rejects(() => hub.adapter.resolveModel('credit-hub', 'nope/nope'), /没有模型/)

  stores.dispose()
  await rmDir(dir)
})

// ── workbuddy 装配（无网络） ────────────────────────────────────────────────
await testAsync('workbuddy runtime assembly (no network)', async () => {
  const dir = tmpDir('ch-wb-')
  const stores = createStores(dir)
  const logRing = createRing(10)
  const wb = createWorkbuddyRuntime({ stores, log: row => logRing.push(row), warn: () => {} })
  assert.equal(wb.status().accounts, 0)
  const view = wb.importAccount({ realm: 'cn', accessToken: 'sk-aa-bb-cc-dd-ee-ff-00-11-22', refreshToken: 'rr', uid: 'u-123', nickname: '测试号' })
  assert.equal(view.label, '测试号')
  assert.equal(wb.status().accounts, 1)
  const models = await wb.listModels()
  assert(models.length > 0 && models[0].id.startsWith('wb/cn/'))
  stores.dispose()
  await rmDir(dir)
})

// ── SSE 空闲超时 ───────────────────────────────────────────────────────────
await testAsync('postSse idle timeout rejects fast and cancels stream', async () => {
  const { default: http } = await import('node:http')
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[]}\n\n')
    // 此后静默：不发字节也不关连接，模拟挂死上游
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const started = Date.now()
  await assert.rejects(
    () => postSse(`http://127.0.0.1:${port}/`, { body: {}, idleTimeoutMs: 400, onEvent: () => {} }),
    /空闲/,
  )
  assert(Date.now() - started < 5000, `idle timeout fired in ${Date.now() - started}ms`)
  await new Promise(resolve => server.close(resolve))
})

// ── 链路静默看门狗 ──────────────────────────────────────────────────────────
await testAsync('combo silence watchdog advances past a hung candidate', async () => {
  const dir = tmpDir('ch-sil-')
  const stores = createStores(dir)
  stores.settings.update(s => ({ ...s, chainSilenceMs: 600 }))
  const silent = {
    listModels: async () => [{ id: 'wb/silent', source: 'workbuddy', name: 'Silent', contextWindow: 128000, maxOutput: 8192 }],
    streamTurn: ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ sawFinish: true, finish: 'stop', nextIndex: 0 }), 30_000)
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) })
    }),
    status: () => ({ accounts: 1, ok: 1 }),
  }
  const upstreams = makeSource('up')
  const hub = createHubRuntime({
    stores, workbuddy: silent, upstreams, logger: console, warn: () => {},
    settings: () => stores.settings.load(),
  })
  await hub.setCombos([{ name: 's', strategy: 'fallback', chain: ['wb/silent', 'up/m1'] }])
  const started = Date.now()
  const chunks = []
  const call = await hub.adapter.prepareCall('credit-hub', 'combo/s')
  for await (const chunk of call.stream({ model: 'combo/s', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
  assert(Date.now() - started < 10_000, `advanced in ${Date.now() - started}ms`)
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'up-aup-b')
  assert(chunks.some(c => c.type === 'finish' && c.reason.kind === 'stop'))
  stores.dispose()
  await rmDir(dir)
})

// ── pack 桥接：id 解析 / 目录并入 / llm.stream 转发 ─────────────────────────
test('parsePackModelId shapes', () => {
  assert.deepEqual(parsePackModelId('pk/qoder/glm-5'), { provider: 'qoder', model: 'glm-5' })
  assert.deepEqual(parsePackModelId('pk/raccoon/a/b'), { provider: 'raccoon', model: 'a/b' })
  assert.equal(parsePackModelId('wb/cn/x'), null)
  assert.equal(parsePackModelId('pk/'), null)
  assert.equal(parsePackModelId('pk/p/'), null)
  assert.equal(parsePackModelId(undefined), null)
})

await testAsync('pack bridge lists host providers and forwards llm.stream', async () => {
  const dir = tmpDir('ch-pk-')
  const stores = createStores(dir)
  const seen = []
  const fakeLlm = {
    listProviders: async () => [
      { id: 'credit-hub', name: 'self' },
      { id: 'deepseek', name: 'official' },
      { id: 'qoder', name: 'Qoder' },
    ],
    listModels: async provider => provider === 'qoder'
      ? [{ id: 'glm-5', name: 'GLM 5', context: { contextWindow: 200000 }, defaultMaxTokens: 8192, inputModalities: ['text', 'image'] }]
      : [],
    stream: async function * (generate) {
      seen.push(generate)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'pk-hi' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'pk-hi' } }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const bridge = createPackBridge({ warn: () => {} })
  bridge.setLlm(fakeLlm)
  const models = await bridge.listModels()
  assert.equal(models.length, 1, 'only non-excluded providers bridged')
  assert.equal(models[0].id, 'pk/qoder/glm-5')
  assert.equal(models[0].vision, true)
  assert.equal(models[0].contextWindow, 200000)

  const chunks = []
  const outcome = await bridge.streamTurn({
    modelId: 'pk/qoder/glm-5',
    options: { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], maxTokens: 777 },
    signal: undefined,
    onChunk: chunk => chunks.push(chunk),
  })
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'pk-hi')
  assert.equal(outcome.sawFinish, true)
  assert.equal(outcome.finish, 'stop')
  assert.equal(outcome.usage.outputTokens, 4)
  assert.equal(seen[0].provider, 'qoder')
  assert.equal(seen[0].model, 'glm-5')
  assert.equal(seen[0].system, 'sys', 'system hoisted out of messages')
  assert.equal(seen[0].messages.length, 1, 'system removed from chat messages')
  assert.equal(seen[0].maxTokens, 777)

  // max-tokens kind 归一化成 wire 形
  const bridge2 = createPackBridge({})
  bridge2.setLlm({ ...fakeLlm, stream: async function * () { yield { type: 'finish', reason: { kind: 'max-tokens' } } } })
  const capped = await bridge2.streamTurn({ modelId: 'pk/qoder/glm-5', options: { messages: [] } })
  assert.equal(capped.finish, 'max_tokens')

  // hub 装配：pk 模型进目录并可直接调通
  const workbuddy = makeSource('wb')
  const upstreams = makeSource('up')
  const hub = createHubRuntime({ stores, workbuddy, upstreams, packBridge: bridge, logger: console, warn: () => {} })
  const rows = await hub.catalog(true)
  assert(rows.some(r => r.id === 'pk/qoder/glm-5'))
  const call = await hub.adapter.prepareCall('credit-hub', 'pk/qoder/glm-5')
  const hubChunks = []
  for await (const chunk of call.stream({ model: 'pk/qoder/glm-5', messages: [{ role: 'user', content: 'hi' }] })) hubChunks.push(chunk)
  assert.equal(hubChunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'pk-hi')
  assert(hubChunks.some(c => c.type === 'finish' && c.reason.kind === 'stop'))

  stores.dispose()
  await rmDir(dir)
})

// ── 网关 E2E ────────────────────────────────────────────────────────────────
await testAsync('gateway e2e: openai/anthropic/combo/failover/usage-protocol/custom-key', async () => {
  const dir = tmpDir('ch-e2e-')
  const stores = createStores(dir)
  // 随机高位端口：不与正式网关（默认 8330）冲突，npm test 可与本机共存
  stores.settings.update(s => ({ ...s, gatewayPort: 20000 + Math.floor(Math.random() * 20000) }))
  const workbuddy = makeSource('wb')
  const upstreams = makeSource('up')
  const hub = createHubRuntime({ stores, workbuddy, upstreams, logger: console, warn: () => {} })
  await hub.setCombos([{ name: 'chain1', strategy: 'fallback', chain: ['wb/m1', 'up/m1'] }])
  const gateway = startGateway({ stores, hub, logger: console, settings: () => stores.settings.load() })
  // 端口重试：随机端口理论上仍可能撞占用，撞了就顺移再试（最多 5 次）
  let bind
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { bind = await gateway.start(); break } catch (error) {
      if (error?.code !== 'EADDRINUSE' || attempt === 4) throw error
      stores.settings.update(s => ({ ...s, gatewayPort: (s.gatewayPort ?? 8330) + 517 }))
    }
  }
  const base = `http://${bind}`
  const auth = { authorization: `Bearer ${gateway.key()}`, 'content-type': 'application/json' }

  const models = await (await fetch(`${base}/v1/models`, { headers: auth })).json()
  assert(models.data.some(row => row.id === 'combo/chain1'))
  assert.equal((await fetch(`${base}/v1/models`)).status, 401)

  // OpenAI 非流式 + usage 线上协议字段
  const completion = await (await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: auth, body: JSON.stringify({ model: 'wb/m1', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }),
  })).json()
  assert.equal(completion.choices[0].message.content, 'wb-awb-b')
  assert.equal(completion.usage.prompt_tokens, 5)
  assert.equal(completion.usage.completion_tokens, 2)
  assert.equal(completion.usage.total_tokens, 7)

  // OpenAI 流式
  const sse = await (await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: auth, body: JSON.stringify({ model: 'up/m1', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })).text()
  assert(sse.includes('"content":"up-a"') && sse.includes('finish_reason') && sse.includes('[DONE]'))

  // Anthropic 流式：content_block index 每块递增（不复用）
  const claudeSse = await (await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: auth, body: JSON.stringify({ model: 'wb/m1', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })).text()
  const starts = [...claudeSse.matchAll(/"content_block_start","index":(\d+)/g)].map(m => Number(m[1]))
  assert.equal(starts.length, 1)
  assert.equal(starts[0], 0)
  assert(claudeSse.includes('message_stop'))

  // combo + 故障转移
  const comboOut = await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'combo/chain1', messages: [{ role: 'user', content: 'hi' }] }) })).json()
  assert.equal(comboOut.choices[0].message.content, 'wb-awb-b')
  workbuddy.streamTurn = async () => { throw new Error('wb down') }
  const failover = await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'combo/chain1', messages: [{ role: 'user', content: 'hi' }] }) })).json()
  assert.equal(failover.choices[0].message.content, 'up-aup-b')

  // 部分成功也要带出失败：出错后仍有 error 字段
  upstreams.streamTurn = async ({ onChunk }) => {
    onChunk({ type: 'block-start', index: 0, blockType: 'text' })
    onChunk({ type: 'text-delta', index: 0, text: 'partial' })
    throw new Error('mid-stream death')
  }
  const partial = await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'up/m1', messages: [{ role: 'user', content: 'hi' }] }) })).json()
  assert.equal(partial.choices[0].message.content, 'partial')
  assert.equal(partial.error?.type, 'gateway_error')

  // 自定义 Key：立即生效 + 重启持久化
  const newKey = await gateway.setKey('my-custom-relay-key-2026')
  assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${gateway.key()}` } })).status, 200)
  await gateway.stop()
  const gateway2 = startGateway({ stores, hub, logger: console, settings: () => stores.settings.load() })
  await gateway2.start()
  assert.equal(gateway2.key(), newKey)
  await gateway2.stop()

  stores.dispose()
  await rmDir(dir)
})

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exitCode = failures === 0 ? 0 : 1
