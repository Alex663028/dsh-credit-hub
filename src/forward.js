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
import { now } from './util.js'
import { CODE } from './http.js'

/** harness usage → OpenAI 线上协议字段（prompt/completion/total_tokens）。 */
const openAiUsage = usage => usage ? {
  prompt_tokens: usage.inputTokens ?? 0,
  completion_tokens: usage.outputTokens ?? 0,
  total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
  ...(usage.reasoningTokens ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {}),
  ...(usage.cacheReadTokens ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } } : {}),
} : undefined

const MAX_BODY = 32 * 1024 * 1024

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

export function startGateway({ stores, hub, logger, settings }) {
  let apiKey = loadOrCreateApiKey(stores.gatewayDir)
  let server = null
  let stats = { requests: 0, ok: 0, failed: 0, lastAt: 0 }

  const bind = () => `127.0.0.1:${currentPort()}`

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
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }))
        req.destroy()
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

  const authorized = req => {
    const header = String(req.headers.authorization ?? '')
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    return keyMatches(presented, apiKey)
  }

  // ── harness options ← external wire bodies ────────────────────────────────
  const openAiToHarness = messages => {
    const out = []
    for (const message of messages ?? []) {
      const role = message?.role
      if (role === 'system' || role === 'developer') {
        out.push({ role: 'system', content: typeof message.content === 'string' ? message.content : partsText(message.content) })
        continue
      }
      if (role === 'tool') {
        out.push({
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: String(message.tool_call_id ?? ''), content: [{ type: 'text', text: typeof message.content === 'string' ? message.content : partsText(message.content) }] }],
        })
        continue
      }
      if (role === 'assistant') {
        const blocks = []
        const text = typeof message.content === 'string' ? message.content : partsText(message.content)
        if (text) blocks.push({ type: 'text', text })
        for (const call of message.tool_calls ?? []) {
          blocks.push({ type: 'tool-call', id: String(call.id ?? ''), name: String(call.function?.name ?? ''), arguments: String(call.function?.arguments ?? '{}') })
        }
        out.push({ role: 'assistant', content: blocks, ...(typeof message.reasoning_content === 'string' ? { reasoning_content: message.reasoning_content } : {}) })
        continue
      }
      const blocks = []
      if (typeof message.content === 'string' && message.content) blocks.push({ type: 'text', text: message.content })
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text })
        else if (part?.type === 'image_url') {
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
          if (typeof url === 'string') blocks.push({ type: 'image', image: url })
        }
      }
      out.push({ role: 'user', content: blocks.length > 0 ? blocks : '' })
    }
    return out
  }

  const partsText = parts => (Array.isArray(parts) ? parts.filter(part => part?.type === 'text').map(part => part.text).join('\n') : '')

  const claudeToHarness = body => {
    const out = []
    if (typeof body.system === 'string' && body.system) out.push({ role: 'system', content: body.system })
    else if (Array.isArray(body.system)) {
      const text = body.system.filter(block => block?.type === 'text').map(block => block.text).join('\n')
      if (text) out.push({ role: 'system', content: text })
    }
    for (const message of body.messages ?? []) {
      if (message.role === 'user') {
        const blocks = []
        const results = []
        for (const block of Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }]) {
          if (block.type === 'text' && block.text) blocks.push({ type: 'text', text: block.text })
          else if (block.type === 'image' && block.source?.type === 'base64') {
            blocks.push({ type: 'image', image: `data:${block.source.media_type};base64,${block.source.data}` })
          } else if (block.type === 'tool_result') {
            const inner = Array.isArray(block.content)
              ? block.content.filter(part => part?.type === 'text').map(part => part.text).join('\n')
              : String(block.content ?? '')
            results.push({ type: 'tool-result', toolCallId: String(block.tool_use_id ?? ''), content: [{ type: 'text', text: inner }] })
          }
        }
        out.push(results.length > 0 ? { role: 'tool', content: results } : { role: 'user', content: blocks })
        continue
      }
      if (message.role === 'assistant') {
        const blocks = []
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block.type === 'text' && block.text) blocks.push({ type: 'text', text: block.text })
          else if (block.type === 'tool_use') {
            blocks.push({ type: 'tool-call', id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: JSON.stringify(block.input ?? {}) })
          }
        }
        if (blocks.length > 0) out.push({ role: 'assistant', content: blocks })
      }
    }
    return out
  }

  const harnessOptions = (body, messages, wire) => ({
    model: String(body.model ?? ''),
    messages,
    maxTokens: Number(body.max_tokens ?? body.max_completion_tokens ?? body.maxOutputTokens ?? 8192),
    ...(Number.isFinite(Number(body.temperature)) ? { temperature: Number(body.temperature) } : {}),
    ...(Array.isArray(body.stop) ? { stop: body.stop } : typeof body.stop === 'string' && body.stop ? { stop: [body.stop] } : {}),
    ...(Array.isArray(body.tools) && body.tools.length > 0 ? { tools: body.tools } : {}),
    ...(body.reasoning_effort !== undefined ? { reasoningEffort: body.reasoning_effort } : {}),
    ...(body.thinking?.effort !== undefined ? { reasoningEffort: body.thinking.effort } : {}),
    sessionId: wire === 'claude' ? String(body.metadata?.user_id ?? '') : String(body.user ?? ''),
  })

  // ── harness chunks → external SSE ─────────────────────────────────────────
  const finishToOpenAi = reason => reason?.kind === 'max-tokens' ? 'length'
    : reason?.kind === 'error' || reason?.kind === 'aborted' ? 'stop' : 'stop'

  async function streamOpenAi(res, options, model, signal) {
    const call = await hub.adapter.prepareCall(hub.route, model)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const id = `chatcmpl-${Date.now().toString(36)}`
    const frame = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
    let toolIndex = 0
    let usage = null
    let finish = 'stop'
    let openTool = null
    try {
      for await (const chunk of call.stream({ ...options, signal })) {
        if (signal.aborted) break
        if (chunk.type === 'text-delta') frame({ ...base, choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] })
        else if (chunk.type === 'reasoning-delta') frame({ ...base, choices: [{ index: 0, delta: { reasoning_content: chunk.text }, finish_reason: null }] })
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
        }
      }
      frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], ...(usage ? { usage: openAiUsage(usage) } : {}) })
      res.write('data: [DONE]\n\n')
      res.end()
      return { ok: true, usage }
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
    return { ok: !failure, usage }
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
        }
      }
      if (openKind !== null) frame({ type: 'content_block_stop', index: openIndex })
      frame({ type: 'message_delta', delta: { stop_reason: finish, stop_sequence: null }, usage: { input_tokens: usage.inputTokens ?? 0, output_tokens: usage.outputTokens ?? 0 } })
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
      usage: { input_tokens: usage?.inputTokens ?? 0, output_tokens: usage?.outputTokens ?? 0 },
      ...(failure ? { error: { message: String(failure.message ?? 'gateway error'), type: 'gateway_error' } } : {}),
    })
    return { ok: !failure, usage }
  }

  const safeParse = text => {
    try { return JSON.parse(text) } catch { return { _raw: text } }
  }

  // ── server ────────────────────────────────────────────────────────────────
  async function start() {
    if (server) return bind()
    const port = currentPort()
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const routePath = url.pathname.replace(/\/+$/, '') || '/'
      stats.requests += 1
      try {
        if (routePath === '/healthz') return send(res, 200, { ok: true })
        if (!authorized(req)) return send(res, 401, { error: { message: 'invalid gateway key', type: 'auth_error' } })
        if (req.method === 'GET' && routePath === '/v1/models') {
          const rows = await hub.catalog()
          return send(res, 200, {
            object: 'list',
            data: rows.filter(entry => entry.disabled !== true).map(entry => ({ id: entry.id, object: 'model', owned_by: 'credit-hub', created: 0 })),
          })
        }
        if (req.method === 'POST' && (routePath === '/v1/chat/completions' || routePath === '/chat/completions')) {
          const body = JSON.parse((await readBody(req)) || '{}')
          const options = harnessOptions(body, openAiToHarness(body.messages), 'openai')
          const signal = new AbortController()
          // Abort on the *response* closing early — req 'close' also fires once
          // the body has been consumed, which would kill healthy turns.
          res.on('close', () => { if (res.writableEnded !== true) signal.abort() })
          const result = body.stream === true
            ? await streamOpenAi(res, options, options.model, signal.signal)
            : await completeOpenAi(res, options, options.model, signal.signal)
          stats[result.ok ? 'ok' : 'failed'] += 1
          stats.lastAt = now()
          return
        }
        if (req.method === 'POST' && (routePath === '/v1/messages' || routePath === '/messages')) {
          const body = JSON.parse((await readBody(req)) || '{}')
          const options = harnessOptions(body, claudeToHarness(body), 'claude')
          const signal = new AbortController()
          res.on('close', () => { if (res.writableEnded !== true) signal.abort() })
          const result = body.stream === true
            ? await streamClaude(res, options, options.model, signal.signal)
            : await completeClaude(res, options, options.model, signal.signal)
          stats[result.ok ? 'ok' : 'failed'] += 1
          stats.lastAt = now()
          return
        }
        return send(res, 404, { error: { message: `no route ${req.method} ${routePath}`, type: 'not_found' } })
      } catch (error) {
        const status = error?.statusCode === 413 ? 413
          : error?.code === CODE.notFound ? 404
          : error?.code === CODE.auth ? 502
          : 500
        logger?.warn?.(`credit-hub gateway: ${error?.message ?? error}`)
        if (!res.writableEnded) send(res, status, { error: { message: String(error?.message ?? 'gateway error'), type: 'gateway_error' } })
        stats.failed += 1
      }
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
    logger?.info?.(`credit-hub: 本地网关已监听 http://${bind()}/v1`)
    return bind()
  }

  async function stop() {
    if (!server) return
    const closing = server
    server = null
    await new Promise(resolve => closing.close(() => resolve()))
  }

  return {
    start,
    stop,
    get running() { return server !== null },
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
