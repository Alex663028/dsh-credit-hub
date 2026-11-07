/**
 * Harness messages → upstream wire shapes.
 *
 * The harness hands over `{role, content}` messages whose content is a string
 * or a block array (`text` / `image` / `tool-call` / `tool-result`), plus flat
 * tool defs. Two projections are provided: OpenAI Chat Completions and
 * Anthropic Messages. Deliberately minimal — vision travels only when the
 * image block already carries a data URL; everything else degrades to a
 * recorded warning instead of a broken request.
 *
 * @module src/wire.js
 */

const IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const blocksOf = content => Array.isArray(content) ? content.filter(Boolean)
  : typeof content === 'string' && content ? [{ type: 'text', text: content }] : []

const textOf = blocks => blocks
  .filter(block => block?.type === 'text' && typeof block.text === 'string')
  .map(block => block.text)
  .join('\n')

/** Tool results ride inside any message as `tool-result` blocks. */
function toolResultsOf(message) {
  if (message?.role !== 'tool' && message?.role !== 'user') return []
  const results = []
  for (const block of blocksOf(message.content)) {
    if (block?.type !== 'tool-result') continue
    results.push({
      callId: String(block.toolCallId ?? block.callId ?? ''),
      content: Array.isArray(block.content) ? block.content : [{ type: 'text', text: String(block.content ?? '') }],
    })
  }
  return results
}

const imageDataUrl = block => {
  const url = typeof block?.image === 'string' ? block.image : block?.url
  return typeof url === 'string' && url.startsWith('data:') ? url : undefined
}

/** Harness tool defs (flat or OpenAI-wrapped) → Chat `tools` array. */
export function toChatTools(tools) {
  const list = []
  for (const tool of tools ?? []) {
    const source = tool && typeof tool.function === 'object' && tool.function !== null ? tool.function : tool
    const name = String(source?.name ?? '').trim()
    if (!name) continue
    const parameters = source.parameters && typeof source.parameters === 'object' ? source.parameters : { type: 'object', properties: {} }
    list.push({ type: 'function', function: { name, description: typeof source.description === 'string' ? source.description : '', parameters } })
  }
  return list
}

/** Harness tool defs → Anthropic `tools` array. */
export function toClaudeTools(tools) {
  return toChatTools(tools).map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }))
}

/**
 * → Chat Completions messages. Tool results become `role:'tool'` rows placed
 * before the following user turn; images only when already a data URL.
 */
export function toChatMessages(messages, warnings = []) {
  const out = []
  const followUp = []
  const flush = () => { if (followUp.length > 0) out.push({ role: 'user', content: followUp.splice(0) }) }
  for (const message of messages ?? []) {
    const results = toolResultsOf(message)
    if (results.length === 0) flush()
    let blocks = blocksOf(message.content)
    for (const result of results) {
      const images = []
      for (const block of result.content) {
        if (block?.type !== 'image') continue
        const url = imageDataUrl(block)
        if (url !== undefined) images.push({ type: 'image_url', image_url: { url } })
        else warnings.push('image-dropped')
      }
      const text = textOf(result.content)
      out.push({ role: 'tool', tool_call_id: result.callId, content: text || (images.length > 0 ? '(see attached image)' : '(no output)') })
      if (images.length > 0) {
        followUp.push({ type: 'text', text: `The result of tool call ${result.callId} is ${images.length} image(s), attached below.` }, ...images)
      }
    }
    blocks = blocks.filter(block => block?.type !== 'tool-result')
    switch (message.role) {
      case 'system':
      case 'developer': {
        const text = textOf(blocks)
        if (text) out.push({ role: 'system', content: text })
        break
      }
      case 'user': {
        const parts = []
        for (const block of blocks) {
          if (block?.type === 'text' && block.text) parts.push({ type: 'text', text: block.text })
          else if (block?.type === 'image') {
            const url = imageDataUrl(block)
            if (url !== undefined) parts.push({ type: 'image_url', image_url: { url } })
            else warnings.push('image-dropped')
          }
        }
        if (parts.length === 0) {
          const fallback = textOf(blocks)
          if (fallback) out.push({ role: 'user', content: fallback })
          break
        }
        if (results.length > 0) followUp.push(...parts)
        else out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts })
        break
      }
      case 'assistant': {
        const text = textOf(blocks)
        const calls = blocks
          .filter(block => block?.type === 'tool-call')
          .map(block => ({
            id: String(block.id ?? ''),
            type: 'function',
            function: { name: String(block.name ?? ''), arguments: typeof block.arguments === 'string' ? block.arguments : '{}' },
          }))
        if (!text && calls.length === 0) break
        const entry = { role: 'assistant', content: text || null }
        if (typeof message.reasoning_content === 'string') entry.reasoning_content = message.reasoning_content
        if (calls.length > 0) entry.tool_calls = calls
        out.push(entry)
        break
      }
      default: break
    }
  }
  flush()
  return out
}

/**
 * → Anthropic Messages. System text hoists to the top-level `system` field;
 * tool results become user `tool_result` blocks; consecutive same-role turns
 * merge (the wire rejects consecutive user turns).
 */
export function toClaudeMessages(messages, warnings = []) {
  const out = []
  let systemText = ''
  const push = (role, blocks) => {
    const previous = out[out.length - 1]
    if (previous?.role === role) previous.content.push(...blocks)
    else out.push({ role, content: [...blocks] })
  }
  for (const message of messages ?? []) {
    const results = toolResultsOf(message)
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(blocksOf(message.content))
      if (text) systemText = systemText ? `${systemText}\n\n${text}` : text
      continue
    }
    if (results.length > 0) {
      const lead = []
      for (const result of results) {
        const inner = []
        for (const block of result.content) {
          if (block?.type === 'text' && block.text) inner.push({ type: 'text', text: block.text })
          else if (block?.type === 'image') {
            const url = imageDataUrl(block)
            const media = typeof url === 'string' ? url.slice(5, url.indexOf(';')) : undefined
            if (url !== undefined && IMAGE_MEDIA.has(media)) {
              inner.push({ type: 'image', source: { type: 'base64', media_type: media, data: url.slice(url.indexOf(',') + 1) } })
            } else warnings.push('image-dropped')
          }
        }
        lead.push({ type: 'tool_result', tool_use_id: result.callId, content: inner.length > 0 ? inner : [{ type: 'text', text: '(no output)' }] })
      }
      push('user', lead)
      continue
    }
    const blocks = blocksOf(message.content).filter(block => block?.type !== 'tool-result')
    if (message.role === 'assistant') {
      const inner = []
      const text = textOf(blocks)
      if (text) inner.push({ type: 'text', text })
      for (const block of blocks) {
        if (block?.type !== 'tool-call') continue
        inner.push({ type: 'tool_use', id: String(block.id ?? ''), name: String(block.name ?? ''), input: safeJson(block.arguments) })
      }
      if (inner.length > 0) push('assistant', inner)
      continue
    }
    if (message.role === 'user') {
      const inner = []
      for (const block of blocks) {
        if (block?.type === 'text' && block.text) inner.push({ type: 'text', text: block.text })
        else if (block?.type === 'image') {
          const url = imageDataUrl(block)
          const media = typeof url === 'string' ? url.slice(5, url.indexOf(';')) : undefined
          if (url !== undefined && IMAGE_MEDIA.has(media)) {
            inner.push({ type: 'image', source: { type: 'base64', media_type: media, data: url.slice(url.indexOf(',') + 1) } })
          } else warnings.push('image-dropped')
        }
      }
      if (inner.length > 0) push('user', inner)
    }
  }
  return { messages: out, system: systemText === '' ? undefined : systemText }
}

function safeJson(text) {
  if (typeof text !== 'string' || text === '') return {}
  try { return JSON.parse(text) } catch { return { _raw: text } }
}

/**
 * WorkBuddy 出站前的 body 修正（对齐 workbuddy2api 的 PrepareBodyOpt）：
 * tool_choice 必须是字符串、developer→system、max_completion_tokens→max_tokens、
 * 强制 stream + stream_options.include_usage。
 */
export function repairWorkbuddyBody(body) {
  if (typeof body.max_completion_tokens === 'number' && body.max_tokens === undefined) {
    body.max_tokens = body.max_completion_tokens
  }
  delete body.max_completion_tokens
  if (typeof body.tool_choice === 'object' && body.tool_choice !== null) {
    const name = body.tool_choice?.function?.name ?? body.tool_choice?.name
    body.tool_choice = typeof name === 'string' && name ? name : 'auto'
  }
  if (body.tool_choice === 'none') body.tools = undefined
  body.stream = true
  if (body.stream_options === undefined) body.stream_options = { include_usage: true }
  return body
}
