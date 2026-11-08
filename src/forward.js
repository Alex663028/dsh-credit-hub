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

/** hub finish 块 → Responses 线的完成 token。 */
const outcomeFinishToken = reason => reason?.kind === 'max-tokens' ? 'max_tokens'
  : reason?.kind === 'stop' ? 'stop'
  : reason?.kind ?? 'stop'

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

export function startGateway({ stores, hub, logger, settings, log }) {
  let apiKey = loadOrCreateApiKey(stores.gatewayDir)
  let servers = []
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
    if (presented && keyMatches(presented, apiKey)) return true
    // codex 系代理可能把 Key 放在 x-api-key 而非 Authorization
    return keyMatches(String(req.headers['x-api-key'] ?? ''), apiKey)
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
    let failure = null
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
          // hub 的错误收尾走 finish 块（不抛异常）——必须捕获，否则流以
          // 干净的 stop 结束、零内容，调用方只能报 "empty response"
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
            failure = chunk.reason?.failure ?? { message: chunk.reason?.kind === 'aborted' ? 'request aborted' : 'upstream error' }
          }
        }
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
      return { ok: failure === null, usage }
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
        return { ok: false, usage }
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

  // ── OpenAI Responses 线（/v1/responses，Codex wire——EKKO 等 codex 系 agent） ──
  const responsesInputToHarness = body => {
    const messages = []
    if (typeof body.instructions === 'string' && body.instructions) messages.push({ role: 'system', content: body.instructions })
    const input = body.input
    if (typeof input === 'string') {
      messages.push({ role: 'user', content: input })
      return messages
    }
    for (const item of Array.isArray(input) ? input : []) {
      if (item?.type === 'message') {
        const role = item.role === 'assistant' ? 'assistant'
          : item.role === 'system' || item.role === 'developer' ? 'system' : 'user'
        if (typeof item.content === 'string') { messages.push({ role, content: item.content }); continue }
        const blocks = []
        for (const part of Array.isArray(item.content) ? item.content : []) {
          if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') blocks.push({ type: 'text', text: String(part.text ?? '') })
          else if (part?.type === 'input_image' && typeof part.image_url === 'string') blocks.push({ type: 'image', image: part.image_url })
        }
        if (blocks.length > 0) messages.push({ role, content: blocks })
        continue
      }
      if (item?.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: [{ type: 'tool-call', id: String(item.call_id ?? item.id ?? mintId('call')), name: String(item.name ?? ''), arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) }],
        })
        continue
      }
      if (item?.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: String(item.call_id ?? ''), content: [{ type: 'text', text: String(item.output ?? '') }] }],
        })
        continue
      }
      // reasoning 等内部项不回传上游
    }
    return messages
  }

  const responsesToolsToHarness = tools => (Array.isArray(tools) ? tools : [])
    .filter(tool => tool?.type === 'function' || tool?.name)
    .map(tool => ({
      name: String(tool.name ?? ''),
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
    }))

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
      usage: {
        input_tokens: usage?.inputTokens ?? 0,
        output_tokens: usage?.outputTokens ?? 0,
        total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
      },
      ...(finishToken === 'max_tokens' && !failure ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      ...(failure ? { error: { message: String(failure.message ?? 'gateway error'), type: 'gateway_error' } } : {}),
    })
    return { ok: !failure, usage }
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
        return { ok: false, usage }
      }
      frame('response.completed', {
        type: 'response.completed',
        response: {
          id: responseId, object: 'response', status: 'completed', model, output,
          usage: { input_tokens: usage?.inputTokens ?? 0, output_tokens: usage?.outputTokens ?? 0, total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) },
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

  // ── server ────────────────────────────────────────────────────────────────
  async function start() {
    if (servers.length > 0) return bind()
    const port = currentPort()
    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const routePath = url.pathname.replace(/\/+$/, '') || '/'
      stats.requests += 1
      // 浏览器内运行的 agent（webview/页面形态）需要 CORS + 预检；桌面/CLI
      // agent 不受影响。Key 鉴权仍然照常把关。
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, anthropic-version, x-api-key, x-api-key-hash',
        'access-control-max-age': '86400',
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors)
        return res.end()
      }
      res.setHeader('access-control-allow-origin', cors['access-control-allow-origin'])
      let rawBody = ''
      try {
        if (routePath === '/healthz') return send(res, 200, { ok: true })
        const keyOk = authorized(req)
        if (!keyOk) {
          // 401 也留痕：调用方 Key 配错是最高频的接入问题
          log?.({ scope: 'gateway', level: 'warn', message: `401 ${req.method} ${routePath}（Key 不匹配，key 头前 6 位: ${String(req.headers.authorization ?? req.headers['x-api-key'] ?? '').slice(0, 12)}）` })
          return send(res, 401, { error: { message: 'invalid gateway key', type: 'auth_error' } })
        }
        if (req.method === 'POST' && routePath.startsWith('/v1/')) {
          // 请求体预览落日志：调用方接入排查的第一现场
          rawBody = await readBody(req)
          let modelPreview = ''
          try { modelPreview = String(JSON.parse(rawBody || '{}')?.model ?? '') } catch {}
          log?.({ scope: 'gateway', message: `${req.method} ${routePath} model=${modelPreview} body=${rawBody.slice(0, 300)}` })
        }
        if (req.method === 'GET' && routePath === '/v1/models') {
          const rows = await hub.catalog()
          return send(res, 200, {
            object: 'list',
            data: rows.filter(entry => entry.disabled !== true).map(entry => ({ id: entry.id, object: 'model', owned_by: 'credit-hub', created: 0 })),
          })
        }
        if (req.method === 'POST' && (routePath === '/v1/responses' || routePath === '/responses')) {
          const body = JSON.parse(rawBody || '{}')
          const tools = responsesToolsToHarness(body.tools)
          const options = {
            model: String(body.model ?? ''),
            messages: responsesInputToHarness(body),
            maxTokens: Number(body.max_output_tokens ?? body.max_tokens ?? 8192),
            ...(Number.isFinite(Number(body.temperature)) ? { temperature: Number(body.temperature) } : {}),
            ...(Array.isArray(body.stop) ? { stop: body.stop } : {}),
            ...(tools.length > 0 ? { tools } : {}),
            ...(body.reasoning?.effort !== undefined ? { reasoningEffort: body.reasoning.effort } : {}),
            sessionId: '',
          }
          const signal = new AbortController()
          res.on('close', () => { if (res.writableEnded !== true) signal.abort() })
          const result = body.stream === true
            ? await streamResponses(res, options, options.model, signal.signal)
            : await completeResponses(res, options, options.model, signal.signal)
          stats[result.ok ? 'ok' : 'failed'] += 1
          stats.lastAt = now()
          return
        }
        if (req.method === 'POST' && (routePath === '/v1/chat/completions' || routePath === '/chat/completions')) {
          const body = JSON.parse(rawBody || '{}')
          const options = harnessOptions(body, openAiToHarness(body.messages), 'openai')
          const signal = new AbortController()
          // Abort on the *response* closing early — req 'close' also fires once
          // the body has been consumed, which would kill healthy turns.
          res.on('close', () => { if (res.writableEnded !== true) signal.abort() })
          const result = body.stream === true
            ? await streamOpenAi(res, options, options.model, signal.signal)
            : await completeOpenAi(res, options, options.model, signal.signal)
          log?.({ scope: 'gateway', message: `${routePath} ${options.model} → ${result.ok ? 'ok' : `失败: ${String(result.error?.message ?? '').slice(0, 160)}`}` })
          stats[result.ok ? 'ok' : 'failed'] += 1
          stats.lastAt = now()
          return
        }
        if (req.method === 'POST' && (routePath === '/v1/messages' || routePath === '/messages')) {
          const body = JSON.parse(rawBody || '{}')
          const options = harnessOptions(body, claudeToHarness(body), 'claude')
          const signal = new AbortController()
          res.on('close', () => { if (res.writableEnded !== true) signal.abort() })
          const result = body.stream === true
            ? await streamClaude(res, options, options.model, signal.signal)
            : await completeClaude(res, options, options.model, signal.signal)
          log?.({ scope: 'gateway', message: `${routePath} ${options.model} → ${result.ok ? 'ok' : `失败: ${String(result.error?.message ?? '').slice(0, 160)}`}` })
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
        // 异常堆栈进日志页（前 6 行）——定位第三方 agent 的崩溃现场
        const stack = String(error?.stack ?? '').split('\n').slice(0, 6).join(' ⏎ ')
        log?.({ scope: 'gateway', level: 'error', message: `${req.method} ${routePath} 500: ${error?.message ?? error} ｜ ${stack}` })
        logger?.warn?.(`credit-hub gateway: ${error?.message ?? error}`)
        if (!res.writableEnded) send(res, status, { error: { message: String(error?.message ?? 'gateway error'), type: 'gateway_error', stack: String(error?.stack ?? '').split('\n').slice(0, 6) } })
        stats.failed += 1
      }
    }
    // 双栈回环：只绑 127.0.0.1 时，把 base_url 写成 localhost 的 agent 会先解析
    // 到 ::1 → ECONNREFUSED。IPv4/IPv6 两条 socket 可共用同一端口号。
    const listenOn = (host, family) => new Promise((resolve, reject) => {
      const server = http.createServer(handler)
      server.once('error', reject)
      server.listen(port, host, () => resolve(server))
    })
    const ipv4 = await listenOn('127.0.0.1', 4)
    servers.push(ipv4)
    try {
      const ipv6 = await listenOn('::1', 6)
      servers.push(ipv6)
      logger?.info?.(`credit-hub: 本地网关已监听 http://127.0.0.1:${port}/v1 与 http://[::1]:${port}/v1`)
    } catch (error) {
      logger?.info?.(`credit-hub: 本地网关 IPv6(::1) 监听不可用（${error?.message ?? error}），仅 IPv4`)
    }
    return bind()
  }

  async function stop() {
    const closing = servers
    servers = []
    await Promise.all(closing.map(server => new Promise(resolve => server.close(() => resolve()))))
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
