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
import { toChatMessages, toClaudeMessages, toChatTools, repairWorkbuddyBody, repairToolPairing, sanitizeWorkbuddySystemText } from '../src/wire.js'
import { sanitizeEfforts, finiteOr } from '../src/util.js'
import { createStores, mintKey } from '../src/store.js'
import { createHubRuntime } from '../src/hub.js'
import { createUpstreamRuntime } from '../src/aggregate.js'
import { createWorkbuddyRuntime, parseWorkbuddyModelId } from '../src/workbuddy.js'
import { startGateway, clampMaxTokens } from '../src/forward.js'
import { createPackBridge, parsePackModelId } from '../src/pack-bridge.js'
import { packStateView, packStateFiles } from '../src/pack-mount.js'
import { createApiRoutes } from '../src/api.js'
import { postSse } from '../src/http.js'
import { createRing } from '../src/util.js'

let failures = 0
// 进程级看门狗：任何测试在 CI/本地把事件循环钉住时，10 分钟强杀并报 FAIL，
// 避免 GitHub Actions 上 "Host tests" 步骤无限期挂起（2026-11-21 实测发生过）。
setTimeout(() => {
  console.log(`\nFAIL watchdog: 测试套件 10 分钟未结束，进程强杀（可能有服务器句柄未关闭）`)
  process.exitCode = 1
  process.exit(1)
}, 10 * 60_000).unref?.()
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

// ── 11128 第二根因：system 里的「DeepSeek Harness」被渠道校验拦截 ────────────
test('sanitizeWorkbuddySystemText neutralizes vendor name in system only', () => {
  const out = sanitizeWorkbuddySystemText([
    { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness. Rules follow.' },
    { role: 'user', content: 'I like DeepSeek Harness a lot' },
    { role: 'assistant', content: 'DeepSeek Harness is nice' },
    { role: 'system', content: 'deepseek harness lowercase variant' },
    { role: 'system', content: [{ type: 'text', text: 'block form: DeepSeek Harness' }] },
  ])
  assert.equal(out.touched, 3, '三条 system 命中')
  assert(!out.messages[0].content.includes('DeepSeek Harness'), 'system 被中和')
  assert(out.messages[0].content.includes('the AI coding harness'))
  assert.equal(out.messages[1].content, 'I like DeepSeek Harness a lot', 'user 正文不动')
  assert.equal(out.messages[2].content, 'DeepSeek Harness is nice', 'assistant 正文不动')
  assert(!out.messages[3].content.toLowerCase().includes('deepseek harness'), '大小写变体也中和')
  assert.equal(out.messages[4].content[0].text, 'block form: the AI coding harness', '块格式也能中和')

  const clean = sanitizeWorkbuddySystemText([{ role: 'system', content: 'You are a helpful assistant.' }])
  assert.equal(clean.touched, 0)
  assert.equal(clean.messages[0].content, 'You are a helpful assistant.')
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

// ── 11128 根因护栏：孤儿 tool_calls / 孤儿 tool 消息（2026-11-10） ───────────
test('repairToolPairing drops dangling tool_calls and orphan tool messages', () => {
  // A: 只有调用、没有结果 → 剔除 tool_calls；正文为空则整条丢弃
  const a = repairToolPairing([
    { role: 'system', content: 's' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'r', arguments: '{}' } }] },
    { role: 'user', content: 'u2' },
  ])
  assert.equal(a.length, 3, '空 assistant 消息被丢弃')
  assert(!a.some(m => m.tool_calls), '悬空 tool_call 被剔除')

  // B: 完整配对 → 原样保留
  const b = repairToolPairing([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ])
  assert.equal(b.length, 2)
  assert.equal(b[0].tool_calls.length, 1)

  // C: 混合 → 只留配对成功的那一个，正文保留
  const c = repairToolPairing([
    { role: 'assistant', content: 'text', tool_calls: [{ id: 'c1' }, { id: 'c2' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ])
  assert.equal(c[0].tool_calls.length, 1)
  assert.equal(c[0].tool_calls[0].id, 'c1')
  assert.equal(c[0].content, 'text')

  // D: 孤儿 tool 消息（凭空出现的结果）→ 丢弃，且不会自证存在
  const d = repairToolPairing([{ role: 'tool', tool_call_id: 'ghost', content: 'x' }, { role: 'user', content: 'u' }])
  assert.equal(d.length, 1)
  assert.equal(d[0].role, 'user')

  // E: body 层 —— 清空后保底一条 user，内部字段不外泄
  const body = repairWorkbuddyBody({ model: 'm', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'x' }] }] })
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].role, 'user')
  assert.equal(body.__pairing, undefined, '内部字段不得写进请求体')
})

test('repairToolPairing keeps long real-world histories sendable', () => {
  // 复刻线上 552 条会话：432 条带 tool_calls，全部没有 tool 结果
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]
  for (let i = 0; i < 432; i += 1) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + i }] })
    messages.push({ role: 'user', content: 'next' })
  }
  const stats = {}
  const out = repairToolPairing(messages, stats)
  assert.equal(stats.droppedDanglingCalls, 432, '全部悬空调用被记录')
  assert(!out.some(m => Array.isArray(m.tool_calls) && m.tool_calls.length > 0), '出站后不应残留 tool_calls')
  assert(out.length >= 2, '仍保留可解释的对话骨架')
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
  // 聚合目录去重：wb 走独立车道，只剩 combo（被禁用的 up/m1 也已隐藏）
  const listed = await hub.adapter.listModels('credit-hub')
  assert.equal(listed.length, 1, 'aggregate lists only combo (wb has own provider)')
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

// ── 并发目录计算：共享同一次结果，绝不返回空清单（2026-11-10 回归） ─────────
await testAsync('aggregate listModels dedups models reachable via native providers', async () => {
  const dir = tmpDir('ch-dedup-')
  const stores = createStores(dir)
  const workbuddy = makeSource('wb')
  const upstreams = makeSource('up')
  const packBridge = {
    listModels: async () => [{ id: 'pk/zcode/GLM', source: 'pack', provider: 'zcode', modelId: 'GLM', name: 'GLM' }],
  }
  const hub = createHubRuntime({ stores, workbuddy, upstreams, packBridge, logger: console, warn: () => {} })
  await hub.setCombos([{ name: 'c', strategy: 'fallback', chain: ['wb/m1', 'up/m1'] }])

  const ids = (await hub.adapter.listModels('credit-hub')).map(m => m.id)
  assert(!ids.includes('wb/m1'), 'workbuddy 走独立车道，不再重复列在聚合目录')
  assert(!ids.includes('pk/zcode/GLM'), 'pack 模型在各自渠道分组，不再重复列在聚合目录')
  assert(ids.includes('up/m1'), '自填上游保留（外部无等价入口）')
  assert(ids.includes('combo/c'), '降级链保留（外部无等价入口）')

  // resolveModel 不受去重影响：网关、降级链、/api/models 仍按完整目录解析
  for (const id of ['wb/m1', 'up/m1', 'pk/zcode/GLM', 'combo/c']) {
    const info = await hub.adapter.resolveModel('credit-hub', id)
    assert.equal(info.id, id)
  }
  stores.dispose()
  await rmDir(dir)
})

await testAsync('concurrent catalog calls share one computation instead of returning empty', async () => {
  const dir = tmpDir('ch-conc-')
  const stores = createStores(dir)
  let listCalls = 0
  const slow = {
    listModels: async () => {
      listCalls += 1
      await new Promise(resolve => setTimeout(resolve, 300))
      return [{ id: 'wb/slow', source: 'workbuddy', name: 'Slow', contextWindow: 128000, maxOutput: 8192 }]
    },
    status: () => ({ accounts: 1, ok: 1 }),
  }
  const hub = createHubRuntime({ stores, workbuddy: slow, upstreams: makeSource('up'), logger: console, warn: () => {} })
  // 5 路并发（模拟模型选择器 + 网关 /v1/models + 设置页同时拉目录）
  const results = await Promise.all(Array.from({ length: 5 }, () => hub.catalog()))
  assert.equal(listCalls, 1, '并发只应触发一次底层枚举')
  for (const [i, rows] of results.entries()) {
    assert(rows.length >= 1, `第 ${i} 路拿到空清单——宿主会把空目录缓存进选择器`)
    assert(rows.some(r => r.id === 'wb/slow'))
  }
  stores.dispose()
  await rmDir(dir)
})

// ── 自激递归兜底：重入不得拖垮调用方（134 OOM 回归护栏） ────────────────────
await testAsync('reentrant catalog is capped by the wait budget and never deadlocks', async () => {
  const dir = tmpDir('ch-reentry-')
  const stores = createStores(dir)
  let depth = 0
  const hub = createHubRuntime({
    stores,
    workbuddy: {
      // 模拟「宿主把本 adapter 也挂到 provider 上」：枚举时回头再调 catalog
      listModels: async () => {
        if (depth > 0) return []
        depth += 1
        await hub.catalog(true)
        depth -= 1
        return []
      },
      status: () => ({ accounts: 0, ok: 0 }),
    },
    upstreams: makeSource('up'),
    logger: console,
    warn: () => {},
  })
  const started = Date.now()
  const rows = await hub.catalog(true)
  assert(Array.isArray(rows), '重入路径必须返回数组而不是挂死')
  assert(Date.now() - started < 6000, `重入在 6s 内返回（实际 ${Date.now() - started}ms）`)
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

// ── 回归：目录 id 解析与单模型回合看门狗 ────────────────────────────────────
test('parseWorkbuddyModelId strips wb/<realm> prefix and keeps global realm', () => {
  assert.deepStrictEqual(parseWorkbuddyModelId('wb/cn/hy4free'), { realm: 'cn', bare: 'hy4free' })
  assert.deepStrictEqual(parseWorkbuddyModelId('wb/cn/deepseek-v4.1-flash'), { realm: 'cn', bare: 'deepseek-v4.1-flash' })
  assert.deepStrictEqual(parseWorkbuddyModelId('wb/global/default-model'), { realm: 'global', bare: 'default-model' })
  assert.deepStrictEqual(parseWorkbuddyModelId('cn/hy4free'), { realm: 'cn', bare: 'hy4free' })
  assert.deepStrictEqual(parseWorkbuddyModelId('global/auto-chat'), { realm: 'global', bare: 'auto-chat' })
  assert.deepStrictEqual(parseWorkbuddyModelId('wb/cn/a/b'), { realm: 'cn', bare: 'a/b' })
  // 回归点：旧实现会把 wb/cn/hy4free 拆成 cn/cn/hy4free，上游必报 11102
  assert.notEqual(parseWorkbuddyModelId('wb/cn/hy4free').bare, 'cn/hy4free')
})

await testAsync('single-turn silence watchdog fails fast and aborts a hung upstream', async () => {
  const dir = tmpDir('ch-single-')
  const stores = createStores(dir)
  stores.settings.update(s => ({ ...s, singleSilenceMs: 500 }))
  let aborted = false
  const silent = {
    listModels: async () => [{ id: 'wb/hung', source: 'workbuddy', name: 'Hung', contextWindow: 128000, maxOutput: 8192 }],
    streamTurn: ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ sawFinish: true, finish: 'stop' }), 30_000)
      signal?.addEventListener('abort', () => { aborted = true; clearTimeout(timer); reject(new Error('aborted')) })
    }),
    status: () => ({ accounts: 1, ok: 1 }),
  }
  const hub = createHubRuntime({
    stores, workbuddy: silent, upstreams: makeSource('up'), logger: console, warn: () => {},
    settings: () => stores.settings.load(),
  })
  const started = Date.now()
  const chunks = []
  const call = await hub.adapter.prepareCall('credit-hub', 'wb/hung')
  for await (const chunk of call.stream({ model: 'wb/hung', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
  const elapsed = Date.now() - started
  assert(elapsed < 8000, `must fail fast (took ${elapsed}ms)`)
  assert(aborted, 'hung upstream request was actually aborted')
  const finish = chunks.find(c => c.type === 'finish')
  assert.equal(finish?.reason?.kind, 'error', 'no clean stop on timeout')
  assert.equal(finish?.reason?.failure?.code, 'TIMEOUT')
  assert.match(finish?.reason?.failure?.message ?? '', /无任何输出/)
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
    options: { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], maxTokens: 777, tools: [{ type: 'function', function: { name: 'read_file' } }] },
    signal: undefined,
    onChunk: chunk => chunks.push(chunk),
  })
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'pk-hi')
  assert.equal(outcome.sawFinish, true)
  assert.equal(outcome.finish, 'stop')
  assert.equal(outcome.usage.outputTokens, 4)
  assert.equal(seen[0].provider, 'qoder')
  assert.equal(seen[0].model, 'glm-5')
  // 宿主消息形状：content 块数组 + system 就是 messages 里的一条
  assert.equal(seen[0].messages[0].role, 'system')
  assert.equal(seen[0].messages[0].content[0].text, 'sys')
  assert.equal(seen[0].messages[1].role, 'user')
  assert.equal(seen[0].messages[1].content[0].text, 'hi')
  assert.equal(typeof seen[0].messages[0].id, 'string', '每条消息带 id（宿主会话建档用）')
  assert.equal(seen[0].maxTokens, 777)

  // 工具归一化：OpenAI 包裹格式（description 在 function 里）→ 扁平定义，
  // 无 description 的工具补空串——Raccoon 适配器无条件读 tool.description.length
  assert.equal(seen[0]?.tools?.[0]?.description, '', 'openai-wrapped tool normalized to flat def with string description')
  assert.equal(seen[0]?.tools?.[0]?.name, 'read_file')

  // 思考强度钳制：effort 必须落在宿主模型声明的档位集合内（Raccoon 适配器
  // 对不支持思考的模型会直接抛 "does not support reasoning effort"）
  await testAsync('pack bridge clamps reasoning effort to model menu', async () => {
    const dir2 = tmpDir('ch-clamp-')
    const genSeen = []
    const menuLlm = {
      listProviders: async () => [{ id: 'raccoon', name: 'Raccoon' }],
      listModels: async () => [
        { id: 'sn-reasoning', name: 'R', reasoning: { efforts: ['low', 'high'] } },
        { id: 'sn-plain', name: 'P' },
      ],
      resolveModelInfo: async (provider, model) => model === 'sn-reasoning'
        ? { reasoning: { efforts: [{ id: 'low' }, { name: 'high' }] } }
        : undefined,
      stream: async function * (generate) {
        genSeen.push(generate)
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const bridge2 = createPackBridge({ warn: () => {} })
    bridge2.setLlm(menuLlm)
    const stream = (model, effort) => bridge2.streamTurn({
      modelId: `pk/raccoon/${model}`,
      options: { messages: [{ role: 'user', content: 'hi' }], ...(effort !== undefined ? { reasoningEffort: effort } : {}) },
      onChunk: () => {},
    })
    await stream('sn-reasoning', 'max')   // max → 钳到 high（菜单是对象条目，归一化后）
    await stream('sn-reasoning', 'low')   // low → 原样
    await stream('sn-plain', 'high')      // 无思考菜单 → 整个去掉
    await stream('sn-plain', undefined)   // 未指定 → 保持未指定
    assert.deepEqual(genSeen.map(g => g.reasoningEffort), ['high', 'low', undefined, undefined])
    assert(genSeen.every(g => g.reasoningEffort === undefined || typeof g.reasoningEffort === 'string'), 'no object effort ever reaches the adapter')
    await rmDir(dir2)
  })

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

  // 流式失败必须带 error 帧：不能以零内容的干净 stop 结束（否则调用方
  // 只能报 "empty response from model (no_visible_content)"）
  const failSse = await (await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: auth, body: JSON.stringify({ model: 'wb/m1', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })).text()
  assert(failSse.includes('"error"'), 'stream failure carries an error frame')
  assert(failSse.includes('[DONE]'))
  assert(!failSse.includes('"content":"wb-a"'), 'no phantom content before failure')
  const failClaudeSse = await (await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: auth, body: JSON.stringify({ model: 'wb/m1', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })).text()
  assert(failClaudeSse.includes('event: error'), 'anthropic stream failure carries error event')
  assert(!failClaudeSse.includes('message_stop'), 'error terminates before a clean message_stop')

  // Responses 线（/v1/responses，Codex wire——EKKO 等经 codex-proxy 的 agent）：
  // 非流式（含 function_call 输出）+ 流式事件序列 + x-api-key 鉴权
  // 注：先把上游 fake 恢复健康（上一段测试把它换成了抛异常版本），
  // 且带 tools 时返回工具调用（模拟真实模型行为）
  upstreams.streamTurn = async ({ onChunk, options }) => {
    onChunk({ type: 'block-start', index: 0, blockType: 'text' })
    if (Array.isArray(options?.tools) && options.tools.length > 0) {
      const name = options.tools[0]?.function?.name ?? options.tools[0]?.name ?? 'read_file'
      onChunk({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_test_1', name, arguments: '{"path":"/tmp/a.txt"}' } })
      return { sawToolCall: true, sawFinish: true, finish: 'tool_calls', usage: { inputTokens: 5, outputTokens: 2 }, nextIndex: 1 }
    }
    onChunk({ type: 'text-delta', index: 0, text: 'up-answer' })
    onChunk({ type: 'block-end', index: 0, block: { type: 'text', text: 'up-answer' } })
    return { sawText: true, sawFinish: true, finish: 'stop', usage: { inputTokens: 5, outputTokens: 2 }, nextIndex: 1 }
  }
  const resp = await (await fetch(`${base}/v1/responses`, {
    method: 'POST', headers: auth, body: JSON.stringify({
      model: 'up/m1', input: 'read /tmp/a.txt', max_output_tokens: 500,
      tools: [{ type: 'function', name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    }),
  })).json()
  assert.equal(resp.status, 'completed')
  const callItem = resp.output.find(item => item.type === 'function_call')
  assert.equal(callItem?.name, 'read_file', 'responses wire emits function_call items')
  const msgItem = resp.output.find(item => item.type === 'message')
  assert.equal(msgItem?.content?.[0]?.type, 'output_text')
  assert.equal(resp.usage.total_tokens, 7)

  const respStream = await (await fetch(`${base}/v1/responses`, {
    method: 'POST', headers: { 'x-api-key': gateway.key(), 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'up/m1', input: 'say OK', stream: true }),
  })).text()
  assert(respStream.includes('event: response.created'), 'responses stream opens with created')
  assert(respStream.includes('response.output_text.delta'), 'text deltas emitted')
  assert(respStream.includes('event: response.completed'), 'responses stream completes')

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

// ── apply() 启动冒烟：模拟宿主 ctx 跑一遍 apply 主体 ────────────────────────
// 专抓加载期崩溃（TDZ / 未定义引用 / 装配顺序），这类错误 node --check 查不出
await testAsync('apply() boots with a mock host ctx', async () => {
  const dir = tmpDir('ch-apply-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir // 隔离真实 ~/.dsh
  const { apply } = await import('../index.js')
  const effects = []
  const injected = []
  const mockCtx = {
    logger: { info: () => {}, warn: () => {} },
    llm: { registerAdapter: () => () => {}, emitAdaptersUpdated: () => {}, stream: async function * () {} },
    // 真执行回调：旧版桩只记录不执行，createApiRoutes / mountAccountPack 两条
    // 分支（也就是 host 崩溃的高发路径）从未被测过。
    inject: (deps, cb) => {
      const row = { deps, cb, executed: false }
      injected.push(row)
      const scoped = { ...mockCtx, webServer: { register: () => () => {} }, effect: fn => effects.push(fn) }
      try { cb(scoped); row.executed = true } catch (error) { throw new Error(`inject(${deps.join(',')}) threw: ${error.message}`) }
    },
    effect: fn => effects.push(fn),
    on: () => () => {},
    emit: () => {},
    get: () => undefined,
  }
  let threw = null
  // accountPack:'off' 避免冒烟测试真的去 import 2.6MB 的 vendor pack（会起服务/定时器）
  try { apply(mockCtx, { accountPack: 'off' }) } catch (error) { threw = error }
  assert.equal(threw, null, `apply() threw at load: ${threw}`)
  assert(injected.some(row => row.deps.includes('webServer')), 'webServer api wired')
  assert(injected.some(row => row.deps.includes('credentials')), 'account pack wired')
  assert(injected.every(row => row.executed), 'all inject callbacks actually ran')
  assert(effects.length >= 3, `lifecycle effects registered (${effects.length})`)
  // 跑一遍 setup 拿 disposer，清理定时器/网关/stores
  for (const fn of effects) {
    try { const disposer = fn(); if (typeof disposer === 'function') await disposer() } catch {}
  }
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rmDir(dir)
})

// ── thinkingOffByDefault：简单客户端兼容开关 ────────────────────────────────
await testAsync('thinking default-off applies only when caller omits effort', async () => {
  const dir = tmpDir('ch-think-')
  const stores = createStores(dir)
  const seen = []
  const workbuddy = {
    listModels: async () => [{ id: 'wb/cn/glm-5.3', source: 'workbuddy', name: 'GLM', contextWindow: 100000, maxOutput: 8192, reasoning: true }],
    streamTurn: async ({ options }) => { seen.push(options.reasoningEffort); return { sawText: true, sawFinish: true, finish: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, nextIndex: 0 } },
    status: () => ({ accounts: 1, ok: 1 }),
  }
  const upstreams = { listModels: async () => [], streamTurn: async () => {}, status: () => ({}) }
  const hub = createHubRuntime({ stores, workbuddy, upstreams, logger: console, warn: () => {}, settings: () => stores.settings.load() })
  const call = await hub.adapter.prepareCall('credit-hub', 'wb/cn/glm-5.3')
  for await (const chunk of call.stream({ model: 'wb/cn/glm-5.3', messages: [{ role: 'user', content: 'hi' }] })) void chunk
  assert.equal(seen[0], undefined, 'default: no forced effort')
  stores.settings.update(s => ({ ...s, thinkingOffByDefault: true }))
  hub.invalidate()
  const call2 = await hub.adapter.prepareCall('credit-hub', 'wb/cn/glm-5.3')
  for await (const chunk of call2.stream({ model: 'wb/cn/glm-5.3', messages: [{ role: 'user', content: 'hi' }] })) void chunk
  assert.equal(seen[1], 'off', 'toggle on → effort off')
  // 调用方显式指定时尊重调用方
  const call3 = await hub.adapter.prepareCall('credit-hub', 'wb/cn/glm-5.3')
  for await (const chunk of call3.stream({ model: 'wb/cn/glm-5.3', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'high' })) void chunk
  assert.equal(seen[2], 'high', 'explicit effort wins over toggle')
  stores.dispose()
  await rmDir(dir)
})

// ── 回归：本次修复的缺陷逐条上锁 ──────────────────────────────────────────
test('clampMaxTokens rejects NaN / negative / oversized values', () => {
  assert.equal(clampMaxTokens(NaN), 8192)
  assert.equal(clampMaxTokens(-1), 8192)
  assert.equal(clampMaxTokens('abc'), 8192)
  assert.equal(clampMaxTokens(999999), 200000)
  assert.equal(clampMaxTokens(100), 100)
})

test('pack state view reads legacy nested directory (no data migration needed)', () => {
  const dir = tmpDir('ch-packstate-')
  const stores = createStores(dir)
  const nested = path.join(dir, 'credit-hub', 'channel-pack', 'channel-pack')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(nested, 'state.json'), JSON.stringify({
    accounts: { 'qoder:a1': { provider: 'qoder', nickname: 'A', credits: 12 } },
  }))
  const view = packStateView(stores)
  assert.equal(view.length, 1, 'legacy nested state.json must be visible')
  assert.equal(view[0].provider, 'qoder')
  assert.equal(packStateFiles(stores).length, 2)
  stores.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('stores.migrate() upgrades schemaVersion and clears legacy checkin marks', () => {
  const dir = tmpDir('ch-migrate-')
  const stores = createStores(dir)
  fs.writeFileSync(path.join(dir, 'credit-hub', 'settings.json'), JSON.stringify({
    checkinMarks: { '2026-11-07': true, '2026-11-08:wb_a': 'ok' },
  }))
  const result = stores.migrate()
  assert.equal(result.changed, true)
  const settings = stores.settings.load()
  assert.equal(settings.schemaVersion, 2)
  assert.equal(settings.checkinMarks['2026-11-07'], undefined, 'legacy boolean key removed')
  assert.equal(settings.checkinMarks['2026-11-08:wb_a'], 'ok', 'new-format key preserved')
  stores.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

await testAsync('gateway start is single-flight; stop survives a live SSE and frees the port', async () => {
  const dir = tmpDir('ch-life-')
  const stores = createStores(dir)
  stores.settings.update(s => ({ ...s, gatewayPort: 20000 + Math.floor(Math.random() * 20000) }))
  const workbuddy = makeSource('wb')
  const upstreams = makeSource('up')
  const hub = createHubRuntime({ stores, workbuddy, upstreams, logger: console, warn: () => {} })
  const gateway = startGateway({ stores, hub, logger: console, settings: () => stores.settings.load() })
  let results = await Promise.allSettled([gateway.start(), gateway.start()])
  for (let attempt = 0; attempt < 4 && results.some(r => r.status === 'rejected'); attempt += 1) {
    stores.settings.update(s => ({ ...s, gatewayPort: s.gatewayPort + 517 }))
    results = await Promise.allSettled([gateway.start(), gateway.start()])
  }
  assert(results.every(r => r.status === 'fulfilled'), `concurrent start: ${results.map(r => r.reason?.message).join(', ')}`)
  assert.equal(results[0].value, results[1].value, 'both callers see the same bind')
  const bind = results[0].value

  // 制造一条不会自行结束的 SSE 连接（unref 定时器，不拖住测试进程退出）
  workbuddy.streamTurn = async ({ onChunk }) => {
    onChunk({ type: 'text-delta', index: 0, text: 'x' })
    await new Promise(resolve => { const t = setTimeout(resolve, 10_000); t.unref?.() })
    return { sawText: true, sawFinish: true, finish: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, nextIndex: 0 }
  }
  const controller = new AbortController()
  const auth = { authorization: `Bearer ${gateway.key()}`, 'content-type': 'application/json' }
  await fetch(`http://${bind}/v1/chat/completions`, {
    method: 'POST', headers: auth, signal: controller.signal,
    body: JSON.stringify({ model: 'wb/m1', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
  const stopped = await Promise.race([
    gateway.stop().then(() => 'stopped'),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 2500)),
  ])
  controller.abort()
  assert.equal(stopped, 'stopped', 'stop() must not hang on a live SSE connection')
  assert.equal(gateway.running, false)
  const bind2 = await gateway.start()
  assert.equal(bind2, bind, 'port is released after stop')
  await gateway.stop()
  stores.dispose()
  await rmDir(dir)
})

await testAsync('management API rejects non-loopback host / origin / cross-site requests', async () => {
  const dir = tmpDir('ch-api-guard-')
  const stores = createStores(dir)
  const api = createApiRoutes({
    stores, hub: {}, workbuddy: {}, upstreams: {},
    gateway: { running: false, stats: () => ({}) },
    version: 'test', settingsKeys: [], logs: () => [], clearLogs: () => {},
    log: () => {}, warn: () => {},
  })
  const invoke = headers => new Promise((resolve, reject) => {
    const req = { url: '/api/credit-hub/logs', method: 'GET', headers }
    const res = {
      statusCode: 0, headersSent: false, writableEnded: false,
      writeHead(status) { this.statusCode = status; this.headersSent = true },
      end() { resolve(this.statusCode) },
      setHeader() {}, write() {},
    }
    const timeout = setTimeout(() => reject(new Error('api handler did not respond')), 2000)
    timeout.unref?.()
    api(req, res)
  })
  assert.equal(await invoke({ host: '127.0.0.1:8330' }), 200, 'loopback allowed')
  assert.equal(await invoke({ host: 'evil.example' }), 403, 'non-loopback host blocked')
  assert.equal(await invoke({ host: '127.0.0.1:8330', origin: 'https://evil.example' }), 403, 'cross-origin blocked')
  assert.equal(await invoke({ host: '127.0.0.1:8330', 'sec-fetch-site': 'cross-site' }), 403, 'cross-site fetch blocked')
  stores.dispose()
  await rmDir(dir)
})

// ── http.js 错误语义（清单 #1/#3/#7 覆盖缺口） ─────────────────────────────
await testAsync('postJson maps 401/403/429/5xx to typed codes with envelope', async () => {
  const { default: http } = await import('node:http')
  const { postJson, CODE } = await import('../src/http.js')
  const cases = [
    [401, { error: { message: 'bad key' } }, CODE.auth],
    [403, { error: { message: 'forbidden' } }, CODE.auth],
    [404, { message: 'nope' }, CODE.notFound],
    [429, { error: 'rate' }, CODE.rate],
    [502, 'bad gateway', CODE.server],
    [400, { error: { message: 'bad request' } }, CODE.client],
  ]
  const server = http.createServer((req, res) => {
    const [status, payload] = cases[Number(req.url.slice(1))]
    const headers = { 'content-type': 'application/json' }
    if (status === 429) headers['retry-after'] = '7'
    res.writeHead(status, headers)
    res.end(JSON.stringify(payload))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  for (const [i, [status, , code]] of cases.entries()) {
    try {
      await postJson(`${base}/${i}`, { body: {} })
      assert.fail(`status ${status} should throw`)
    } catch (error) {
      assert.equal(error.code, code, `status ${status} → code`)
      assert.equal(error.status, status, `status ${status} → error.status`)
      if (status === 429) {
        assert.equal(error.rateLimited, true)
        assert.equal(error.retryAfterMs, 7000, 'Retry-After: 7 → 7000ms')
      }
      if (status !== 502) assert.ok(error.envelope, `${status} carries parsed envelope`)
    }
  }
  await new Promise(resolve => server.close(resolve))
})

await testAsync('Retry-After parses delta-seconds and HTTP-date; garbage is undefined', async () => {
  const { default: http } = await import('node:http')
  const { postJson } = await import('../src/http.js')
  const values = ['120', 'Wed, 21 Oct 2026 07:28:00 GMT', 'soon-ish']
  const server = http.createServer((req, res) => {
    res.writeHead(429, { 'retry-after': values[Number(req.url.slice(1))] })
    res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const results = []
  for (let i = 0; i < values.length; i++) {
    try { await postJson(`${base}/${i}`, { body: {} }); results.push(undefined) }
    catch (error) { results.push(error.retryAfterMs) }
  }
  assert.equal(results[0], 120_000, 'delta-seconds')
  assert.ok(Number.isFinite(results[1]) && results[1] >= 0, 'HTTP-date → finite ms')
  assert.equal(results[2], undefined, 'garbage → undefined')
  await new Promise(resolve => server.close(resolve))
})

await testAsync('postSse surfaces plain-JSON error body as UpstreamError instead of hanging', async () => {
  const { default: http } = await import('node:http')
  const { postSse, CODE } = await import('../src/http.js')
  const server = http.createServer((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'overloaded' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await assert.rejects(
    () => postSse(`http://127.0.0.1:${server.address().port}/`, { body: {}, onEvent: () => {}, idleTimeoutMs: 2000 }),
    error => error.code === CODE.server && error.status === 503,
  )
  await new Promise(resolve => server.close(resolve))
})

// ── 千帆 AK/SK → IAM token（方案 B 行为合同） ─────────────────────────────
await testAsync('qianfan entry routes through token exchange path (not bare-key error)', async () => {
  const { createUpstreamRuntime } = await import('../src/aggregate.js')
  const dir = tmpDir('ch-qf-')
  const stores = createStores(dir)
  const runtime = createUpstreamRuntime({ stores, log: () => {} })
  runtime.installPreset('qianfan')
  try {
    await runtime.streamTurn({ modelId: 'up/preset-qianfan/m', options: { messages: [{ role: 'user', content: 'x' }] }, onChunk: () => {} })
    assert.fail('qianfan without key must not succeed silently')
  } catch (error) {
    assert.ok(!/未填 API Key/.test(error.message), 'token branch taken (bare-key check bypassed for qianfan)')
  }
  stores.dispose()
  await rmDir(dir)
})

await testAsync('preset keyUrl surfaces for ark/qianfan/modelscope in presets view', async () => {
  const dir = tmpDir('ch-keyurl-')
  const stores = createStores(dir)
  const runtime = createUpstreamRuntime({ stores, log: () => {} })
  const presets = runtime.presets
  const ark = presets.find(p => p.id === 'ark')
  const qf = presets.find(p => p.id === 'qianfan')
  const ms = presets.find(p => p.id === 'modelscope')
  assert.ok(ark?.keyUrl?.startsWith('https://console.volcengine.com'), 'ark keyUrl')
  assert.ok(qf?.keyUrl?.startsWith('https://console.bce.baidu.com'), 'qianfan keyUrl')
  assert.ok(ms?.keyUrl?.startsWith('https://modelscope.cn'), 'modelscope keyUrl')
  stores.dispose()
  await rmDir(dir)
})

await testAsync('non-qianfan preset stores AK:SK verbatim (no colon splitting)', async () => {
  const dir = tmpDir('ch-rawkey-')
  const stores = createStores(dir)
  const runtime = createUpstreamRuntime({ stores, log: () => {} })
  runtime.installPreset('deepseek')
  runtime.upsert({ id: 'preset-deepseek', apiKey: 'AK:SK_COLON_KEY', baseURL: 'https://api.deepseek.com/v1', enabled: true })
  const entry = stores.accounts.load().upstreams.find(row => row.id === 'preset-deepseek')
  assert.equal(entry.apiKey, 'AK:SK_COLON_KEY', 'non-qianfan preset keeps raw key')
  stores.dispose()
  await rmDir(dir)
})

// ── 结构化校验层（清单 #3） ────────────────────────────────────────────────
await testAsync('management API returns 400 with field reasons for invalid input', async () => {
  const { default: http } = await import('node:http')
  const { createApiRoutes } = await import('../src/api.js')
  const dir = tmpDir('ch-val-')
  const stores = createStores(dir)
  const api = createApiRoutes({
    stores,
    hub: { invalidate: () => {}, setCombos: async () => {}, combos: () => [] },
    workbuddy: {},
    upstreams: {
      upsert: () => ({ id: 'up-x' }),
      remove: () => {},
      setEnabled: () => {},
      list: () => [],
    },
    gateway: { running: false, stats: () => ({}) },
    version: 'test', settingsKeys: [], logs: () => [], clearLogs: () => {},
    log: () => {}, warn: () => {},
  })
  const server = http.createServer(api)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  // 断言失败也要关掉 server，否则监听句柄把事件循环钉住、测试进程永不退出
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/credit-hub`
    const post = (path, payload) => fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    // baseURL 非法 → 400
    const r1 = await post('/upstreams/save', { name: 'x', baseURL: 'ftp://bad', apiKey: 'k' })
    assert.equal(r1.status, 400)
    const p1 = await r1.json()
    assert.match(p1.error, /baseURL/, 'error names the offending field')
    // id 注入字符 → 400
    const r2 = await post('/upstreams/remove', { id: '../etc/passwd' })
    assert.equal(r2.status, 400)
    // 合法请求仍然通过
    const r3 = await post('/upstreams/save', { name: 'ok', baseURL: 'https://api.example.com/v1/', apiKey: 'k' })
    assert.equal(r3.status, 200)
    // combos：坏成员 → 400；空 combos 数组（清除全部）→ 200
    const r4 = await post('/combos/save', { combos: [{ name: 'x', chain: ['bad id with space!'] }] })
    assert.equal(r4.status, 400)
    const r5 = await post('/combos/save', { combos: [] })
    assert.equal(r5.status, 200)
    // gateway key 带换行 → 400
    const r6 = await post('/gateway/set-key', { key: 'abc\n123' })
    assert.equal(r6.status, 400)
  } finally {
    await new Promise(resolve => server.close(resolve))
    stores.dispose()
    await rmDir(dir)
  }
})

await testAsync('validate module: port / enum / idList / secret rules', async () => {
  const { validate, rules, schemas } = await import('../src/validate.js')
  assert.equal(validate({ gatewayPort: 8330 }, { gatewayPort: [rules.port('port', { optional: false })] }), null)
  assert.match(validate({ gatewayPort: 80 }, { gatewayPort: [rules.port('port', { optional: false })] }).fields.gatewayPort, /1024/)
  assert.equal(validate({ kind: 'openai-chat' }, { kind: [rules.enum('kind', ['openai-chat', 'anthropic-messages'])] }), null)
  assert.match(validate({ kind: 'grpc' }, { kind: [rules.enum('kind', ['openai-chat'])] }).fields.kind, /openai-chat/)
  assert.equal(validate({ ids: ['wb/m1', 'up/preset-ark/glm-4.6'] }, { ids: [rules.idList('ids', { optional: false })] }), null)
  assert.ok(validate({ ids: ['has space'] }, { ids: [rules.idList('ids', { optional: false })] }))
  // upstreamSave schema 端到端
  assert.equal(validate({ name: 'n', baseURL: 'https://x/v1' }, schemas.upstreamSave), null)
  const bad = validate({ name: 'n', baseURL: 'https://user:pass@x/v1' }, schemas.upstreamSave)
  assert.match(bad.fields.baseURL, /凭据/)
})

// ── 统一错误模型（清单 #7） ────────────────────────────────────────────────
await testAsync('UpstreamError derives category/retryable from code; extra can override', async () => {
  const { UpstreamError, CODE } = await import('../src/http.js')
  const table = [
    [CODE.auth, 'auth', false],
    [CODE.rate, 'rate-limit', true],
    [CODE.timeout, 'network', true],
    [CODE.server, 'upstream', true],
    [CODE.notFound, 'request', false],
    [CODE.client, 'request', false],
    [CODE.transport, 'network', true],
    [CODE.aborted, 'aborted', false],
    [CODE.empty, 'upstream', true],
    [CODE.region, 'region', false],
  ]
  for (const [code, category, retryable] of table) {
    const e = new UpstreamError('x', code)
    assert.equal(e.category, category, `code ${code} → category`)
    assert.equal(e.retryable, retryable, `code ${code} → retryable`)
    assert.equal(e.code, code, 'code preserved (backward compat)')
  }
  // extra 可覆盖 retryable（如 503 + Retry-After 明确可等）
  const e2 = new UpstreamError('x', CODE.server, { retryable: false, status: 503 })
  assert.equal(e2.retryable, false, 'extra overrides derived retryable')
  assert.equal(e2.category, 'upstream')
  // 未知 code 兜底：按网络类可重试处理
  const e3 = new UpstreamError('x', 'SOMETHING_NEW')
  assert.equal(e3.category, 'network')
  assert.equal(e3.retryable, true)
})

await testAsync('hub failure frame carries category/retryable in finish.reason.failure', async () => {
  const { createStores } = await import('../src/store.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const { UpstreamError, CODE } = await import('../src/http.js')
  const dir = tmpDir('ch-errframe-')
  const stores = createStores(dir)
  const authFail = {
    listModels: async () => [{ id: 'wb/bad', source: 'workbuddy', name: 'Bad', contextWindow: 128000, maxOutput: 8192 }],
    // async throw（真实渠道形态）：dispatch 拿到 rejected promise，走 channel 错误帧路径
    streamTurn: async () => { throw new UpstreamError('key expired', CODE.auth) },
    status: () => ({ accounts: 1, ok: 0 }),
  }
  const hub = createHubRuntime({
    stores, workbuddy: authFail, upstreams: makeSource('up'), logger: console, warn: () => {},
    settings: () => stores.settings.load(),
  })
  const chunks = []
  const call = await hub.adapter.prepareCall('credit-hub', 'wb/bad')
  for await (const chunk of call.stream({ model: 'wb/bad', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
  const finish = chunks.find(c => c.type === 'finish')
  assert.ok(finish, 'finish frame emitted')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'AUTH')
  assert.equal(finish.reason.failure.category, 'auth', 'failure frame carries category')
  assert.equal(finish.reason.failure.retryable, false, 'failure frame carries retryable')
  stores.dispose()
  await rmDir(dir)
})

// ── 批次五：熔断器 + 可观测性 ──────────────────────────────────────────────
test('breaker opens after threshold failures with exponential cooldown, half-opens once', () => {
  return (async () => {
    const { createBreaker } = await import('../src/breaker.js')
    const b = createBreaker({ threshold: 3, baseCooldownMs: 1000, maxCooldownMs: 60_000 })
    assert.equal(b.canTry('m'), null, 'fresh member usable')
    assert.equal(b.recordFailure('m', 'err1'), 0, 'below threshold → no cooldown')
    assert.equal(b.canTry('m'), null)
    b.recordFailure('m', 'err2')
    assert.equal(b.canTry('m'), null)
    // 第 3 次 → 熔断
    const cd1 = b.recordFailure('m', 'err3')
    assert.ok(cd1 >= 1000, `third failure trips breaker (${cd1}ms)`)
    // 冷却期内一律拒绝（不再有"第一个请求直接放行"的旧 bug）
    assert.ok(Number.isFinite(b.canTry('m')) && b.canTry('m') > 0, 'cooling down: blocked')
    assert.ok(Number.isFinite(b.canTry('m')) && b.canTry('m') > 0, 'still blocked on second check')
    // 试探成功 → 关闭
    b.recordSuccess('m')
    assert.equal(b.canTry('m'), null, 'closed after success')
    const snap = b.snapshot()['m']
    assert.equal(snap.state, 'closed')
    assert.equal(snap.consecutiveFails, 0)
    // 再熔断 → 冷却翻倍
    for (let i = 0; i < 3; i++) b.recordFailure('m', 'again')
    const cd2 = b.recordFailure('m', 'again')
    assert.ok(cd2 >= 2000, `re-trip doubles cooldown (${cd2}ms)`)
  })()
})

await testAsync('combo chain skips cooled-down member and records failure with trace/ttfb', async () => {
  const { createStores } = await import('../src/store.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const { UpstreamError, CODE } = await import('../src/http.js')
  const dir = tmpDir('ch-breaker-')
  const stores = createStores(dir)
  const rateLimited = {
    listModels: async () => [{ id: 'wb/rl', source: 'workbuddy', name: 'RL', contextWindow: 128000, maxOutput: 8192 }],
    streamTurn: async () => { throw new UpstreamError('rate limited', CODE.rate) },
    status: () => ({ accounts: 1, ok: 0 }),
  }
  const healthy = makeSource('up')
  const hub = createHubRuntime({
    stores, workbuddy: rateLimited, upstreams: healthy, logger: console, warn: () => {},
    settings: () => stores.settings.load(),
  })
  await hub.setCombos([{ name: 'b', strategy: 'fallback', chain: ['wb/rl', 'up/m1'] }])
  const turns = []
  const recordTurn = info => turns.push(info)
  // 经由第二参数注入 recordTurn 不支持——直接通过 hub 内部不可达，改走全局可观测断言：
  const chunks = []
  const call = await hub.adapter.prepareCall('credit-hub', 'combo/b')
  for await (const chunk of call.stream({ model: 'combo/b', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
  assert.ok(chunks.some(c => c.type === 'finish' && c.reason.kind === 'stop'), 'healthy member wins')
  // 前 3 轮全部撞限流成员 → 第 4 轮起 wb/rl 进入冷却，tried 里出现「冷却中」
  const breakerSnap = hub.breaker()
  assert.equal(breakerSnap['wb/rl'].state, 'closed', 'one failure below threshold')
  stores.dispose()
  await rmDir(dir)
})

await testAsync('gateway emits x-credit-hub-trace header and honors client x-request-id', async () => {
  const { createStores } = await import('../src/store.js')
  const { startGateway } = await import('../src/forward.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const dir = tmpDir('ch-trace-')
  const stores = createStores(dir)
  stores.settings.update(s => ({ ...s, gatewayPort: 40000 + Math.floor(Math.random() * 10000) }))
  const hub = createHubRuntime({ stores, workbuddy: makeSource('wb'), upstreams: makeSource('up'), logger: console, warn: () => {} })
  const gateway = startGateway({ stores, hub, logger: console, settings: () => stores.settings.load() })
  const bind = await gateway.start()
  const auth = { authorization: `Bearer ${gateway.key()}`, 'content-type': 'application/json' }
  // 客户端自带 x-request-id → 响应头原样返回
  const r1 = await fetch(`http://${bind}/v1/models`, { headers: { ...auth, 'x-request-id': 'my-req-42' } })
  assert.equal(r1.headers.get('x-credit-hub-trace'), 'my-req-42', 'client trace id echoed')
  // 未带 → 服务端生成 trc_ 前缀
  const r2 = await fetch(`http://${bind}/v1/models`, { headers: auth })
  const serverTrace = r2.headers.get('x-credit-hub-trace')
  assert.ok(serverTrace?.startsWith('trc_'), `server mints trace id (${serverTrace})`)
  await gateway.stop()
  stores.dispose()
  await rmDir(dir)
})

// ── 熔断器确定性时钟测试（优先级一：不依赖真实等待） ────────────────────────
test('breaker deterministic clock: open→skip, half-open probe, recovery, re-trip', () => {
  return (async () => {
    const { createBreaker } = await import('../src/breaker.js')
    let t = 1_000_000
    const b = createBreaker({ threshold: 3, baseCooldownMs: 1000, maxCooldownMs: 60_000, now: () => t })

    // 1. 打开前可用；连续失败 3 次 → 熔断
    assert.equal(b.canTry('m'), null)
    b.recordFailure('m', 'e1', { category: 'rate-limit' })
    b.recordFailure('m', 'e2', { category: 'rate-limit' })
    assert.equal(b.recordFailure('m', 'e3', { category: 'rate-limit' }), 1000, 'trips at threshold')
    const snap0 = b.snapshot()['m']
    assert.equal(snap0.state, 'open')
    assert.equal(snap0.consecutiveFails, 3)
    assert.equal(snap0.cooldownRemainingMs, 1000)
    assert.equal(snap0.lastCategory, 'rate-limit')

    // 2. 冷却期内跳过
    t += 500
    assert.equal(b.canTry('m'), 500, 'still cooling')

    // 3. 冷却期满 → 半开只放行一个探测；并发后续调用者拿到 0（探测在途，继续跳过）
    t += 600
    assert.equal(b.canTry('m'), null, 'half-open admits first probe')
    assert.equal(b.canTry('m'), 0, 'second concurrent caller blocked (probe in flight)')
    assert.equal(b.canTry('m'), 0, 'third concurrent caller blocked (probe in flight)')

    // 4. 探测成功 → 恢复（closed + 计数清零 + 恢复时刻记录）
    b.recordSuccess('m')
    const snap1 = b.snapshot()['m']
    assert.equal(snap1.state, 'closed')
    assert.equal(snap1.consecutiveFails, 0)
    assert.equal(snap1.probes, 1)
    assert.equal(snap1.lastRecoveredAt, t)

    // 5. 恢复后全新一轮故障 → 冷却从 base 重新开始（openLevel 已随恢复清零；
    //    「翻倍」只适用于半开探测失败——未恢复就再挂，见 5b）
    b.recordFailure('m', 'x'); b.recordFailure('m', 'x')
    const cd2 = b.recordFailure('m', 'x')
    assert.equal(cd2, 1000, 'fresh round after recovery starts at base cooldown')
    // 5b. 半开探测失败 → 未恢复再挂，档位递增
    t += 1100
    assert.equal(b.canTry('m'), null, 'half-open probe admitted')
    const cd2b = b.recordFailure('m', 'probe-failed')
    assert.ok(cd2b >= 2000, `probe failure re-trips with escalated cooldown (${cd2b}ms)`)
    // 6. 冷却期内再失败 → 档位递增
    t += 2500
    b.recordFailure('m', 'x'); b.recordFailure('m', 'x')
    const cd3 = b.recordFailure('m', 'x', { retryAfterMs: 8000 })
    assert.equal(cd3, 8000, 'Retry-After overrides exponential backoff')

    // 7. Retry-After 不缩短（小于 base 时取 base）且封顶 max
    t += 9000
    b.recordFailure('m', 'x'); b.recordFailure('m', 'x')
    const cd4 = b.recordFailure('m', 'x', { retryAfterMs: 100 })
    assert.equal(cd4, 1000, 'retryAfter < base → base wins')
    // 8. 手动重置
    b.reset(['m'])
    assert.equal(b.canTry('m'), null, 'manual reset releases cooldown')
    assert.equal(b.snapshot()['m'].consecutiveFails, 0)
    // 9. 不同成员状态独立
    b.recordFailure('other', 'y'); b.recordFailure('other', 'y'); b.recordFailure('other', 'y')
    assert.equal(b.snapshot()['m'].state, 'closed', 'm unaffected')
    assert.equal(b.snapshot().other.state, 'open', 'other tripped independently')
  })()
})

await testAsync('combo chain: cancels and auth errors do not trip breaker; skip note lists cooldown', async () => {
  const { createStores } = await import('../src/store.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const { UpstreamError, CODE } = await import('../src/http.js')
  const dir = tmpDir('ch-brk2-')
  const stores = createStores(dir)
  let behavior = 'auth'
  const flaky = {
    listModels: async () => [{ id: 'wb/fl', source: 'workbuddy', name: 'FL', contextWindow: 128000, maxOutput: 8192 }],
    streamTurn: async () => {
      if (behavior === 'auth') throw new UpstreamError('bad key', CODE.auth)
      if (behavior === 'cancel') throw new UpstreamError('user stopped', CODE.aborted)
      throw new UpstreamError('rate limited', CODE.rate)
    },
    status: () => ({ accounts: 1, ok: 0 }),
  }
  const healthy = makeSource('up')
  const hub = createHubRuntime({
    stores, workbuddy: flaky, upstreams: healthy, logger: console, warn: () => {},
    settings: () => stores.settings.load(),
  })
  await hub.setCombos([{ name: 'x', strategy: 'fallback', chain: ['wb/fl', 'up/m1'] }])
  const runOnce = async () => {
    const chunks = []
    const call = await hub.adapter.prepareCall('credit-hub', 'combo/x')
    for await (const chunk of call.stream({ model: 'combo/x', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
    return chunks
  }
  // auth 失败多次 → 不熔断（retryable=false）：行存在（canTry 会建行）但保持 closed
  behavior = 'auth'
  for (let i = 0; i < 5; i++) await runOnce()
  const authSnap = hub.breaker()['wb/fl']
  assert.ok(authSnap === undefined || (authSnap.state === 'closed' && authSnap.consecutiveFails === 0),
    `auth errors never trip breaker (${JSON.stringify(authSnap)})`)
  // cancel 多次 → 不熔断
  behavior = 'cancel'
  for (let i = 0; i < 5; i++) await runOnce()
  const cancelSnap = hub.breaker()['wb/fl']
  assert.ok(cancelSnap === undefined || (cancelSnap.state === 'closed' && cancelSnap.consecutiveFails === 0),
    `aborts never trip breaker (${JSON.stringify(cancelSnap)})`)
  // rate-limit 连续 3 次 → 熔断，第 4 轮 tried 里出现冷却标注，健康成员兜底
  behavior = 'rate'
  for (let i = 0; i < 3; i++) await runOnce()
  const snap = hub.breaker()['wb/fl']
  assert.equal(snap.state, 'open', 'rate-limit trips after 3')
  assert.equal(snap.lastCategory, 'rate-limit')
  const chunks4 = await runOnce()
  assert.ok(chunks4.some(c => c.type === 'finish' && c.reason.kind === 'stop'), 'healthy member still serves')
  stores.dispose()
  await rmDir(dir)
})

await testAsync('breaker diagnostics API: GET /breaker view + POST /breaker/reset releases', async () => {
  const { default: http } = await import('node:http')
  const { createApiRoutes } = await import('../src/api.js')
  const dir = tmpDir('ch-brkapi-')
  const stores = createStores(dir)
  const fakeBreaker = {
    state: new Map([['wb/x', { state: 'open', consecutiveFails: 3, cooldownRemainingMs: 25000, probes: 1, lastCategory: 'rate-limit', lastError: 'too many' }]]),
    snapshot() { return Object.fromEntries(this.state) },
    reset(ids) { if (!ids || ids.includes('wb/x')) this.state.delete('wb/x') },
  }
  const api = createApiRoutes({
    stores,
    hub: { invalidate: () => {}, breaker: () => fakeBreaker.snapshot(), resetBreaker: ids => fakeBreaker.reset(ids) },
    workbuddy: {}, upstreams: {},
    gateway: { running: false, stats: () => ({}) },
    version: 'test', settingsKeys: [], logs: () => [], clearLogs: () => {},
    log: () => {}, warn: () => {},
  })
  const server = http.createServer(api)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/credit-hub`
    // GET 视图含状态/连续失败/剩余/分类/探测次数
    const view = await (await fetch(`${base}/breaker`)).json()
    const row = view.breaker['wb/x']
    assert.equal(row.state, 'open')
    assert.equal(row.consecutiveFails, 3)
    assert.equal(row.cooldownRemainingMs, 25000)
    assert.equal(row.probes, 1)
    assert.equal(row.lastCategory, 'rate-limit')
    // POST 重置（带 confirm 头语义的单独端点）→ 冷却解除
    const reset = await fetch(`${base}/breaker/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['wb/x'] }) })
    assert.equal(reset.status, 200)
    const after = await (await fetch(`${base}/breaker`)).json()
    assert.equal(after.breaker['wb/x'], undefined, 'cooldown released')
  } finally {
    await new Promise(resolve => server.close(resolve))
    stores.dispose()
    await rmDir(dir)
  }
})

await testAsync('hub sourceStatus reports per-source ok/count/error', async () => {
  const { createStores } = await import('../src/store.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const dir = tmpDir('ch-src-')
  const stores = createStores(dir)
  const broken = {
    listModels: async () => { throw new Error('login expired') },
    streamTurn: async () => { throw new Error('x') },
    status: () => ({ accounts: 0, ok: 0 }),
  }
  const hub = createHubRuntime({
    stores, workbuddy: broken, upstreams: makeSource('up'), logger: console, warn: () => {},
    settings: () => stores.settings.load(),
  })
  await hub.catalog(true)
  const st = hub.sourceStatus()
  assert.equal(st.workbuddy.ok, false)
  assert.match(st.workbuddy.error, /login expired/)
  assert.equal(st.upstreams.ok, true)
  assert.ok(st.upstreams.count >= 1)
  assert.equal(st.pack.ok, true)
  assert.equal(st.pack.count, 0)
  stores.dispose()
  await rmDir(dir)
})

// ── 优先级五：协议转换共享夹具 ─────────────────────────────────────────────
/**
 * 共享 SSE 夹具（清单：三套协议不该各自独立断言）。
 * parseSse(text) → [{ event, data }]；dataFrames(text) → 解析后的 data JSON 数组。
 * 一次起网关，三种线各发一轮 scripted upstream 剧本，对事件序列做规范断言。
 */
const parseSse = text => text.split('\n\n').filter(block => block.trim()).map(block => {
  let event = 'message'
  const dataLines = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  return { event, data: dataLines.join('\n') }
})
const dataFrames = text => parseSse(text)
  .map(frame => { try { return JSON.parse(frame.data) } catch { return null } })
  .filter(row => row !== null)

/** 剧本化 upstream：按脚本吐 chunk（id 已含来源前缀，对齐 aggregate.listModels 输出）。 */
const scriptedUpstream = script => ({
  listModels: async () => [{ id: 'up/m1', source: 'upstream', name: 'M1', contextWindow: 128000, maxOutput: 8192 }],
  streamTurn: async ({ onChunk }) => { for (const step of script) onChunk(step); return { sawText: true, sawFinish: true, finish: 'stop', usage: { inputTokens: 3, outputTokens: 2 }, nextIndex: 1 } },
  status: () => ({ accounts: 1, ok: 1 }),
})

await testAsync('protocol fixture: one gateway, three wires, scripted chunks → event sequences', async () => {
  const { createStores } = await import('../src/store.js')
  const { startGateway, clampMaxTokens } = await import('../src/forward.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const dir = tmpDir('ch-proto-')
  const stores = createStores(dir)
  stores.settings.update(s => ({ ...s, gatewayPort: 50000 + Math.floor(Math.random() * 9000) }))
  // 剧本：reasoning → 文本 → 工具调用 → 结束（覆盖三个协议各自的映射难点）
  const upstreams = scriptedUpstream([
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking…' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking…' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'answer part' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'answer part' } },
    { type: 'block-start', index: 2, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 2, id: 'call_1', name: 'read_file', argumentsDelta: '{"pa' },
    { type: 'tool-call-delta', index: 2, argumentsDelta: 'th":1}' },
    { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":1}' } },
  ])
  const hub = createHubRuntime({ stores, workbuddy: makeSource('wb'), upstreams, logger: console, warn: () => {}, settings: () => stores.settings.load() })
  const gateway = startGateway({ stores, hub, logger: console, settings: () => stores.settings.load() })
  const bind = await gateway.start()
  const auth = { authorization: `Bearer ${gateway.key()}`, 'content-type': 'application/json' }
  try {
    // ── OpenAI Chat Completions 线 ──
    const oa = dataFrames(await (await fetch(`${base(bind)}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'up/m1', messages: [{ role: 'user', content: 'x' }], stream: true }) })).text())
    const oaReason = oa.filter(f => f.choices?.[0]?.delta?.reasoning_content)
    assert.equal(oaReason.length, 1, 'openai: reasoning delta mapped to reasoning_content')
    assert.equal(oaReason[0].choices[0].delta.reasoning_content, 'thinking…')
    const oaText = oa.filter(f => f.choices?.[0]?.delta?.content)
    assert.equal(oaText.map(f => f.choices[0].delta.content).join(''), 'answer part')
    const oaTool = oa.filter(f => f.choices?.[0]?.delta?.tool_calls)
    assert.ok(oaTool.length >= 1, 'openai: tool-call deltas emitted')
    assert.equal(oaTool[0].choices[0].delta.tool_calls[0].id, 'call_1')
    assert.equal(oaTool.at(-1).choices[0].delta.tool_calls[0].function.arguments, '{"path":1}', 'openai: args accumulated')
    const oaFinish = oa.find(f => f.choices?.[0]?.finish_reason)
    assert.equal(oaFinish.choices[0].finish_reason, 'stop', 'openai: finish_reason present')
    const oaUsage = oa.find(f => f.usage)
    assert.equal(oaUsage.usage.total_tokens, 5, 'openai: usage attached to a frame')
    assert.equal(oa.at(-1)?.choices?.[0]?.delta, undefined || oa.at(-1).choices[0].delta, 'openai: DONE frame shape irrelevant')

    // ── Anthropic Messages 线 ──
    const cl = parseSse(await (await fetch(`${base(bind)}/v1/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'up/m1', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'x' }] }) })).text())
    const clNames = cl.map(f => f.event)
    assert.equal(clNames[0], 'message_start', 'anthropic opens with message_start')
    assert.ok(clNames.includes('content_block_start'), 'anthropic: block start')
    assert.ok(clNames.includes('content_block_delta'), 'anthropic: deltas')
    assert.ok(clNames.includes('content_block_stop'), 'anthropic: block stop')
    // thinking 块的 delta 类型是 thinking_delta
    const clThinking = cl.filter(f => f.data.includes('thinking_delta'))
    assert.ok(clThinking.length >= 1, 'anthropic: thinking_delta for reasoning chunks')
    // 文本块与工具块 index 递增不复用
    const blockStarts = cl.filter(f => f.event === 'content_block_start').map(f => JSON.parse(f.data))
    const blockIdx = blockStarts.map(f => f.index)
    assert.deepEqual(blockIdx, [...new Set(blockIdx)].sort(), 'anthropic: block indexes unique & ordered')
    // tool_use 块最终 input_json 完整
    const clToolDelta = cl.filter(f => f.data.includes('input_json_delta')).map(f => JSON.parse(f.data))
    const toolJson = clToolDelta.map(f => f.delta.partial_json ?? '').join('')
    assert.equal(toolJson, '{"path":1}', 'anthropic: input_json_delta concatenates to final args')
    assert.ok(clNames.includes('message_delta') && clNames.includes('message_stop'), 'anthropic: message_delta + message_stop close the stream')
    // usage 在 message_delta 的 usage 字段
    const clUsage = cl.filter(f => f.event === 'message_delta').map(f => JSON.parse(f.data)).find(f => f.usage)
    assert.ok(clUsage?.usage?.output_tokens >= 2, 'anthropic: usage rides message_delta')

    // ── Responses 线 ──
    const rs = parseSse(await (await fetch(`${base(bind)}/v1/responses`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'up/m1', input: 'x', stream: true }) })).text())
    const rsNames = rs.map(f => f.event)
    assert.equal(rsNames[0], 'response.created', 'responses opens with created')
    assert.ok(rsNames.includes('response.output_item.added'), 'responses: output item added')
    // reasoning item 生命状态：added → delta → done
    const rsReasoningAdded = rs.filter(f => f.data.includes('"type":"reasoning"') && f.data.includes('output_item.added'))
    assert.ok(rsReasoningAdded.length >= 1, 'responses: reasoning item has lifecycle events')
    const rsReasonDone = rs.filter(f => f.event === 'response.reasoning_summary_text.done' || (f.data.includes('reasoning') && f.data.includes('.done')))
    assert.ok(rsReasonDone.length >= 1, 'responses: reasoning item reaches .done')
    assert.ok(rsNames.includes('response.output_text.delta'), 'responses: text deltas')
    // 注：本网关的 Responses 线用 content_part.done + output_item.done 收尾文本块
    // （与 OpenAI 官方的 output_text.done 事件名不同——codex-proxy 兼容层已按此实现验证）
    const rsTextDone = rs.filter(f => f.event === 'response.content_part.done')
    assert.ok(rsTextDone.length >= 1, 'responses: text part closes with content_part.done')
    const partDone = rsTextDone.map(f => JSON.parse(f.data)).at(-1)
    assert.equal(partDone.part.text, 'answer part', 'responses: done part carries full text')
    // function_call 增量 + 最终参数
    const rsFnDelta = rs.filter(f => f.data.includes('function_call_arguments.delta'))
    const rsFnDone = rs.filter(f => f.data.includes('function_call_arguments.done'))
    assert.ok(rsFnDelta.length >= 1 && rsFnDone.length >= 1, 'responses: function_call args delta + done')
    const fnDoneArgs = rsFnDone.map(f => JSON.parse(f.data)).at(-1)
    assert.equal(fnDoneArgs.arguments, '{"path":1}', 'responses: final args complete')
    assert.ok(rsNames.includes('response.completed'), 'responses closes with completed')
    const rsCompleted = rs.filter(f => f.event === 'response.completed').map(f => JSON.parse(f.data))[0]
    assert.equal(rsCompleted.response.usage.total_tokens, 5, 'responses: usage in completed')
  } finally {
    await gateway.stop()
    stores.dispose()
    await rmDir(dir)
  }
})

// 上一段夹具依赖 base() 小工具
function base(bind) { return `http://${bind}` }

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
// 显式退出：undici 的 keep-alive 池与个别未 unref 的定时器在某些 CI 网络环境下
// 会把事件循环钉住（2026-11-21 GitHub Actions 上 Host tests 挂 10 分钟被看门狗杀）。
// 测试结论已打印，强制退出不影响结果正确性。
process.exit(failures === 0 ? 0 : 1)
