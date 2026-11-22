/**
 * 本地统一网关 — OpenAI 与 Anthropic 兼容的对外入口。
 *
 * 外部客户端（Claude Code / Codex / Cherry Studio / curl / 局域网工具）用
 * base URL + 网关 Key 调 `credit-hub` 车道上的全部模型。仅绑定回环地址；
 * 密钥落 `{dataDir}/gateway/api-key`（0600）。/v1/messages 做 Anthropic
 * 形态的双向转换，/v1/chat/completions 做 OpenAI 形态。
 *
 * @module src/forward.js
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { mintKey, keyMatches } from './store.js'
import { now, mintId } from './util.js'
import { CODE } from './http.js'
import { createTokenBucket, createFailureCounter } from './rate-limit.js'
import { matchRoute, routeList } from './routes.js'
import { openAiToHarness, openAiUsage, finishToOpenAi, openAiChunkFrames, partsText } from './transforms/openai.js'
import { claudeToHarness, claudeUsage } from './transforms/claude.js'
import { outcomeFinishToken, responsesInputToHarness, responsesToolsToHarness, responsesUsage } from './transforms/responses.js'

const MAX_BODY = 32 * 1024 * 1024

/** 统一 clamp：调用方传 NaN / 负数 / 超大值时不会把上游打崩。 */
export const clampMaxTokens = value => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 8192
  return Math.min(Math.floor(n), 200000)
}

export function loadOrCreateApiKey(gatewayDir) {
  fs.mkdirSync(gatewayDir, { recursive: true, mode: 0o700 })
  const file = path.join(gatewayDir, 'api-key')
  try {
    const present = fs.readFileSync(file, 'utf8').trim()
    if (/^[A-Za-z0-9_-]{16,80}$/.test(present)) return present
  } catch {}
  const key = mintKey()
  saveApiKey(gatewayDir, key)
  return key
}

/** 用户自定义网关 Key：16-80 位字母数字/-/_，0600 原子写。 */
export function saveApiKey(gatewayDir, key) {
  if (typeof key !== 'string' || /^[A-Za-z0-9_-]{16,80}$/.test(key) === false) {
    throw new Error('Key 需为 16-80 位字母数字（含 - _）')
  }
  fs.mkdirSync(gatewayDir, { recursive: true, mode: 0o700 })
  const file = path.join(gatewayDir, 'api-key')
  const temp = path.join(gatewayDir, `.api-key.${process.pid}.tmp`)
  const fd = fs.openSync(temp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, key)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  fs.renameSync(temp, file)
  try { fs.chmodSync(file, 0o600) } catch {}
  return key
}

export function startGateway({ stores, hub, logger, settings, log }) {
  let apiKey = loadOrCreateApiKey(stores.gatewayDir)
  let servers = []
  let stats = { requests: 0, ok: 0, failed: 0, lastAt: 0, rateLimited: 0 }
  let starting = null
  let boundPort = null
  // 速率限制（优先级六）：120 突发容量，每 500ms 回填 1 个（≈2 req/s 持续速率）。
  // 内存态，重启复位。msPerToken 语义：回填 1 个令牌需要的毫秒数。
  const rateLimit = createTokenBucket({ capacity: 120, msPerToken: 500 })
  // 鉴权失败计数：10/50 次打告警，成功后清零
  const authFailures = createFailureCounter()

  const bind = () => `127.0.0.1:${boundPort ?? currentPort()}`

  const currentPort = () => {
    const value = Number(settings().gatewayPort)
    return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : 8330
  }

  const readBody = req => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        // 不要 destroy：响应还没发出去，先把剩余数据排空再让上层回 413
        req.resume()
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

  const send = (res, status, payload) => {
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  /** 每请求 trace-id（清单 #11）：响应头可查，日志关联。客户端自带的 x-request-id 优先。 */
  const traceOf = req => String(req.headers['x-request-id'] ?? '').replace(/[^\w.-]/g, '').slice(0, 64) || mintId('trc')

  const authorized = req => {
    // codex 系代理送 Key 的姿势五花八门：Authorization: Bearer、x-api-key、
    // api-key、双 Bearer 前缀、?key= 查询参数——全部兼容，值匹配即放行
    const candidates = []
    const authHeader = String(req.headers.authorization ?? '').trim()
    candidates.push(authHeader)
    if (authHeader.toLowerCase().startsWith('bearer ')) candidates.push(authHeader.slice(7).trim())
    candidates.push(String(req.headers['x-api-key'] ?? '').trim())
    candidates.push(String(req.headers['api-key'] ?? '').trim())
    // ?key= 默认关闭：Key 会留在 URL / 浏览器历史 / Referer 里。需要兼容旧客户端
    // 时在设置里显式开 allowQueryKey。
    if (settings().allowQueryKey === true) {
      try {
        candidates.push(new URL(req.url ?? '/', 'http://localhost').searchParams.get('key') ?? '')
      } catch {}
    }
    for (const candidate of candidates) {
      const value = candidate.replace(/^bearer\s+/i, '').trim()
      if (value && keyMatches(value, apiKey)) return true
    }
    return false
  }

  // ── harness options ← external wire bodies（转换器在 src/transforms/） ─────
  const harnessOptions = (body, messages, wire) => ({
    model: String(body.model ?? ''),
    messages,
    maxTokens: clampMaxTokens(body.max_tokens ?? body.max_completion_tokens ?? body.maxOutputTokens ?? 8192),
    ...(Number.isFinite(Number(body.temperature)) ? { temperature: Number(body.temperature) } : {}),
    ...(Array.isArray(body.stop) ? { stop: body.stop } : typeof body.stop === 'string' && body.stop ? { stop: [body.stop] } : {}),
    ...(Array.isArray(body.tools) && body.tools.length > 0 ? { tools: body.tools } : {}),
    ...(body.reasoning_effort !== undefined ? { reasoningEffort: body.reasoning_effort } : {}),
    ...(body.thinking?.effort !== undefined ? { reasoningEffort: body.thinking.effort } : {}),
    sessionId: wire === 'claude' ? String(body.metadata?.user_id ?? '') : String(body.user ?? ''),
  })

  // ── harness chunks → external SSE（finishToOpenAi 在 transforms/openai.js） ─

  async function streamOpenAi(res, options, model, signal) {
    const call = await hub.adapter.prepareCall(hub.route, model)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const id = `chatcmpl-${Date.now().toString(36)}`
    // 响应增长上限（优先级六）：默认 64MB/请求。失控上游吐无限内容时
    // 在客户端侧截断，而不是任由内存与带宽被吃光。截断以 error 帧收尾。
    const RESPONSE_CAP = 64 * 1024 * 1024
    let responseBytes = 0
    const frame = payload => {
      const encoded = `data: ${JSON.stringify(payload)}\n\n`
      responseBytes += Buffer.byteLength(encoded)
      if (responseBytes > RESPONSE_CAP) return false
      res.write(encoded)
      return true
    }
    const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
    let toolIndex = 0
    let usage = null
    let finish = 'stop'
    let failure = null
    let openTool = null
    try {
      let responseCapped = false
      for await (const chunk of call.stream({ ...options, signal })) {
        if (signal.aborted) break
        if (chunk.type === 'text-delta') { if (frame({ ...base, choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] }) === false) { responseCapped = true; break } }
        else if (chunk.type === 'reasoning-delta') { if (frame({ ...base, choices: [{ index: 0, delta: { reasoning_content: chunk.text }, finish_reason: null }] }) === false) { responseCapped = true; break } }
        else if (chunk.type === 'tool-call-delta') {
          openTool = openTool ?? { index: toolIndex, id: chunk.id, name: chunk.name ?? '', args: '' }
          if (chunk.id) openTool.id = chunk.id
          if (chunk.name) openTool.name = chunk.name
          openTool.args += chunk.argumentsDelta ?? ''
        } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
          const entry = openTool ?? { index: toolIndex, id: chunk.block.id, name: chunk.block.name, args: '' }
          entry.id = entry.id || chunk.block.id
          entry.name = entry.name || chunk.block.name
          entry.args = entry.args || chunk.block.arguments
          frame({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: entry.index, id: entry.id, type: 'function', function: { name: entry.name, arguments: entry.args } }] }, finish_reason: null }] })
          toolIndex += 1
          openTool = null
        } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
          // whole-block text already streamed as deltas; nothing to do
        } else if (chunk.type === 'usage') {
          usage = chunk.usage
        } else if (chunk.type === 'finish') {
          finish = finishToOpenAi(chunk.reason)
          // hub 的错误收尾走 finish 块（不抛异常）——必须捕获，否则流以
          // 干净的 stop 结束、零内容，调用方只能报 "empty response"
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
            failure = chunk.reason?.failure ?? { message: chunk.reason?.kind === 'aborted' ? 'request aborted' : 'upstream error' }
          }
        }
      }
      if (responseCapped && failure === null) {
        failure = { message: `响应超过 ${Math.round(RESPONSE_CAP / 1024 / 1024)}MB 上限，已截断`, code: 'RESPONSE_CAP' }
      }
      if (failure !== null) {
        // 失败流：以 OpenAI 惯例的独立 error 帧终止（多数客户端会把它当
        // APIError 抛出），已交付的部分内容仍带 stop 收尾
        frame({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: finish }],
          ...(usage ? { usage: openAiUsage(usage) } : {}),
          error: { message: String(failure.message ?? 'upstream error'), type: 'gateway_error', code: failure.code },
        })
      } else {
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], ...(usage ? { usage: openAiUsage(usage) } : {}) })
      }
      res.write('data: [DONE]\n\n')
      res.end()
      return { ok: failure === null, usage, error: failure ?? undefined }
    } catch (error) {
      // 不伪造成功收尾：错误对象并入最终帧；已交付的部分内容仍以 stop 收尾
      frame({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        ...(usage ? { usage: openAiUsage(usage) } : {}),
        error: { message: String(error?.message ?? 'gateway error'), type: 'gateway_error' },
      })
      res.write('data: [DONE]\n\n')
      res.end()
      return { ok: false, error }
    }
  }

  async function completeOpenAi(res, options, model, signal) {
    const call = await hub.adapter.prepareCall(hub.route, model)
    let text = ''
    let reasoning = ''
    const toolCalls = []
    let usage = null
    let finish = 'stop'
    let failure
    try {
      for await (const chunk of call.stream({ ...options, signal })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
        else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
          toolCalls.push({ id: chunk.block.id, type: 'function', function: { name: chunk.block.name, arguments: chunk.block.arguments } })
        } else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') {
          finish = finishToOpenAi(chunk.reason)
          if (chunk.reason?.kind === 'error') failure = chunk.reason.failure
        }
      }
    } catch (error) {
      failure = failure ?? { message: String(error?.message ?? 'gateway error') }
    }
    const message = { role: 'assistant', content: text || null }
    if (reasoning) message.reasoning_content = reasoning
    if (toolCalls.length > 0) message.tool_calls = toolCalls
    // 部分成功也必须把失败带出去：error 对象始终随响应返回
    const empty = text === '' && toolCalls.length === 0
    send(res, failure && empty ? 502 : 200, {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: finish }],
      ...(usage ? { usage: openAiUsage(usage) } : {}),
      ...(failure ? { error: { message: String(failure.message ?? 'gateway error'), type: 'gateway_error' } } : {}),
    })
    return { ok: !failure, usage, error: failure ?? undefined }
  }

  async function streamClaude(res, options, model, signal) {
    const call = await hub.adapter.prepareCall(hub.route, model)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const frame = payload => res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`)
    let nextIndex = 0
    let openIndex = null
    let usage = { inputTokens: 0, outputTokens: 0 }
    let finish = 'end_turn'
    let failure = null
    let openKind = null
    frame({ type: 'message_start', message: { id: `msg_${Date.now().toString(36)}`, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 0, output_tokens: 0 } } })
    try {
      for await (const chunk of call.stream({ ...options, signal })) {
        if (signal.aborted) break
        if (chunk.type === 'text-delta') {
          if (openKind !== 'text') {
            if (openKind !== null) frame({ type: 'content_block_stop', index: openIndex })
            openIndex = nextIndex
            nextIndex += 1
            frame({ type: 'content_block_start', index: openIndex, content_block: { type: 'text', text: '' } })
            openKind = 'text'
          }
          frame({ type: 'content_block_delta', index: openIndex, delta: { type: 'text_delta', text: chunk.text } })
        } else if (chunk.type === 'reasoning-delta') {
          if (openKind !== 'thinking') {
            if (openKind !== null) frame({ type: 'content_block_stop', index: openIndex })
            openIndex = nextIndex
            nextIndex += 1
            frame({ type: 'content_block_start', index: openIndex, content_block: { type: 'thinking', thinking: '' } })
            openKind = 'thinking'
          }
          frame({ type: 'content_block_delta', index: openIndex, delta: { type: 'thinking_delta', thinking: chunk.text } })
        } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
          if (openKind !== null) frame({ type: 'content_block_stop', index: openIndex })
          const toolIndex = nextIndex
          nextIndex += 1
          frame({ type: 'content_block_start', index: toolIndex, content_block: { type: 'tool_use', id: chunk.block.id, name: chunk.block.name } })
          frame({ type: 'content_block_delta', index: toolIndex, delta: { type: 'input_json_delta', partial_json: chunk.block.arguments } })
          frame({ type: 'content_block_stop', index: toolIndex })
          openKind = null
          openIndex = null
        } else if (chunk.type === 'usage') {
          usage = chunk.usage
        } else if (chunk.type === 'finish') {
          finish = chunk.reason?.kind === 'max-tokens' ? 'max_tokens' : 'end_turn'
          // 错误收尾必须以 error 事件终止（Anthropic 协议），不能装作正常结束
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
            failure = chunk.reason?.failure ?? { message: chunk.reason?.kind === 'aborted' ? 'request aborted' : 'upstream error' }
          }
        }
      }
      if (failure !== null) {
        frame({ type: 'error', error: { type: 'api_error', message: String(failure.message ?? 'upstream error') } })
        res.end()
        return { ok: false, usage, error: failure }
      }
      if (openKind !== null) frame({ type: 'content_block_stop', index: openIndex })
      frame({ type: 'message_delta', delta: { stop_reason: finish, stop_sequence: null }, usage: claudeUsage(usage) })
      frame({ type: 'message_stop' })
      res.end()
      return { ok: true, usage }
    } catch (error) {
      frame({ type: 'error', error: { type: 'api_error', message: String(error?.message ?? 'gateway error') } })
      res.end()
      return { ok: false, error }
    }
  }

  async function completeClaude(res, options, model, signal) {
    const call = await hub.adapter.prepareCall(hub.route, model)
    const content = []
    let text = ''
    let usage = null
    let finish = 'end_turn'
    let failure
    try {
      for await (const chunk of call.stream({ ...options, signal })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
          if (text) { content.push({ type: 'text', text }); text = '' }
          content.push({ type: 'tool_use', id: chunk.block.id, name: chunk.block.name, input: safeParse(chunk.block.arguments) })
        } else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') {
          finish = chunk.reason?.kind === 'max-tokens' ? 'max_tokens' : 'end_turn'
          if (chunk.reason?.kind === 'error') failure = chunk.reason.failure
        }
      }
    } catch (error) {
      failure = failure ?? { message: String(error?.message ?? 'gateway error') }
    }
    if (text || content.length === 0) content.push({ type: 'text', text })
    const empty = content.length === 1 && content[0].type === 'text' && content[0].text === ''
    send(res, failure && empty ? 502 : 200, {
      id: `msg_${Date.now().toString(36)}`,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: finish,
      usage: claudeUsage(usage),
      ...(failure ? { error: { message: String(failure.message ?? 'gateway error'), type: 'gateway_error' } } : {}),
    })
    return { ok: !failure, usage, error: failure ?? undefined }
  }

  const safeParse = text => {
    try { return JSON.parse(text) } catch { return { _raw: text } }
  }

  // ── OpenAI Responses 线（/v1/responses，Codex wire——EKKO 等 codex 系 agent）──
  // 入站/工具/usage 转换在 transforms/responses.js；流式状态机在此。

  async function completeResponses(res, options, model, signal) {
    const call = await hub.adapter.prepareCall(hub.route, model)
    let text = ''
    let reasoning = ''
    const calls = []
    let usage = null
    let failure = null
    let finishToken = 'stop'
    try {
      for await (const chunk of call.stream({ ...options, signal })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
        else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
          calls.push({ id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments })
        } else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish') {
          finishToken = outcomeFinishToken(chunk.reason)
          if (chunk.reason?.kind === 'error') failure = chunk.reason.failure
        }
      }
    } catch (error) {
      failure = failure ?? { message: String(error?.message ?? 'gateway error') }
    }
    const output = []
    if (reasoning) output.push({ type: 'reasoning', id: `rs_${Date.now().toString(36)}`, summary: [] })
    for (const callEntry of calls) {
      output.push({ type: 'function_call', id: callEntry.id || mintId('fc'), call_id: callEntry.id, name: callEntry.name, arguments: callEntry.arguments })
    }
    output.push({ type: 'message', role: 'assistant', id: `msg_${Date.now().toString(36)}`, content: [{ type: 'output_text', text, annotations: [] }] })
    const empty = text === '' && calls.length === 0
    send(res, failure && empty ? 502 : 200, {
      id: `resp_${Date.now().toString(36)}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: failure ? 'failed' : 'completed',
      model,
      output,
      usage: responsesUsage(usage),
      ...(finishToken === 'max_tokens' && !failure ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      ...(failure ? { error: { message: String(failure.message ?? 'gateway error'), type: 'gateway_error' } } : {}),
    })
    return { ok: !failure, usage, error: failure ?? undefined }
  }

  async function streamResponses(res, options, model, signal) {
    const call = await hub.adapter.prepareCall(hub.route, model)
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    const responseId = `resp_${Date.now().toString(36)}`
    const frame = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    let outputIndex = 0
    const output = []
    let usage = null
    let failure = null
    let finishToken = 'completed'
    frame('response.created', { type: 'response.created', response: { id: responseId, object: 'response', status: 'in_progress', model, output: [] } })
    let messageItemId = null
    let openTool = null
    let currentText = ''
    let reasoningItemId = null
    let reasoningText = ''
    const openMessage = () => {
      if (messageItemId !== null) return
      closeReasoning()
      messageItemId = `msg_${Date.now().toString(36)}${outputIndex}`
      frame('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { type: 'message', role: 'assistant', id: messageItemId, content: [] } })
      frame('response.content_part.added', { type: 'response.content_part.added', item_id: messageItemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    }
    const closeMessage = () => {
      if (messageItemId === null) return
      frame('response.content_part.done', { type: 'response.content_part.done', item_id: messageItemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: currentText, annotations: [] } })
      frame('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { type: 'message', role: 'assistant', id: messageItemId, content: [{ type: 'output_text', text: currentText, annotations: [] }] } })
      output.push({ type: 'message', role: 'assistant', id: messageItemId, content: [{ type: 'output_text', text: currentText, annotations: [] }] })
      outputIndex += 1
      messageItemId = null
      currentText = ''
    }
    const emitToolCall = block => {
      closeMessage()
      const callId = block.id || mintId('fc')
      frame('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { type: 'function_call', id: callId, call_id: callId, name: block.name, arguments: '' } })
      frame('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: callId, output_index: outputIndex, delta: block.arguments })
      frame('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: callId, output_index: outputIndex, arguments: block.arguments })
      frame('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { type: 'function_call', id: callId, call_id: callId, name: block.name, arguments: block.arguments } })
      output.push({ type: 'function_call', id: callId, call_id: callId, name: block.name, arguments: block.arguments })
      outputIndex += 1
    }
    const closeReasoning = () => {
      if (reasoningItemId === null) return
      frame('response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', item_id: reasoningItemId, summary_index: 0, text: reasoningText })
      frame('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { type: 'reasoning', id: reasoningItemId, summary: [{ type: 'summary_text', text: reasoningText }] } })
      output.push({ type: 'reasoning', id: reasoningItemId, summary: [{ type: 'summary_text', text: reasoningText }] })
      outputIndex += 1
      reasoningItemId = null
      reasoningText = ''
    }
    try {
      for await (const chunk of call.stream({ ...options, signal })) {
        if (signal.aborted) break
        if (chunk.type === 'text-delta') {
          openMessage()
          currentText += chunk.text
          frame('response.output_text.delta', { type: 'response.output_text.delta', item_id: messageItemId, output_index: outputIndex, content_index: 0, delta: chunk.text })
        } else if (chunk.type === 'reasoning-delta') {
          // Codex 线：推理增量挂在**已声明**的 reasoning item 上——
          // 未声明就发 delta 会让按事件状态机处理的客户端崩在未知 item 上
          if (reasoningItemId === null) {
            closeMessage()
            reasoningItemId = `rs_${Date.now().toString(36)}${outputIndex}`
            frame('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { type: 'reasoning', id: reasoningItemId, summary: [] } })
            frame('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', item_id: reasoningItemId, summary_index: 0, part: { type: 'summary_text', text: '' } })
          }
          reasoningText += chunk.text
          frame('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: reasoningItemId, summary_index: 0, delta: chunk.text })
        } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
          closeReasoning()
          emitToolCall(chunk.block)
        } else if (chunk.type === 'usage') {
          usage = chunk.usage
        } else if (chunk.type === 'finish') {
          finishToken = outcomeFinishToken(chunk.reason)
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
            failure = chunk.reason?.failure ?? { message: chunk.reason?.kind === 'aborted' ? 'request aborted' : 'upstream error' }
          }
        }
      }
      closeReasoning()
      closeMessage()
      if (failure !== null) {
        frame('response.failed', { type: 'response.failed', response: { id: responseId, object: 'response', status: 'failed', model, output, error: { message: String(failure.message ?? 'upstream error'), type: 'gateway_error' } } })
        res.end()
        return { ok: false, usage, error: failure }
      }
      frame('response.completed', {
        type: 'response.completed',
        response: {
          id: responseId, object: 'response', status: 'completed', model, output,
          usage: responsesUsage(usage),
          ...(finishToken === 'max_tokens' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        },
      })
      res.end()
      return { ok: true, usage }
    } catch (error) {
      frame('response.failed', { type: 'response.failed', response: { id: responseId, object: 'response', status: 'failed', model, output, error: { message: String(error?.message ?? 'gateway error'), type: 'gateway_error' } } })
      res.end()
      return { ok: false, error }
    }
  }

  // ── wire 路由处理器注册表（优先级一：路由表 + 处理器分离） ────────────────
  // route.id → { build(body, traceId) → harnessOptions, stream, complete }
  // 新增协议线：routes.js 加一行 + 此处加一项，分发逻辑无需改动。
  const WIRE_HANDLERS = {
    responses: {
      build: (body, traceId) => {
        const tools = responsesToolsToHarness(body.tools)
        return {
          model: String(body.model ?? ''),
          messages: responsesInputToHarness(body),
          maxTokens: clampMaxTokens(body.max_output_tokens ?? body.max_tokens ?? 8192),
          ...(Number.isFinite(Number(body.temperature)) ? { temperature: Number(body.temperature) } : {}),
          ...(Array.isArray(body.stop) ? { stop: body.stop } : {}),
          ...(tools.length > 0 ? { tools } : {}),
          ...(body.reasoning?.effort !== undefined ? { reasoningEffort: body.reasoning.effort } : {}),
          sessionId: '',
          traceId,
        }
      },
      stream: streamResponses,
      complete: completeResponses,
    },
    chat: {
      build: (body, traceId) => ({ ...harnessOptions(body, openAiToHarness(body.messages), 'openai'), traceId }),
      stream: streamOpenAi,
      complete: completeOpenAi,
    },
    messages: {
      build: (body, traceId) => ({ ...harnessOptions(body, claudeToHarness(body), 'claude'), traceId }),
      stream: streamClaude,
      complete: completeClaude,
    },
  }

  // ── server ────────────────────────────────────────────────────────────────
  async function doStart() {
    const port = currentPort()
    const handle = async (req, res) => {
      let routePath = '/'
      // try 必须包住 URL 解析与 setHeader：旧版这两处在 try 之外，抛错即成
      // unhandledRejection → host 退出。
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        routePath = url.pathname.replace(/\/+$/, '') || '/'
        stats.requests += 1
        // CORS 只放行回环来源：旧版 `*` + 无鉴权管理面等于把网关 Key 交给任意网页
        const origin = String(req.headers.origin ?? '')
        // Electron / file:// 页面的 Origin 常是 `null`：本地页面放行并回显，
        // 但 http(s) 跨站来源一律拒绝，不再无条件 `*`。
        const localOrigin = origin === '' || origin === 'null' || /^file:\/\//i.test(origin)
          || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)
        const crossSite = origin !== '' && !localOrigin
        const allowOrigin = origin === '' ? null : (localOrigin ? origin : null)
        const cors = {
          ...(allowOrigin ? { 'access-control-allow-origin': allowOrigin } : {}),
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type, anthropic-version, x-api-key, x-api-key-hash',
          'access-control-max-age': '86400',
          vary: 'Origin',
        }
        if (req.method === 'OPTIONS') {
          if (crossSite) return send(res, 403, { error: 'cross-origin not allowed' })
          res.writeHead(204, cors)
          return res.end()
        }
        if (allowOrigin) res.setHeader('access-control-allow-origin', allowOrigin)
        let rawBody = ''
        if (routePath === '/healthz') return send(res, 200, { ok: true })
        // ── 速率限制（优先级六）：令牌桶，按客户端 IP 计数 ──────────────────
        // 网关只绑回环，正常场景不会触发；防的是失控 agent 死循环重试与
        // 本机其它用户的进程狂打。401 也计数（防 Key 暴力枚举）。
        const clientIp = String(req.socket?.remoteAddress ?? 'local')
        const burst = rateLimit.take(clientIp)
        if (!burst.ok) {
          stats.failed += 1
          stats.rateLimited += 1
          log?.({ scope: 'gateway', level: 'warn', message: `429 ${req.method} ${routePath}（速率超限 ip=${clientIp} 余 ${burst.retryAfterMs}ms 恢复）` })
          return send(res, 429, {
            error: { message: `rate limited — ${burst.retryAfterMs}ms 后恢复`, type: 'rate_limit_error' },
          })
        }
        const keyOk = authorized(req)
        if (!keyOk) {
          // 401 也留痕：调用方 Key 配错是最高频的接入问题
          // 不再把 Key 头前缀写进日志；也不再鼓励把 Key 放进 URL
          authFailures.record(clientIp)
          const failCount = authFailures.count(clientIp)
          if (failCount === 10 || failCount === 50) {
            logger?.warn?.(`credit-hub: 鉴权连续失败 ${failCount} 次（ip=${clientIp}）——可能有 agent 在用错误 Key 重试或本机进程在枚举`)
          }
          log?.({ scope: 'gateway', level: 'warn', message: `401 ${req.method} ${routePath}（Key 不匹配，ip=${clientIp} 第 ${failCount} 次）` })
          return send(res, 401, { error: { message: 'invalid gateway key — 请把网关页显示的 Key 填入 Authorization: Bearer 或 x-api-key 请求头', type: 'auth_error' } })
        }
        authFailures.clear(clientIp)
        // trace 头统一在此下发：所有路由（GET/POST）都可由响应头回查 trace-id
        const requestTraceId = traceOf(req)
        res.setHeader('x-credit-hub-trace', requestTraceId)

        // ── 路由表分发（优先级一）──────────────────────────────────────────
        const route = matchRoute(req.method, routePath)
        if (route === undefined) {
          return send(res, 404, { error: { message: `no route ${req.method} ${routePath}`, type: 'not_found' } })
        }

        // wire 路由：先读体、记元数据、拦非法 JSON（客户端错误不该变 500）
        if (route.id !== 'healthz' && route.id !== 'models') {
          rawBody = await readBody(req)
          // 只记元数据，绝不把请求体（system prompt / 对话内容）写进日志
          let modelPreview = ''
          let bytes = 0
          let messageCount = 0
          try {
            const parsed = JSON.parse(rawBody || '{}')
            modelPreview = String(parsed?.model ?? '')
            bytes = Buffer.byteLength(rawBody)
            messageCount = Array.isArray(parsed?.messages) ? parsed.messages.length
              : Array.isArray(parsed?.input) ? parsed.input.length : 0
          } catch {}
          log?.({ scope: 'gateway', message: `${req.method} ${routePath} model=${modelPreview} bytes=${bytes} messages=${messageCount}` })
          try { JSON.parse(rawBody || '{}') } catch (error) {
            stats.failed += 1
            return send(res, 400, { error: { message: `invalid JSON body: ${String(error.message).slice(0, 120)}`, type: 'invalid_request_error' } })
          }
        }

        if (route.id === 'healthz') return send(res, 200, { ok: true })

        if (route.id === 'models') {
          const rows = await hub.catalog()
          return send(res, 200, {
            object: 'list',
            data: rows.filter(entry => entry.disabled !== true).map(entry => ({ id: entry.id, object: 'model', owned_by: 'credit-hub', created: 0 })),
          })
        }

        // wire 路由共用同一套流程：解析体 → build options → AbortController
        // → stream/complete → 结果日志 + 统计。三条线只有 build 与处理器不同。
        const handler = WIRE_HANDLERS[route.id]
        if (handler === undefined) {
          return send(res, 500, { error: { message: `route ${route.id} 未注册处理器`, type: 'gateway_error' } })
        }
        const body = JSON.parse(rawBody || '{}')
        const options = handler.build(body, requestTraceId)
        const signal = new AbortController()
        // 只监听 *响应* 提前关闭：req 'close' 在请求体读完后也会触发，
        // 用它会把健康的回合一起掐掉。
        res.on('close', () => { if (res.writableEnded !== true) signal.abort() })
        const result = body.stream === true
          ? await handler.stream(res, options, options.model, signal.signal)
          : await handler.complete(res, options, options.model, signal.signal)
        const resultError = result.ok ? null : (result.error ?? { message: 'upstream failed without error details' })
        log?.({ scope: 'gateway', message: `${routePath} ${options.model} → ${result.ok ? 'ok' : `失败: ${String(resultError.message ?? JSON.stringify(resultError)).slice(0, 160)}`}` })
        stats[result.ok ? 'ok' : 'failed'] += 1
        stats.lastAt = now()
        return
      } catch (error) {
        const status = error?.statusCode === 413 ? 413
          : error?.code === CODE.notFound ? 404
          : error?.code === CODE.auth ? 502
          : 500
        // 异常堆栈只进日志（前 6 行）——定位第三方 agent 的崩溃现场；
        // **响应体不回传堆栈**（优先级六：内部路径不该暴露给调用方）
        const stack = String(error?.stack ?? '').split('\n').slice(0, 6).join(' ⏎ ')
        log?.({ scope: 'gateway', level: 'error', message: `${req.method} ${routePath} ${status}: ${error?.message ?? error} ｜ ${stack}` })
        logger?.warn?.(`credit-hub gateway: ${error?.message ?? error}`)
        if (!res.writableEnded) send(res, status, { error: { message: String(error?.message ?? 'gateway error'), type: 'gateway_error' } })
        stats.failed += 1
      }
    }
    // http.createServer 不消费 async 返回的 promise —— 必须显式 catch，
    // 否则任何漏网异常都变成 unhandledRejection 带崩 host。
    const handler = (req, res) => {
      void handle(req, res).catch(error => {
        logger?.warn?.(`credit-hub gateway: 未捕获的处理器异常：${error?.message ?? error}`)
        log?.({ scope: 'gateway', level: 'error', message: `unhandled handler error: ${error?.message ?? error}` })
        if (!res.writableEnded) send(res, 500, { error: { message: 'internal gateway error', type: 'gateway_error' } })
      })
    }
    // 双栈回环：只绑 127.0.0.1 时，把 base_url 写成 localhost 的 agent 会先解析
    // 到 ::1 → ECONNREFUSED。IPv4/IPv6 两条 socket 可共用同一端口号。
    const listenOn = (host, family) => new Promise((resolve, reject) => {
      const server = http.createServer(handler)
      const onListenError = error => {
        try { server.close() } catch {}
        reject(error)
      }
      server.once('error', onListenError)
      server.listen(port, host, () => {
        server.removeListener('error', onListenError)
        // 常驻兜底：旧版 once 被消费后，第二次运行期 error 没有监听器 →
        // 未捕获 'error' 事件直接退出进程。
        server.on('error', error => {
          logger?.warn?.(`credit-hub: 网关 server error：${error?.message ?? error}`)
          log?.({ scope: 'gateway', level: 'error', message: `server error: ${error?.message ?? error}` })
        })
        resolve(server)
      })
    })
    const ipv4 = await listenOn('127.0.0.1', 4)
    servers.push(ipv4)
    boundPort = port
    try {
      const ipv6 = await listenOn('::1', 6)
      servers.push(ipv6)
      logger?.info?.(`credit-hub: 本地网关已监听 http://127.0.0.1:${port}/v1 与 http://[::1]:${port}/v1`)
    } catch (error) {
      logger?.info?.(`credit-hub: 本地网关 IPv6(::1) 监听不可用（${error?.message ?? error}），仅 IPv4`)
    }
    return bind()
  }

  /** 单飞：boot effect / 保存设置 / restart 并发触发时只 listen 一次。 */
  async function start() {
    if (servers.length > 0) return bind()
    if (starting) return starting
    starting = doStart().finally(() => { starting = null })
    return starting
  }

  async function stop() {
    const closing = servers
    servers = []
    boundPort = null
    if (starting) { try { await starting } catch {} }
    await Promise.all(closing.map(server => new Promise(resolve => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      // 活跃 SSE 长连接会让 server.close() 永不回调 → 先强制断连 + 1.5s 兜底超时
      try { server.closeAllConnections?.() } catch {}
      try { server.close(finish) } catch { finish() }
      setTimeout(finish, 1500).unref?.()
    })))
  }

  return {
    start,
    stop,
    get running() { return servers.length > 0 },
    key: () => apiKey,
    async setKey(newKey) {
      saveApiKey(stores.gatewayDir, newKey)
      apiKey = newKey
      logger?.info?.('credit-hub: 网关 Key 已更新（立即生效，无需重启）')
      return apiKey
    },
    bind,
    stats: () => ({ ...stats }),
  }
}
