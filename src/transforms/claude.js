/**
 * Anthropic Messages 线转换器（入站解析 + 出站 chunk 映射）。
 *
 * 从 forward.js 拆出（第三阶段模块化）。纯函数：streamClaude/completeClaude
 * 的流控、res 写出与 openIndex/openKind 状态机仍留在 forward.js——本模块
 * 提供「单块映射」与入站解析，块索引推进由调用方完成。
 *
 * @module src/transforms/claude.js
 */

/** Anthropic body → harness 消息。system 抽前；user 混合内容（文本+tool_result）拆两条。 */
export const claudeToHarness = body => {
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
      // 混合内容（同一条 user 消息里既有文本又有 tool_result）必须两条都保留，
      // 旧版二选一会把普通文本静默丢掉。
      if (results.length > 0 && blocks.length > 0) {
        out.push({ role: 'user', content: blocks })
        out.push({ role: 'tool', content: results })
      } else {
        out.push(results.length > 0 ? { role: 'tool', content: results } : { role: 'user', content: blocks })
      }
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

/**
 * 单个 harness chunk → Anthropic SSE 块描述（不产出完整帧；帧由调用方按
 * 状态机组装，因为块开关需要 openIndex/openKind 上下文）。
 * 返回 null = 无需动作；否则 { action, kind, delta?, block? }。
 */
export const claudeChunkAction = chunk => {
  if (chunk.type === 'text-delta') return { action: 'delta', kind: 'text', delta: { type: 'text_delta', text: chunk.text } }
  if (chunk.type === 'reasoning-delta') return { action: 'delta', kind: 'thinking', delta: { type: 'thinking_delta', thinking: chunk.text } }
  if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
    return { action: 'tool-block', block: chunk.block }
  }
  return null
}

/** harness usage → Anthropic message_delta 的 usage 字段。 */
export const claudeUsage = usage => ({
  input_tokens: usage?.inputTokens ?? 0,
  output_tokens: usage?.outputTokens ?? 0,
})
