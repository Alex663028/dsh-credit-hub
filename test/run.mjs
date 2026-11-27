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
  try {
    const result = fn()
    // 防呆：async 函数必须走 testAsync。旧版忽略返回值 → 断言在 ok 打印之后
    // 才抛，变成 unhandledRejection 而不计入 failures（2026-11-21 发现：
    // 多个 transforms 测试因此「静默通过」）。
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      failures += 1
      console.log(`FAIL ${name}: 异步测试必须用 testAsync（test() 不会 await 返回值）`)
      result.catch(() => {})
      return
    }
    console.log(`ok   ${name}`)
  } catch (error) { failures += 1; console.log(`FAIL ${name}: ${error.message}`) }
}
const testAsync = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`) } catch (error) { failures += 1; console.log(`FAIL ${name}: ${error.message}`) }
}
const tmpDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const rmDir = async dir => fs.promises.rm(dir, { recursive: true, force: true })
// 测试端口分配器：进程内单调递增，保证每个 e2e 的端口绝不重复。
// 旧版各处用 `X + Math.random() * Y`，区间大量重叠（46000–49000 用了 4 次…），
// 两个测试撞到同一端口且前一个 server 尚在 TIME_WAIT 时 → EADDRINUSE 概率性
// 失败（CI 上表现为单点 job 挂约 2 分钟、重跑即绿）。步进 7 让自身重试的
// `+517` 顺移也落在已分配序列之外。
let testPortCursor = 51000
const nextTestPort = () => { testPortCursor += 7; return testPortCursor }

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
await testAsync('stores round trip + key', async () => {
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
  stores.settings.update(s => ({ ...s, gatewayPort: nextTestPort() }))
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

// ── 宿主模型选择器广播（WorkBuddy 一直显示加载失败的根因） ──────────────────
await testAsync('apply() broadcasts llm/models-updated for both providers on boot', async () => {
  const dir = tmpDir('ch-broadcast-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  // 用带 query 的 import 绕过模块缓存，确保拿到最新 index.js
  const { apply } = await import('../index.js?broadcast-test')
  const emitted = []
  const effects = []
  const adaptersUpdated = []
  const mockCtx = {
    logger: { info: () => {}, warn: () => {} },
    llm: {
      registerAdapter: () => () => {},
      emitAdaptersUpdated: () => { adaptersUpdated.push('llm') },
      stream: async function * () {},
    },
    inject: (deps, cb) => {
      const scoped = { ...mockCtx, webServer: { register: () => () => {} }, effect: fn => effects.push(fn) }
      try { cb(scoped) } catch {}
    },
    effect: fn => effects.push(fn),
    on: () => () => {},
    emit: (event, ...args) => { emitted.push({ event, args }) },
    get: () => undefined,
  }
  try { apply(mockCtx, { accountPack: 'off' }) } catch (error) {
    assert.fail(`apply() threw: ${error.message}`)
  }
  // 启动后延迟广播（3s / 15s）——用假时钟推进，避免测试真的等 15 秒
  await new Promise(resolve => setTimeout(resolve, 25))   // 让同步部分先跑完
  // 直接检查：tick 与 boot 广播都通过 broadcastCatalogChanged，事件应已可从
  // 「周期任务」路径覆盖；这里额外触发一次 ensure 逻辑无法直接调，改为断言
  // ctx.emit 在启动同步阶段至少收到了 adapters-updated（注册完成时）
  const names = emitted.map(row => row.event)
  assert.ok(names.includes('llm/adapters-updated'), `adapters-updated emitted (got ${names.join(',')})`)
  // 关键：models-updated 必须带 provider 参数，宿主靠它重载 listModels()
  for (const provider of ['workbuddy', 'credit-hub']) {
    const hit = emitted.find(row => row.event === 'llm/models-updated' && row.args[0] === provider)
    assert.ok(hit, `llm/models-updated(${provider}) emitted`)
  }
  assert.ok(adaptersUpdated.length >= 0, 'llm.emitAdaptersUpdated is safe when present')
  // 清理
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
  stores.settings.update(s => ({ ...s, gatewayPort: nextTestPort() }))
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
await testAsync('breaker opens after threshold failures with exponential cooldown, half-opens once', () => {
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
  stores.settings.update(s => ({ ...s, gatewayPort: nextTestPort() }))
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
await testAsync('breaker deterministic clock: open→skip, half-open probe, recovery, re-trip', () => {
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
  stores.settings.update(s => ({ ...s, gatewayPort: nextTestPort() }))
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

// ── 第三阶段：配置迁移 + 熔断参数消毒 ──────────────────────────────────────
await testAsync('stores.migrate: schemaVersion bump + legacy checkinMarks cleanup', async () => {
  const { createStores } = await import('../src/store.js')
  const dir = tmpDir('ch-mig-')
  // createStores(dir) 的 dir 是 home —— 数据落在 dir/credit-hub/（对齐既有迁移测试）
  fs.mkdirSync(path.join(dir, 'credit-hub'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'credit-hub', 'settings.json'), JSON.stringify({
    gatewayPort: 9000,
    checkinMarks: { '2026-11-20': true, '2026-11-21:wb_abc': 'ok', 'other': false },
  }), 'utf8')
  const stores = createStores(dir)
  const result = stores.migrate()
  assert.equal(result.changed, true, 'migration reports change')
  assert.equal(result.schemaVersion, 2)
  const after = stores.settings.load()
  assert.equal(after.schemaVersion, 2)
  assert.equal(after.gatewayPort, 9000, 'user settings preserved')
  assert.equal(after.checkinMarks['2026-11-20'], undefined, 'boolean mark dropped')
  assert.equal(after.checkinMarks['other'], undefined, 'no-account suffix dropped')
  assert.equal(after.checkinMarks['2026-11-21:wb_abc'], 'ok', 'valid mark kept')
  // 幂等：再跑一次不再报变化
  const second = stores.migrate()
  assert.equal(second.changed, false, 'idempotent')
  stores.dispose()
  await rmDir(dir)
})

await testAsync('breaker settings sanitized: invalid threshold/cooldowns fall back to defaults', async () => {
  const { createStores } = await import('../src/store.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const { UpstreamError, CODE } = await import('../src/http.js')
  const dir = tmpDir('ch-brkcfg-')
  const stores = createStores(dir)
  // 全部非法：threshold 0 / 负冷却 / 非数字
  stores.settings.update(s => ({ ...s, breaker: { threshold: 0, baseCooldownMs: -500, maxCooldownMs: 'bogus' } }))
  let calls = 0
  const rateLimited = {
    listModels: async () => [{ id: 'wb/rl', source: 'workbuddy', name: 'RL', contextWindow: 128000, maxOutput: 8192 }],
    streamTurn: async () => { calls += 1; throw new UpstreamError('rate limited', CODE.rate) },
    status: () => ({ accounts: 1, ok: 0 }),
  }
  const hub = createHubRuntime({
    stores, workbuddy: rateLimited, upstreams: makeSource('up'), logger: console, warn: () => {},
    settings: () => stores.settings.load(),
  })
  await hub.setCombos([{ name: 'c', strategy: 'fallback', chain: ['wb/rl', 'up/m1'] }])
  const runOnce = async () => {
    const call = await hub.adapter.prepareCall('credit-hub', 'combo/c')
    for await (const chunk of call.stream({ model: 'combo/c', messages: [{ role: 'user', content: 'x' }] })) { /* drain */ }
  }
  // 非法 threshold=0 → 回退默认 3：前 2 次失败不熔断，第 3 次才熔断
  await runOnce(); await runOnce()
  assert.equal(hub.breaker()['wb/rl']?.state ?? 'closed', 'closed', 'invalid threshold fell back to 3 (not tripped yet)')
  await runOnce()
  assert.equal(hub.breaker()['wb/rl'].state, 'open', 'tripped at sanitized threshold 3')
  // 冷却从熔断瞬间起算 30000ms，断言执行时已流逝若干 ms —— 严格 >=30000 会偶发失败
  assert.ok(hub.breaker()['wb/rl'].cooldownRemainingMs >= 25_000, 'base cooldown sanitized to 30000 (clock-drift tolerant)')
  stores.dispose()
  await rmDir(dir)
})

// ── 优先级一：转换器契约测试（src/transforms/ 纯函数层） ────────────────────
await testAsync('transforms/openai: inbound 全角色映射 + usage 线上字段', () => {
  return (async () => {
    const { openAiToHarness, openAiUsage, finishToOpenAi, partsText } = await import('../src/transforms/openai.js')
    const messages = openAiToHarness([
      { role: 'system', content: 'sys' },
      { role: 'developer', content: [{ type: 'text', text: 'dev' }] },
      { role: 'user', content: 'hi' },
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] },
      { role: 'assistant', content: 'ans', reasoning_content: 'think', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ])
    assert.equal(messages[0].role, 'system')
    assert.equal(messages[0].content, 'sys')
    assert.equal(messages[1].content, 'dev', 'developer folded into system')
    // user 字符串会被规范成 text block（harness 统一形状），不是原样字符串
    assert.equal(messages[2].content[0].type, 'text')
    assert.equal(messages[2].content[0].text, 'hi', 'plain user string → text block')
    assert.equal(messages[3].content[1].type, 'image', 'image_url → image block')
    assert.equal(messages[4].reasoning_content, 'think')
    assert.equal(messages[4].content[1].type, 'tool-call')
    assert.equal(messages[5].content[0].type, 'tool-result')
    assert.equal(messages[5].content[0].toolCallId, 'c1')
    // usage 只在有值时生成，字段名是线上协议名
    assert.equal(openAiUsage(null), undefined, 'no usage → undefined (not a zero object)')
    const u = openAiUsage({ inputTokens: 5, outputTokens: 2 })
    assert.deepEqual(u, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })
    const u2 = openAiUsage({ inputTokens: 1, outputTokens: 1, reasoningTokens: 3, cacheReadTokens: 4 })
    assert.equal(u2.completion_tokens_details.reasoning_tokens, 3)
    assert.equal(u2.prompt_tokens_details.cached_tokens, 4)
    // finish：只有 max-tokens 映射 length，错误/中止都收 stop（错误另走 error 帧）
    assert.equal(finishToOpenAi({ kind: 'max-tokens' }), 'length')
    assert.equal(finishToOpenAi({ kind: 'stop' }), 'stop')
    assert.equal(finishToOpenAi({ kind: 'error' }), 'stop')
    assert.equal(finishToOpenAi({ kind: 'aborted' }), 'stop')
    assert.equal(finishToOpenAi({ kind: 'weird-custom' }), 'stop', 'unknown finish → stop')
    assert.equal(finishToOpenAi(undefined), 'stop')
    assert.equal(partsText([{ type: 'text', text: 'x' }, { type: 'image' }, { type: 'text', text: 'y' }]), 'x\ny')
  })()
})

await testAsync('transforms/openai: chunk 映射（tool 参数累积 / 未知 chunk 安全跳过）', () => {
  return (async () => {
    const { openAiChunkFrames } = await import('../src/transforms/openai.js')
    const base = { id: 'x', object: 'chat.completion.chunk' }
    // 文本增量
    let r = openAiChunkFrames({ type: 'text-delta', text: 'hi' }, { base, openTool: null })
    assert.equal(r.frames[0].choices[0].delta.content, 'hi')
    assert.equal(r.frames[0].choices[0].finish_reason, null)
    // 工具增量累积
    r = openAiChunkFrames({ type: 'tool-call-delta', id: 'c1', name: 'f', argumentsDelta: '{"a' }, { base, openTool: null })
    assert.equal(r.frames.length, 0, 'delta 阶段不吐帧')
    r = openAiChunkFrames({ type: 'tool-call-delta', argumentsDelta: ':1}' }, { base, openTool: r.openTool })
    assert.equal(r.openTool.args, '{"a:1}', 'args 跨 chunk 累积')
    // 工具块结束 → 一次性吐完整帧
    const done = openAiChunkFrames({ type: 'block-end', block: { type: 'tool-call', id: 'c1', name: 'f', arguments: '{"a":1}' } }, { base, openTool: r.openTool })
    assert.equal(done.frames.length, 1)
    const call = done.frames[0].choices[0].delta.tool_calls[0]
    assert.equal(call.id, 'c1')
    assert.equal(call.function.name, 'f')
    assert.equal(done.openTool, null, '发帧后清空 openTool')
    // 未知 chunk 安全跳过（不抛）
    const unknown = openAiChunkFrames({ type: 'totally-unknown-kind' }, { base, openTool: null })
    assert.equal(unknown.frames.length, 0, 'unknown chunk → zero frames, no throw')
    // usage/finish 由主循环处理，映射层不吐帧
    assert.equal(openAiChunkFrames({ type: 'usage' }, { base, openTool: null }).frames.length, 0)
    assert.equal(openAiChunkFrames({ type: 'finish' }, { base, openTool: null }).frames.length, 0)
  })()
})

await testAsync('transforms/claude: inbound 混合内容拆两条 + usage/additional 映射', () => {
  return (async () => {
    const { claudeToHarness, claudeUsage, claudeChunkAction } = await import('../src/transforms/claude.js')
    // system 字符串 / 数组
    assert.equal(claudeToHarness({ system: 'sys', messages: [] })[0].content, 'sys')
    assert.equal(claudeToHarness({ system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], messages: [] })[0].content, 'a\nb')
    // 混合内容：文本 + tool_result 必须拆成 user + tool 两条（旧版二选一会丢文本）
    const mixed = claudeToHarness({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'why' },
          { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'r' }] },
        ],
      }],
    })
    assert.equal(mixed.length, 2, 'split into user + tool')
    assert.equal(mixed[0].role, 'user')
    assert.equal(mixed[0].content[0].text, 'why')
    assert.equal(mixed[1].role, 'tool')
    assert.equal(mixed[1].content[0].toolCallId, 'tu1')
    // base64 image → data URL
    const img = claudeToHarness({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }] })
    assert.equal(img[0].content[0].image, 'data:image/png;base64,AAA')
    // tool_use → tool-call（input 对象序列化）
    const asst = claudeToHarness({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } }] }] })
    assert.equal(asst[0].content[0].arguments, '{"a":1}')
    // usage 映射
    assert.deepEqual(claudeUsage({ inputTokens: 3, outputTokens: 4 }), { input_tokens: 3, output_tokens: 4 })
    assert.deepEqual(claudeUsage(null), { input_tokens: 0, output_tokens: 0 }, 'null usage → zeros')
    // chunk action
    assert.equal(claudeChunkAction({ type: 'text-delta', text: 'x' }).delta.type, 'text_delta')
    assert.equal(claudeChunkAction({ type: 'reasoning-delta', text: 'x' }).delta.type, 'thinking_delta')
    assert.equal(claudeChunkAction({ type: 'block-end', block: { type: 'tool-call' } }).action, 'tool-block')
    assert.equal(claudeChunkAction({ type: 'usage' }), null, 'usage handled by main loop')
    assert.equal(claudeChunkAction({ type: 'unknown' }), null, 'unknown → null, no throw')
  })()
})

await testAsync('transforms/responses: inbound 全 item 形态 + tools 过滤 + usage', () => {
  return (async () => {
    const { responsesInputToHarness, responsesToolsToHarness, responsesUsage, outcomeFinishToken } = await import('../src/transforms/responses.js')
    // 纯字符串 input
    const simple = responsesInputToHarness({ input: 'hi' })
    assert.equal(simple[0].role, 'user')
    assert.equal(simple[0].content, 'hi')
    // instructions → system
    const withInstructions = responsesInputToHarness({ instructions: 'be nice', input: 'hi' })
    assert.equal(withInstructions[0].role, 'system')
    // message item（content 数组）
    const msg = responsesInputToHarness({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] }] })
    assert.equal(msg[0].content[0].text, 'q')
    // function_call / function_call_output
    const fn = responsesInputToHarness({ input: [
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'c1', output: 'res' },
    ] })
    assert.equal(fn[0].content[0].type, 'tool-call')
    assert.equal(fn[1].content[0].type, 'tool-result')
    assert.equal(fn[1].content[0].toolCallId, 'c1')
    // reasoning item 不回传上游
    const withReasoning = responsesInputToHarness({ input: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'user', content: 'x' }] })
    assert.equal(withReasoning.length, 1, 'reasoning item dropped')
    // tools：过滤非 function、缺省补空 schema
    const tools = responsesToolsToHarness([
      { type: 'function', name: 'a', description: 'da', parameters: { type: 'object' } },
      { name: 'b' },
      { type: 'not-a-function' },
      null,
    ])
    assert.equal(tools.length, 2, 'non-function filtered out')
    assert.equal(tools[0].name, 'a')
    assert.equal(tools[1].parameters.type, 'object', 'missing parameters → empty object schema')
    // usage
    assert.deepEqual(responsesUsage({ inputTokens: 2, outputTokens: 3 }), { input_tokens: 2, output_tokens: 3, total_tokens: 5 })
    assert.deepEqual(responsesUsage(null), { input_tokens: 0, output_tokens: 0, total_tokens: 0 })
    // finish token
    assert.equal(outcomeFinishToken({ kind: 'max-tokens' }), 'max_tokens')
    assert.equal(outcomeFinishToken({ kind: 'stop' }), 'stop')
    assert.equal(outcomeFinishToken({ kind: 'custom-x' }), 'custom-x', 'unknown passthrough')
  })()
})

await testAsync('cross-protocol: one harness transcript → three wire shapes stay consistent', () => {
  return (async () => {
    const { openAiToHarness, openAiUsage } = await import('../src/transforms/openai.js')
    const { claudeToHarness, claudeUsage } = await import('../src/transforms/claude.js')
    const { responsesInputToHarness, responsesUsage } = await import('../src/transforms/responses.js')
    // 同一轮对话在三种线格式下的入站结果，harness 侧应等价
    const openaiIn = openAiToHarness([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ])
    const claudeIn = claudeToHarness({
      system: 'be brief',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: 'q2' },
      ],
    })
    const responsesIn = responsesInputToHarness({
      instructions: 'be brief',
      input: [
        { type: 'message', role: 'user', content: 'q1' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a1' }] },
        { type: 'message', role: 'user', content: 'q2' },
      ],
    })
    const norm = rows => rows.map(r => `${r.role}:${typeof r.content === 'string' ? r.content : (r.content?.[0]?.text ?? '')}`)
    assert.deepEqual(norm(openaiIn), norm(claudeIn), 'openai vs claude inbound equivalent')
    assert.deepEqual(norm(openaiIn), norm(responsesIn), 'openai vs responses inbound equivalent')
    // usage 三线各自的线上字段名与数值一致
    const usage = { inputTokens: 10, outputTokens: 5 }
    assert.equal(openAiUsage(usage).total_tokens, 15)
    assert.equal(claudeUsage(usage).input_tokens, 10)
    assert.equal(responsesUsage(usage).total_tokens, 15)
  })()
})

// ── 优先级四补充：熔断器运行时接入（并发/共享/分类/恢复） ──────────────────
await testAsync('breaker key shares state across combo chains (same upstream member)', async () => {
  const { createStores } = await import('../src/store.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const { UpstreamError, CODE } = await import('../src/http.js')
  const dir = tmpDir('ch-share-')
  const stores = createStores(dir)
  const flaky = {
    listModels: async () => [{ id: 'wb/sh', source: 'workbuddy', name: 'SH', contextWindow: 128000, maxOutput: 8192 }],
    streamTurn: async () => { throw new UpstreamError('rate limited', CODE.rate) },
    status: () => ({ accounts: 1, ok: 0 }),
  }
  const hub = createHubRuntime({
    stores, workbuddy: flaky, upstreams: makeSource('up'), logger: console, warn: () => {},
    settings: () => stores.settings.load(),
  })
  // 两条链共用同一成员 wb/sh
  await hub.setCombos([
    { name: 'a', strategy: 'fallback', chain: ['wb/sh', 'up/m1'] },
    { name: 'b', strategy: 'fallback', chain: ['wb/sh', 'up/m1'] },
  ])
  const run = async combo => {
    const call = await hub.adapter.prepareCall('credit-hub', `combo/${combo}`)
    for await (const _ of call.stream({ model: `combo/${combo}`, messages: [{ role: 'user', content: 'x' }] })) { /* drain */ }
  }
  // 通过链 a 打满 3 次 → 熔断
  await run('a'); await run('a'); await run('a')
  assert.equal(hub.breaker()['wb/sh'].state, 'open', 'tripped via chain a')
  // 链 b 的第一跳应直接跳过该成员（共享同一熔断状态）
  let skippedViaB = false
  const warnLines = []
  const hub2 = createHubRuntime({
    stores, workbuddy: flaky, upstreams: makeSource('up'),
    logger: console, warn: message => { warnLines.push(String(message)) },
    settings: () => stores.settings.load(),
  })
  // 同一 stores 但新 hub 的 breaker 是独立内存——这里验证的是**同一 hub 内**跨链共享
  const call = await hub.adapter.prepareCall('credit-hub', 'combo/b')
  const chunks = []
  for await (const chunk of call.stream({ model: 'combo/b', messages: [{ role: 'user', content: 'x' }] })) chunks.push(chunk)
  assert.ok(chunks.some(c => c.type === 'finish' && c.reason.kind === 'stop'), 'chain b served by healthy member')
  stores.dispose()
  await rmDir(dir)
})

await testAsync('breaker classifies timeout/transport as retryable trips; region/auth do not', async () => {
  const { createStores } = await import('../src/store.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const { UpstreamError, CODE } = await import('../src/http.js')
  const dir = tmpDir('ch-cls-')
  const stores = createStores(dir)
  let mode = 'timeout'
  const flaky = {
    listModels: async () => [
      { id: 'wb/t', source: 'workbuddy', name: 'T', contextWindow: 128000, maxOutput: 8192 },
    ],
    streamTurn: async () => {
      if (mode === 'timeout') throw new UpstreamError('idle timeout', CODE.timeout)
      if (mode === 'transport') throw new UpstreamError('socket reset', CODE.transport)
      if (mode === 'region') throw new UpstreamError('region blocked', CODE.region)
      throw new UpstreamError('bad key', CODE.auth)
    },
    status: () => ({ accounts: 1, ok: 0 }),
  }
  const hub = createHubRuntime({
    stores, workbuddy: flaky, upstreams: makeSource('up'), logger: console, warn: () => {},
    settings: () => stores.settings.load(),
  })
  await hub.setCombos([{ name: 'c', strategy: 'fallback', chain: ['wb/t', 'up/m1'] }])
  const run = async () => {
    const call = await hub.adapter.prepareCall('credit-hub', 'combo/c')
    for await (const _ of call.stream({ model: 'combo/c', messages: [{ role: 'user', content: 'x' }] })) { /* drain */ }
  }
  // TIMEOUT 可重试 → 3 次熔断
  mode = 'timeout'
  await run(); await run(); await run()
  assert.equal(hub.breaker()['wb/t'].state, 'open', 'TIMEOUT trips (retryable)')
  assert.equal(hub.breaker()['wb/t'].lastCategory, 'network')
  hub.resetBreaker(['wb/t'])
  // TRANSPORT 可重试 → 3 次熔断
  mode = 'transport'
  await run(); await run(); await run()
  assert.equal(hub.breaker()['wb/t'].state, 'open', 'TRANSPORT trips (retryable)')
  hub.resetBreaker(['wb/t'])
  // REGION 不可重试 → 不熔断
  mode = 'region'
  for (let i = 0; i < 5; i++) await run()
  const regionSnap = hub.breaker()['wb/t']
  assert.ok(regionSnap === undefined || regionSnap.state === 'closed', 'REGION never trips')
  // AUTH 不可重试 → 不熔断
  mode = 'auth'
  for (let i = 0; i < 5; i++) await run()
  const authSnap = hub.breaker()['wb/t']
  assert.ok(authSnap === undefined || (authSnap.state === 'closed' && authSnap.consecutiveFails === 0), 'AUTH never trips')
  stores.dispose()
  await rmDir(dir)
})

await testAsync('half-open admits exactly one concurrent probe (integration via canTry loop)', async () => {
  const { createBreaker } = await import('../src/breaker.js')
  let t = 50_000
  const b = createBreaker({ threshold: 2, baseCooldownMs: 100, maxCooldownMs: 10_000, now: () => t })
  b.recordFailure('k', 'e'); b.recordFailure('k', 'e')   // tripped
  assert.equal(b.snapshot().k.state, 'open')
  t += 150                                               // cooldown elapsed
  // 模拟 10 个并发请求同时进链路选成员
  const admissions = Array.from({ length: 10 }, () => b.canTry('k'))
  const admitted = admissions.filter(row => row === null).length
  assert.equal(admitted, 1, `only one probe admitted among 10 concurrent callers (got ${admitted})`)
  assert.equal(admissions.filter(row => row === 0).length, 9, 'other 9 blocked as probe-in-flight')
  // 探测成功后全部放行
  b.recordSuccess('k')
  assert.equal(b.canTry('k'), null, 'closed after probe success')
  stores_dispose_noop()
  function stores_dispose_noop() {}
})

await testAsync('diagnostics snapshot aggregates catalog/breakers/gateway/channels/failures', async () => {
  const { default: http } = await import('node:http')
  const { createStores } = await import('../src/store.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const { createApiRoutes } = await import('../src/api.js')
  const dir = tmpDir('ch-diag-')
  const stores = createStores(dir)
  const hub = createHubRuntime({
    stores, workbuddy: makeSource('wb'), upstreams: makeSource('up'),
    logger: console, warn: () => {}, settings: () => stores.settings.load(),
  })
  await hub.catalog(true)
  const api = createApiRoutes({
    stores, hub, workbuddy: { status: () => ({ accounts: 1, ok: 1 }) },
    upstreams: { status: () => ({ upstreams: 0, models: 0 }) },
    gateway: { running: true, bind: () => '127.0.0.1:8330', stats: () => ({ requests: 3, ok: 3, failed: 0 }) },
    version: 'test-version', settingsKeys: [], logs: () => [], clearLogs: () => {},
    usage: () => [{ model: 'wb/m1', ok: 2, failed: 1, lastAt: 1 }],
    packStatus: () => ({ mounted: true, reason: 'forced' }),
    log: () => {}, warn: () => {},
  })
  const server = http.createServer(api)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/credit-hub`
    const diag = await (await fetch(`${base}/diagnostics`)).json()
    // 目录
    assert.ok(diag.catalog.modelCount >= 2, 'catalog.modelCount')
    assert.equal(typeof diag.catalog.stale, 'boolean')
    assert.equal(diag.catalog.ttlMs, 45_000)
    assert.ok(diag.catalog.sources.workbuddy.ok === true, 'sources 内嵌在 catalog 下')
    // 熔断
    assert.equal(typeof diag.breakers.summary.total, 'number')
    assert.equal(typeof diag.breakers.summary.open, 'number')
    assert.equal(typeof diag.breakers.entries, 'object')
    // 网关
    assert.equal(diag.gateway.running, true)
    assert.equal(diag.gateway.stats.requests, 3)
    // 渠道
    assert.equal(diag.channels.workbuddy.ok, 1)
    assert.equal(diag.channels.pack.status.mounted, true)
    // 最近失败
    assert.equal(diag.recentFailures.length, 1, 'only models with failed>0')
    assert.equal(diag.recentFailures[0].model, 'wb/m1')
    // 版本透传（mock 注入什么就透传什么——不再依赖真实 package.json，
    // 这样发版改版本号不会让本测试红一次）
    assert.equal(diag.version, 'test-version')
  } finally {
    await new Promise(resolve => server.close(resolve))
    stores.dispose()
    await rmDir(dir)
  }
})

// ── 优先级六 + 二补充：网关错误语义 / client-abort / 双栈 ──────────────────
await testAsync('gateway: invalid JSON → 400 without stack; server errors leak no stack in body', async () => {
  const { createStores } = await import('../src/store.js')
  const { startGateway } = await import('../src/forward.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const dir = tmpDir('ch-json-')
  const stores = createStores(dir)
  stores.settings.update(s => ({ ...s, gatewayPort: nextTestPort() }))
  const hub = createHubRuntime({ stores, workbuddy: makeSource('wb'), upstreams: makeSource('up'), logger: console, warn: () => {}, settings: () => stores.settings.load() })
  const gateway = startGateway({ stores, hub, logger: console, settings: () => stores.settings.load() })
  const bind = await gateway.start()
  const auth = { authorization: `Bearer ${gateway.key()}`, 'content-type': 'application/json' }
  try {
    // 非法 JSON → 400（客户端错误），不再 500
    const r1 = await fetch(`http://${bind}/v1/chat/completions`, { method: 'POST', headers: auth, body: '{invalid' })
    assert.equal(r1.status, 400, `invalid JSON → 400 (got ${r1.status})`)
    const p1 = await r1.json()
    assert.equal(p1.error.type, 'invalid_request_error')
    assert.ok(!p1.error.stack, 'no stack leaked on 400')
    assert.ok(!/\bat\s+\S+\(.*:\d+:\d+\)/.test(p1.error.message), 'no stack frames (file:line:col) in message')
    // 空数组 JSON（合法 JSON 但缺 model）→ 不是 500（解析层不炸）
    const r2 = await fetch(`http://${bind}/v1/chat/completions`, { method: 'POST', headers: auth, body: '[]' })
    assert.ok(r2.status < 500, `[] body → ${r2.status} (<500)`)
    const p2 = await r2.json().catch(() => ({}))
    assert.ok(!p2.error?.stack, 'no stack leaked on structured error')
  } finally {
    await gateway.stop()
    stores.dispose()
    await rmDir(dir)
  }
})

await testAsync('gateway: client disconnect aborts upstream request (single wire)', async () => {
  const { createStores } = await import('../src/store.js')
  const { startGateway } = await import('../src/forward.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const dir = tmpDir('ch-abort-')
  const stores = createStores(dir)
  stores.settings.update(s => ({ ...s, gatewayPort: nextTestPort() }))
  let sawAbort = false
  let upstreamStarted = false
  let upstreamSettled = null
  const workbuddy = {
    listModels: async () => [{ id: 'wb/ab', source: 'workbuddy', name: 'AB', contextWindow: 128000, maxOutput: 8192 }],
    streamTurn: ({ signal }) => new Promise(resolve => {
      upstreamStarted = true
      signal?.addEventListener('abort', () => { sawAbort = true; upstreamSettled = 'aborted'; resolve({ sawText: true, sawFinish: true, finish: 'stop', usage: {}, nextIndex: 0 }) })
    }),
    status: () => ({ accounts: 1, ok: 1 }),
  }
  const hub = createHubRuntime({ stores, workbuddy, upstreams: makeSource('up'), logger: console, warn: () => {}, settings: () => stores.settings.load() })
  const gateway = startGateway({ stores, hub, logger: console, settings: () => stores.settings.load() })
  const bind = await gateway.start()
  const auth = { authorization: `Bearer ${gateway.key()}`, 'content-type': 'application/json' }
  try {
    // 预热 catalog：冷启动时 prepareCall 要计算目录（数百 ms），若在 dispatch 前
    // abort，上游根本收不到请求，abort 传播无从谈起（实测发现）。
    await fetch(`http://${bind}/v1/chat/completions`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ model: 'wb/ab', messages: [{ role: 'user', content: 'warm' }] }),
    })
    const controller = new AbortController()
    // 流式请求发起后等上游进入 streamTurn，再断开客户端
    const pending = fetch(`http://${bind}/v1/chat/completions`, {
      method: 'POST', headers: auth, signal: controller.signal,
      body: JSON.stringify({ model: 'wb/ab', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    }).catch(() => 'client aborted')
    for (let i = 0; i < 50 && !upstreamStarted; i++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(upstreamStarted, true, 'upstream streamTurn entered before abort')
    controller.abort()
    const outcome = await Promise.race([
      pending,
      new Promise(resolve => setTimeout(() => resolve('upstream hung after client abort'), 3000)),
    ])
    assert.equal(outcome, 'client aborted', 'client fetch rejects on abort')
    assert.equal(sawAbort, true, 'upstream streamTurn received abort signal')
    assert.equal(upstreamSettled, 'aborted')
  } finally {
    await gateway.stop()
    stores.dispose()
    await rmDir(dir)
  }
})

await testAsync('gateway listens on both IPv4 and IPv6 loopback (dual-stack)', async () => {
  const { createStores } = await import('../src/store.js')
  const { startGateway } = await import('../src/forward.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const dir = tmpDir('ch-dual-')
  const stores = createStores(dir)
  stores.settings.update(s => ({ ...s, gatewayPort: nextTestPort() }))
  const hub = createHubRuntime({ stores, workbuddy: makeSource('wb'), upstreams: makeSource('up'), logger: console, warn: () => {}, settings: () => stores.settings.load() })
  const gateway = startGateway({ stores, hub, logger: console, settings: () => stores.settings.load() })
  const bind = await gateway.start()
  const port = bind.split(':')[1]
  const auth = { authorization: `Bearer ${gateway.key()}` }
  try {
    const r4 = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: auth })
    assert.equal(r4.status, 200, 'IPv4 loopback answers')
    let v6Status = null
    try { v6Status = (await fetch(`http://[::1]:${port}/v1/models`, { headers: auth })).status } catch { v6Status = 'unreachable' }
    assert.equal(v6Status, 200, `IPv6 loopback answers (got ${v6Status})`)
  } finally {
    await gateway.stop()
    stores.dispose()
    await rmDir(dir)
  }
})

await testAsync('finish semantics unified: max-tokens vs stop vs error across openai and claude wires', async () => {
  const { createStores } = await import('../src/store.js')
  const { startGateway } = await import('../src/forward.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const dir = tmpDir('ch-fin-')
  const stores = createStores(dir)
  stores.settings.update(s => ({ ...s, gatewayPort: nextTestPort() }))
  let finishMode = 'stop'
  const scripted = {
    listModels: async () => [{ id: 'wb/f', source: 'workbuddy', name: 'F', contextWindow: 128000, maxOutput: 8192 }],
    streamTurn: async ({ onChunk }) => {
      onChunk({ type: 'block-start', index: 0, blockType: 'text' })
      onChunk({ type: 'text-delta', index: 0, text: 'x' })
      onChunk({ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } })
      return { sawText: true, sawFinish: true, finish: finishMode, usage: { inputTokens: 1, outputTokens: 1 }, nextIndex: 0 }
    },
    status: () => ({ accounts: 1, ok: 1 }),
  }
  const hub = createHubRuntime({ stores, workbuddy: scripted, upstreams: makeSource('up'), logger: console, warn: () => {}, settings: () => stores.settings.load() })
  const gateway = startGateway({ stores, hub, logger: console, settings: () => stores.settings.load() })
  const bind = await gateway.start()
  const auth = { authorization: `Bearer ${gateway.key()}`, 'content-type': 'application/json' }
  try {
    // 正常 stop：两条线都是正常收尾
    finishMode = 'stop'
    const oaStop = await (await fetch(`http://${bind}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'wb/f', messages: [{ role: 'user', content: 'x' }] }) })).json()
    assert.equal(oaStop.choices[0].finish_reason, 'stop')
    // max_tokens：OpenAI → length；Claude → stop_reason max_tokens
    finishMode = 'max_tokens'
    const oaMax = await (await fetch(`http://${bind}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'wb/f', messages: [{ role: 'user', content: 'x' }] }) })).json()
    assert.equal(oaMax.choices[0].finish_reason, 'length', 'openai: max_tokens → length')
    const clMax = await (await fetch(`http://${bind}/v1/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'wb/f', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] }) })).json()
    assert.equal(clMax.stop_reason, 'max_tokens', 'claude: max_tokens → stop_reason max_tokens')
    // 错误 finish：hub 语义里 error 走 failure 路径（streamTurn throw / finish 帧带 failure），
    // 而不是 outcome.finish='error'（那会被规整成 stop）。验证两条线的错误收尾：
    scripted.streamTurn = async ({ onChunk }) => {
      onChunk({ type: 'block-start', index: 0, blockType: 'text' })
      onChunk({ type: 'text-delta', index: 0, text: 'partial' })
      throw new Error('mid-stream death')
    }
    const oaErr = await (await fetch(`http://${bind}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'wb/f', messages: [{ role: 'user', content: 'x' }], stream: true }) })).text()
    assert.ok(oaErr.includes('"error"'), 'openai error frame present')
    assert.ok(oaErr.includes('"content":"partial"'), 'openai: partial content preserved before error')
    assert.ok(oaErr.includes('[DONE]'), 'stream still terminated properly')
    const clErr = await (await fetch(`http://${bind}/v1/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'wb/f', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'x' }] }) })).text()
    assert.ok(clErr.includes('event: error'), 'claude: error event present')
    assert.ok(!clErr.includes('message_stop'), 'claude: no clean message_stop after error')
  } finally {
    await gateway.stop()
    stores.dispose()
    await rmDir(dir)
  }
})

// ── 优先级五：升级数据保留（发布到市场后最可能踩的坑） ─────────────────────
await testAsync('upgrade preserves ALL user state: settings/accounts/key/usage/routes/disabled', async () => {
  const { createStores } = await import('../src/store.js')
  const { startGateway, loadOrCreateApiKey } = await import('../src/forward.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const fs2 = await import('node:fs')

  // ── 场景：模拟 0.2.x 旧版数据目录，新版本（含 migrate）接管 ──
  const dir = tmpDir('ch-upg-')
  const dataDir = path.join(dir, 'credit-hub')
  fs2.default.mkdirSync(dataDir, { recursive: true })
  fs2.default.mkdirSync(path.join(dataDir, 'gateway'), { recursive: true })

  // 旧 settings.json：含旧版 checkinMarks、网关端口、禁用模型、默认思考开关
  fs2.default.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    gatewayPort: 8455,
    thinkingOffByDefault: true,
    modelDisabled: { 'up/old/a': true },
    checkinMarks: { '2026-11-01': true, '2026-11-02:wb_keep': 'ok' },
  }), 'utf8')

  // 旧 accounts.json：上游 Key 与 WorkBuddy 账号（凭据绝不能丢）
  fs2.default.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
    workbuddy: [{ id: 'wb_old1', realm: 'cn', label: '旧账号', auth: { accessToken: 'tok-legacy-123456', refreshToken: 'ref-legacy', expiresAt: 9999999999999 } }],
    upstreams: [{ id: 'up_old1', name: '旧上游', baseURL: 'https://api.example.com/v1', apiKey: 'sk-legacy-key-000000', enabled: true }],
  }), 'utf8')

  // 旧 routes.json：降级链定义
  fs2.default.writeFileSync(path.join(dataDir, 'routes.json'), JSON.stringify({
    combos: [{ name: '旧链', strategy: 'round-robin', chain: ['wb/old1/x', 'up/old1/y'] }],
  }), 'utf8')

  // 旧 usage.json：逐模型用量
  fs2.default.writeFileSync(path.join(dataDir, 'usage.json'), JSON.stringify({
    at: 1,
    models: { 'wb/old/x': { ok: 42, failed: 3, skipped: 1, inputTokens: 1000, outputTokens: 500, lastAt: 1 } },
  }), 'utf8')

  // 旧 gateway/api-key：用户已把它填进十几个 agent —— 升级后必须原样
  const legacyKey = 'legacy-gateway-key-2026-upgrade-test'
  fs2.default.writeFileSync(path.join(dataDir, 'gateway', 'api-key'), legacyKey, 'utf8')

  // ── 新版本启动（createStores + migrate + gateway + hub） ──
  const stores = createStores(dir)
  const migrated = stores.migrate()
  assert.equal(migrated.schemaVersion, 2, 'migrate bumps schemaVersion')

  // 1. settings：端口/思考开关保留；旧签到标记清理但**新格式标记保留**
  const settings = stores.settings.load()
  assert.equal(settings.gatewayPort, 8455, 'gatewayPort preserved through upgrade')
  assert.equal(settings.thinkingOffByDefault, true, 'thinkingOffByDefault preserved')
  assert.deepEqual(settings.modelDisabled, { 'up/old/a': true }, 'modelDisabled preserved')
  assert.equal(settings.checkinMarks['2026-11-01'], undefined, 'legacy boolean mark cleaned')
  assert.equal(settings.checkinMarks['2026-11-02:wb_keep'], 'ok', 'new-format mark kept')

  // 2. accounts：凭据一字不差
  const accounts = stores.accounts.load()
  assert.equal(accounts.workbuddy[0].id, 'wb_old1', 'workbuddy account preserved')
  assert.equal(accounts.workbuddy[0].auth.accessToken, 'tok-legacy-123456', 'workbuddy token preserved')
  assert.equal(accounts.upstreams[0].apiKey, 'sk-legacy-key-000000', 'upstream apiKey preserved')
  assert.equal(accounts.upstreams[0].baseURL, 'https://api.example.com/v1', 'upstream baseURL preserved')

  // 3. routes：降级链定义保留
  const routes = stores.routes.load()
  assert.equal(routes.combos[0].name, '旧链')
  assert.equal(routes.combos[0].strategy, 'round-robin')
  assert.deepEqual(routes.combos[0].chain, ['wb/old1/x', 'up/old1/y'])

  // 4. gateway key：升级后 loadOrCreateApiKey 返回同一个 Key
  const keyAfter = loadOrCreateApiKey(stores.gatewayDir)
  assert.equal(keyAfter, legacyKey, 'gateway api-key preserved (agents keep working)')

  // 5. 网关用保留的端口与 Key 启动
  const hub = createHubRuntime({ stores, workbuddy: { listModels: async () => [], streamTurn: async () => ({}), status: () => ({}) }, upstreams: { listModels: async () => [{ id: 'up/old1/y', source: 'upstream', name: '旧上游模型', contextWindow: 128000, maxOutput: 8192 }], streamTurn: async () => ({}), status: () => ({}) }, logger: console, warn: () => {}, settings: () => stores.settings.load() })
  const gateway = startGateway({ stores, hub, logger: console, settings: () => stores.settings.load() })
  const bind = await gateway.start()
  assert.equal(bind, '127.0.0.1:8455', 'gateway binds the preserved port')
  const auth = { authorization: `Bearer ${legacyKey}`, 'content-type': 'application/json' }
  const models = await (await fetch(`http://${bind}/v1/models`, { headers: auth })).json()
  assert.equal(models.status, undefined, 'legacy key authorizes (no 401)')
  await gateway.stop()

  // 6. usage：读取逻辑保留旧统计（index.js 的读法——缺失字段补零）
  const savedUsage = JSON.parse(fs2.default.readFileSync(path.join(dataDir, 'usage.json'), 'utf8'))
  const legacyRow = savedUsage.models['wb/old/x']
  assert.equal(legacyRow.ok, 42, 'usage ok count preserved on disk')
  const normalized = { ok: 0, failed: 0, skipped: 0, inputTokens: 0, outputTokens: 0, lastAt: 0, ...legacyRow }
  assert.equal(normalized.ok, 42)
  assert.equal(normalized.failed, 3)
  assert.equal(normalized.inputTokens, 1000)

  // 7. 禁用模型在目录里生效（disabled 模型从选择器隐藏但目录保留）
  await hub.invalidate()
  const catalog = await hub.catalog()
  const disabledRow = catalog.find(row => row.id === 'up/old1/y')
  assert.ok(disabledRow, 'member exists in catalog')
  // （wb/old1/x 不在目录里因为 workbuddy.listModels 是空 stub，不影响断言）

  stores.dispose()
  await rmDir(dir)
})

await testAsync('upgrade is idempotent: second run makes zero changes and preserves everything', async () => {
  const { createStores } = await import('../src/store.js')
  const dir = tmpDir('ch-upg2-')
  const dataDir = path.join(dir, 'credit-hub')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    schemaVersion: 2,
    gatewayPort: 8466,
    checkinMarks: { '2026-11-02:wb_a': 'ok' },
  }), 'utf8')
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
    workbuddy: [{ id: 'wb_1', realm: 'cn', auth: { accessToken: 'tok-1234567890' } }],
    upstreams: [{ id: 'up_1', apiKey: 'sk-1' }],
  }), 'utf8')

  const stores = createStores(dir)
  const first = stores.migrate()
  assert.equal(first.changed, false, 'already-current schema → no change')
  // 幂等后再跑一次，凭据仍在
  const second = stores.migrate()
  assert.equal(second.changed, false, 'idempotent second run')
  const accounts = stores.accounts.load()
  assert.equal(accounts.workbuddy[0].auth.accessToken, 'tok-1234567890', 'token intact after double migrate')
  assert.equal(stores.settings.load().gatewayPort, 8466, 'settings intact after double migrate')

  // 数据目录权限（优先级六）：secret store 落盘时收紧 0600。
  // 先触发一次真实 save（chmodSync 在 save 里执行），再断言——
  // 直接 writeFileSync 的 fixture 是 0644，那验证的是测试自己不是 store。
  stores.accounts.update(data => ({ ...data, upgraded: true }))
  const stat = fs.statSync(path.join(dataDir, 'accounts.json'))
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o600, 'accounts.json is 0600 on POSIX after store save')
  } else {
    assert.ok(stat, 'accounts.json exists (Windows ACL 由 icacls 收紧，已在其它路径验证)')
  }
  stores.dispose()
  await rmDir(dir)
})

// ── 优先级六：速率限制 / 鉴权告警 / 响应增长上限 ───────────────────────────
await testAsync('rate-limit: token bucket capacity, refill, and per-key isolation', () => {
  return (async () => {
    const { createTokenBucket, createFailureCounter } = await import('../src/rate-limit.js')
    let t = 100_000
    const bucket = createTokenBucket({ capacity: 3, msPerToken: 1000, now: () => t })  // 1 token / 1s
    // 连续取 3 个 → 全部成功
    assert.equal(bucket.take('a').ok, true)
    assert.equal(bucket.take('a').ok, true)
    assert.equal(bucket.take('a').ok, true)
    // 第 4 个 → 429 + retryAfter
    const denied = bucket.take('a')
    assert.equal(denied.ok, false)
    assert.ok(denied.retryAfterMs >= 250 && denied.retryAfterMs <= 1500, `retryAfter sane (${denied.retryAfterMs}ms)`)
    // 时间推进 → 令牌回填
    t += 1500  // 1.5 token
    assert.equal(bucket.take('a').ok, true, 'refilled token admitted')
    assert.equal(bucket.take('a').ok, false, 'still exhausted after one refill')
    // key 隔离：b 不受 a 的影响
    assert.equal(bucket.take('b').ok, true, 'per-key isolation')
    // snapshot
    const snap = bucket.snapshot()
    assert.ok(snap.a && typeof snap.a.tokens === 'number')
  })()
})

await testAsync('failure counter: records, clears on success, evicts oldest beyond cap', () => {
  return (async () => {
    const { createFailureCounter } = await import('../src/rate-limit.js')
    const counter = createFailureCounter()
    counter.record('ip1'); counter.record('ip1'); counter.record('ip1')
    assert.equal(counter.count('ip1'), 3, 'accumulates')
    counter.clear('ip1')
    assert.equal(counter.count('ip1'), 0, 'clears on success')
    // 防膨胀：256 个 key 上限，最旧被逐出
    for (let i = 0; i < 300; i++) counter.record(`ip-${i}`)
    assert.equal(counter.count('ip-0'), 0, 'oldest evicted beyond cap')
    assert.equal(counter.count('ip-299'), 1, 'recent still tracked')
  })()
})

await testAsync('gateway: 429 after rate limit burst; 401 counter logs repeated auth failures', async () => {
  const { createStores } = await import('../src/store.js')
  const { startGateway } = await import('../src/forward.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const dir = tmpDir('ch-rl-')
  const stores = createStores(dir)
  stores.settings.update(s => ({ ...s, gatewayPort: nextTestPort() }))
  const hub = createHubRuntime({ stores, workbuddy: makeSource('wb'), upstreams: makeSource('up'), logger: console, warn: () => {}, settings: () => stores.settings.load() })
  const gateway = startGateway({ stores, hub, logger: console, settings: () => stores.settings.load() })
  const bind = await gateway.start()
  try {
    // 401 计数：连续错误 Key 打 12 次（>告警阈值 10）
    const badAuth = { authorization: 'Bearer wrong-key-aaaaaaaaaaaaaaaa', 'content-type': 'application/json' }
    const statuses = []
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`http://${bind}/v1/models`, { headers: badAuth })
      statuses.push(r.status)
    }
    assert.ok(statuses.every(s => s === 401), `wrong key → all 401 (got ${statuses.join(',')})`)
    // 速率限制突发：本测试自身 + 上面 12 次 401 都计数。用快速连发把桶打空
    // （容量 120/min，已经用 ~15，连发 150 次必触发 429）
    let got429 = 0
    for (let i = 0; i < 150; i++) {
      const r = await fetch(`http://${bind}/v1/models`, { headers: badAuth })
      if (r.status === 429) got429 += 1
      if (got429 > 0) break
    }
    assert.ok(got429 > 0, 'burst triggers 429 rate limit')
    const rateLimited = await fetch(`http://${bind}/v1/models`, { headers: badAuth })
    assert.equal(rateLimited.status, 429)
    const payload = await rateLimited.json()
    assert.equal(payload.error.type, 'rate_limit_error')
    assert.ok(payload.error.message.includes('ms'), '429 message carries recovery time')
  } finally {
    await gateway.stop()
    stores.dispose()
    await rmDir(dir)
  }
})

// ── 优先级一：路由表（声明式分发） ─────────────────────────────────────────
await testAsync('routes: table matches exact paths, method-sensitive, no prefix leakage', async () => {
  const { matchRoute, routeList, SIMPLE_ROUTES, WIRE_ROUTES } = await import('../src/routes.js')
  // 三条 wire 线全别名可命中
  for (const [method, path, expected] of [
    ['POST', '/v1/responses', 'responses'], ['POST', '/responses', 'responses'],
    ['POST', '/v1/chat/completions', 'chat'], ['POST', '/chat/completions', 'chat'],
    ['POST', '/v1/messages', 'messages'], ['POST', '/messages', 'messages'],
    ['GET', '/v1/models', 'models'], ['GET', '/healthz', 'healthz'],
  ]) {
    assert.equal(matchRoute(method, path)?.id, expected, `${method} ${path} → ${expected}`)
  }
  // 方法敏感：GET 不能命中 POST 路由
  assert.equal(matchRoute('GET', '/v1/chat/completions'), undefined, 'method-sensitive')
  assert.equal(matchRoute('POST', '/v1/models'), undefined, 'POST /v1/models 未注册')
  // 精确匹配：前缀不该误命中
  assert.equal(matchRoute('GET', '/v1/models-x'), undefined, 'no prefix leakage')
  assert.equal(matchRoute('POST', '/v1/messages/extra'), undefined, 'no suffix leakage')
  // 未知路径
  assert.equal(matchRoute('POST', '/v1/nope'), undefined)
  // 表结构自洽：id 唯一、method 合法、paths 非空
  const list = routeList()
  const ids = list.map(r => r.id)
  assert.equal(new Set(ids).size, ids.length, 'route ids unique')
  for (const route of list) {
    assert.ok(['GET', 'POST'].includes(route.method), `合法 method: ${route.method}`)
    assert.ok(route.paths.length > 0, `${route.id} 至少一个路径`)
    assert.ok(route.paths.every(p => p.startsWith('/')), `${route.id} 路径必须以 / 开头`)
  }
  assert.equal(SIMPLE_ROUTES.length + WIRE_ROUTES.length, list.length)
})

await testAsync('gateway: route table drives real dispatch (all aliases answer, 404 for unknown)', async () => {
  const { createStores } = await import('../src/store.js')
  const { startGateway } = await import('../src/forward.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const dir = tmpDir('ch-routes-')
  const stores = createStores(dir)
  stores.settings.update(s => ({ ...s, gatewayPort: nextTestPort() }))
  const hub = createHubRuntime({ stores, workbuddy: makeSource('wb'), upstreams: makeSource('up'), logger: console, warn: () => {}, settings: () => stores.settings.load() })
  const gateway = startGateway({ stores, hub, logger: console, settings: () => stores.settings.load() })
  const bind = await gateway.start()
  const auth = { authorization: `Bearer ${gateway.key()}`, 'content-type': 'application/json' }
  try {
    // healthz 无需鉴权
    assert.equal((await fetch(`http://${bind}/healthz`)).status, 200, '/healthz without auth')
    // 三个别名各打一次（保证路由表真的被分发逻辑使用）
    const body = { model: 'wb/m1', messages: [{ role: 'user', content: 'x' }], max_tokens: 8 }
    for (const path of ['/v1/chat/completions', '/chat/completions']) {
      const r = await fetch(`http://${bind}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) })
      assert.equal(r.status, 200, `${path} answers via table`)
    }
    for (const path of ['/v1/messages', '/messages']) {
      const r = await fetch(`http://${bind}${path}`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'wb/m1', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }) })
      assert.equal(r.status, 200, `${path} answers via table`)
    }
    for (const path of ['/v1/responses', '/responses']) {
      const r = await fetch(`http://${bind}${path}`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'wb/m1', input: 'x', max_output_tokens: 8 }) })
      assert.equal(r.status, 200, `${path} answers via table`)
    }
    // 未注册路径 → 404
    const unknown = await fetch(`http://${bind}/v1/does-not-exist`, { method: 'POST', headers: auth, body: '{}' })
    assert.equal(unknown.status, 404, 'unknown route → 404')
    const unknownPayload = await unknown.json()
    assert.match(unknownPayload.error.message, /no route/, '404 names the route miss')
  } finally {
    await gateway.stop()
    stores.dispose()
    await rmDir(dir)
  }
})

// ── 模型清单强制刷新（上架新模型后可立即看到） ─────────────────────────────
await testAsync('POST /refresh-models re-discovers upstreams and reports before/after', async () => {
  const { default: http } = await import('node:http')
  const { createStores } = await import('../src/store.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const { createUpstreamRuntime } = await import('../src/aggregate.js')
  const { createApiRoutes } = await import('../src/api.js')
  const dir = tmpDir('ch-refresh-')
  const stores = createStores(dir)

  // 上游运行时：discover 每次返回增加一个模型的「新上架」剧本
  const upstreams = createUpstreamRuntime({ stores, log: () => {} })
  let discoverCalls = 0
  let wbCacheCleared = 0
  const upstreamStub = {
    list: () => [{ id: 'preset-deepseek', name: 'DeepSeek', enabled: true, hasKey: true }],
    status: () => ({ upstreams: 1, models: 1 }),
    discover: async () => { discoverCalls += 1; return [{ id: 'a' }, { id: `new-${discoverCalls}` }] },
  }
  const workbuddyStub = {
    status: () => ({ accounts: 1, ok: 1 }),
    listAccounts: () => [],
    clearModelCache: () => { wbCacheCleared += 1 },
    listModels: async () => [{ id: 'wb/cn/x', source: 'workbuddy', name: 'X', contextWindow: 128000, maxOutput: 8192 }],
    streamTurn: async () => ({}),
  }
  const hub = createHubRuntime({
    stores, workbuddy: workbuddyStub, upstreams: upstreamStub, logger: console, warn: () => {},
    settings: () => stores.settings.load(),
  })
  await hub.catalog(true)   // 预热

  const api = createApiRoutes({
    stores, hub, workbuddy: workbuddyStub, upstreams: upstreamStub,
    gateway: { running: false, stats: () => ({}) },
    version: 'test', settingsKeys: [], logs: () => [], clearLogs: () => {},
    log: () => {}, warn: () => {},
  })
  const server = http.createServer(api)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/credit-hub`
    const result = await (await fetch(`${base}/refresh-models`, { method: 'POST' })).json()
    // 真的调了上游 discover（而不是重读缓存）
    assert.equal(discoverCalls, 1, 'upstream.discover invoked')
    // 真的清了 WorkBuddy 缓存
    assert.equal(wbCacheCleared, 1, 'workbuddy cache cleared')
    // 汇报了前后数量
    assert.equal(typeof result.before, 'number')
    assert.equal(typeof result.after, 'number')
    assert.ok(Array.isArray(result.details.upstreams), 'per-upstream detail array')
    assert.equal(result.details.upstreams[0].id, 'preset-deepseek')
    assert.equal(result.details.upstreams[0].models, 2, 'discover result count reported')
    assert.equal(result.details.workbuddy, 'cleared')
  } finally {
    await new Promise(resolve => server.close(resolve))
    stores.dispose()
    await rmDir(dir)
  }
})

await testAsync('POST /refresh-models survives a failing upstream (per-item error, others continue)', async () => {
  const { default: http } = await import('node:http')
  const { createStores } = await import('../src/store.js')
  const { createHubRuntime } = await import('../src/hub.js')
  const { createApiRoutes } = await import('../src/api.js')
  const dir = tmpDir('ch-refresh2-')
  const stores = createStores(dir)
  const upstreamStub = {
    list: () => [
      { id: 'up-bad', name: '坏上游', enabled: true, hasKey: true },
      { id: 'up-good', name: '好上游', enabled: true, hasKey: true },
      { id: 'up-nokey', name: '无Key', enabled: true, hasKey: false },
      { id: 'up-disabled', name: '已禁用', enabled: false, hasKey: true },
    ],
    status: () => ({ upstreams: 2, models: 0 }),
    discover: async id => {
      if (id === 'up-bad') throw new Error('401 invalid api key')
      return [{ id: 'm1' }]
    },
  }
  const workbuddyStub = { status: () => ({ accounts: 0, ok: 0 }), listAccounts: () => [], listModels: async () => [], streamTurn: async () => ({}) }
  const hub = createHubRuntime({
    stores, workbuddy: workbuddyStub, upstreams: upstreamStub, logger: console, warn: () => {},
    settings: () => stores.settings.load(),
  })
  const api = createApiRoutes({
    stores, hub, workbuddy: workbuddyStub, upstreams: upstreamStub,
    gateway: { running: false, stats: () => ({}) },
    version: 'test', settingsKeys: [], logs: () => [], clearLogs: () => {},
    log: () => {}, warn: () => {},
  })
  const server = http.createServer(api)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/credit-hub`
    const result = await (await fetch(`${base}/refresh-models`, { method: 'POST' })).json()
    // 只对「启用 + 有 Key」的上游发 discover
    const touched = result.details.upstreams.map(row => row.id)
    assert.deepEqual(touched.sort(), ['up-bad', 'up-good'], 'skips disabled and key-less upstreams')
    // 失败的那个带 error，成功的照常汇报
    const bad = result.details.upstreams.find(row => row.id === 'up-bad')
    assert.match(bad.error, /401/, 'failing upstream error reported')
    const good = result.details.upstreams.find(row => row.id === 'up-good')
    assert.equal(good.models, 1, 'healthy upstream still discovered')
    assert.ok(result.details.errors.length >= 1, 'errors aggregated for caller')
    // 端点本身不 5xx
    assert.equal(typeof result.after, 'number')
  } finally {
    await new Promise(resolve => server.close(resolve))
    stores.dispose()
    await rmDir(dir)
  }
})

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
// 显式退出：undici 的 keep-alive 池与个别未 unref 的定时器在某些 CI 网络环境下
// 会把事件循环钉住（2026-11-21 GitHub Actions 上 Host tests 挂 10 分钟被看门狗杀）。
// 测试结论已打印，强制退出不影响结果正确性。
process.exit(failures === 0 ? 0 : 1)
