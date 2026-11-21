/**
 * OpenAI Chat Completions 线转换器（入站解析 + 出站 chunk 映射）。
 *
 * 从 forward.js 拆出（第三阶段模块化）。纯函数/纯映射：不碰网络、不持有状态，
 * streamOpenAi/completeOpenAi 的流控与 res 写出仍留在 forward.js。
 *
 * @module src/transforms/openai.js
 */

/** parts 数组 → 纯文本（system/assistant 字符串化的共用件）。 */
export const partsText = parts => (Array.isArray(parts) ? parts.filter(part => part?.type === 'text').map(part => part.text).join('\n') : '')

/** harness usage → OpenAI 线上协议字段（prompt/completion/total_tokens）。 */
export const openAiUsage = usage => usage ? {
  prompt_tokens: usage.inputTokens ?? 0,
  completion_tokens: usage.outputTokens ?? 0,
  total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
  ...(usage.reasoningTokens ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {}),
  ...(usage.cacheReadTokens ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } } : {}),
} : undefined

/** hub finish 块 → OpenAI finish_reason。错误/中止按惯例收 stop（错误另走 error 帧）。 */
export const finishToOpenAi = reason => reason?.kind === 'max-tokens' ? 'length' : 'stop'

/** OpenAI messages → harness 消息（system/developer/tool/assistant/user 全形态）。 */
export const openAiToHarness = messages => {
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

/**
 * 单个 harness chunk → OpenAI SSE 帧数组（多数块零帧或一帧）。
 * openTool 由调用方持有（跨 chunk 的 tool-call 累积状态），本模块只做映射。
 */
export const openAiChunkFrames = (chunk, { base, openTool }) => {
  if (chunk.type === 'text-delta') {
    return { frames: [{ ...base, choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] }], openTool }
  }
  if (chunk.type === 'reasoning-delta') {
    return { frames: [{ ...base, choices: [{ index: 0, delta: { reasoning_content: chunk.text }, finish_reason: null }] }], openTool }
  }
  if (chunk.type === 'tool-call-delta') {
    const entry = openTool ?? { index: 0, id: chunk.id, name: chunk.name ?? '', args: '' }
    if (chunk.id) entry.id = chunk.id
    if (chunk.name) entry.name = chunk.name
    entry.args += chunk.argumentsDelta ?? ''
    return { frames: [], openTool: entry }
  }
  if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
    const entry = openTool ?? { index: 0, id: chunk.block.id, name: chunk.block.name, args: '' }
    entry.id = entry.id || chunk.block.id
    entry.name = entry.name || chunk.block.name
    entry.args = entry.args || chunk.block.arguments
    return {
      frames: [{ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: entry.index, id: entry.id, type: 'function', function: { name: entry.name, arguments: entry.args } }] }, finish_reason: null }] }],
      openTool: null,
      consumedToolIndex: true,
    }
  }
  return { frames: [], openTool }
}
