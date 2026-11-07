/**
 * Upstream SSE → harness chunk normalizer.
 *
 * The harness consumes an indexed-block protocol: every content block is
 * opened with `block-start`, fed deltas, closed with `block-end`; `usage` and
 * `finish` ride outside blocks. Two upstream wires are normalized here —
 * `openai-chat` (Chat Completions deltas) and `anthropic-messages` (content
 * block events) — and both funnels produce the same chunk vocabulary and the
 * same outcome summary, which is what the hub's fallback chain keys off.
 *
 * @module src/normalize.js
 */

import { mintId } from './util.js'

/**
 * @param {'openai-chat' | 'anthropic-messages'} wire
 * @param {(chunk: object) => void} emit - sink for harness chunks
 * @returns {{ feed: (data: string) => void, outcome: () => object }}
 *   `feed` takes one raw `data:` payload (JSON string); `outcome` returns the
 *   turn summary once the stream is drained.
 */
export function createNormalizer(wire, emit) {
  const state = {
    nextIndex: 0,
    // openai: key → block, so deltas for the same tool call land in one block.
    open: new Map(),
    sawText: false,
    sawToolCall: false,
    sawReasoning: false,
    sawUsage: false,
    sawFinish: false,
    usage: undefined,
    finish: undefined,
  }

  const summary = () => ({
    sawText: state.sawText,
    sawToolCall: state.sawToolCall,
    sawReasoning: state.sawReasoning,
    sawUsage: state.sawUsage,
    sawFinish: state.sawFinish,
    sawAnswer: state.sawText || state.sawToolCall,
    usage: state.usage,
    finish: state.finish,
    nextIndex: state.nextIndex,
  })

  const openBlock = kind => {
    const index = state.nextIndex++
    state.open.set(`#${index}`, { index, kind, text: '', args: '', id: kind === 'tool-call' ? mintId('toolu') : '', name: '' })
    emit({ type: 'block-start', index, blockType: kind })
    return state.open.get(`#${index}`)
  }

  const closeBlock = block => {
    if (!block) return
    state.open.delete(`#${block.index}`)
    if (block.kind === 'text' && block.text !== '') {
      emit({ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } })
    } else if (block.kind === 'reasoning' && block.text !== '') {
      emit({ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } })
    } else if (block.kind === 'tool-call') {
      emit({
        type: 'block-end', index: block.index,
        block: { type: 'tool-call', id: block.id ?? '', name: block.name ?? '', arguments: block.args === '' ? '{}' : block.args },
      })
    }
  }

  const closeAll = () => { for (const block of [...state.open.values()]) closeBlock(block) }

  const setUsage = usage => {
    if (!usage || typeof usage !== 'object') return
    const input = numberOr(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens)
    const output = numberOr(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens)
    const reasoning = numberOr(usage.reasoning_tokens ?? usage.reasoningTokens ?? usage.completion_tokens_details?.reasoning_tokens)
    const cacheRead = numberOr(usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? usage.prompt_tokens_details?.cached_tokens)
    if (input === undefined && output === undefined) return
    // Anthropic splits usage across frames (message_start → input, message_delta →
    // output); merge over the previous frame instead of replacing it.
    const previous = state.usage ?? {}
    state.usage = {
      inputTokens: input ?? previous.inputTokens ?? 0,
      outputTokens: output ?? previous.outputTokens ?? 0,
      ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
      ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    }
    state.sawUsage = true
    emit({ type: 'usage', usage: state.usage })
  }

  const setFinish = token => {
    if (state.sawFinish) return
    state.sawFinish = true
    state.finish = token
  }

  // ── openai-chat ────────────────────────────────────────────────────────────
  const feedChat = delta => {
    if (delta.usage !== undefined) setUsage(delta.usage)
    const choice = Array.isArray(delta.choices) ? delta.choices[0] : undefined
    if (!choice) return
    const piece = choice.delta ?? {}
    const reasoning = piece.reasoning_content ?? piece.reasoning
    if (typeof reasoning === 'string' && reasoning !== '') {
      let block = firstOpen('reasoning') ?? openBlock('reasoning')
      state.sawReasoning = true
      block.text += reasoning
      emit({ type: 'reasoning-delta', index: block.index, text: reasoning })
    }
    if (typeof piece.content === 'string' && piece.content !== '') {
      let block = firstOpen('text')
      if (block && state.sawToolCall && firstOpen('text') === undefined) block = undefined
      if (!block) block = openBlock('text')
      state.sawText = true
      block.text += piece.content
      emit({ type: 'text-delta', index: block.index, text: piece.content })
    }
    if (Array.isArray(piece.tool_calls)) {
      state.sawToolCall = true
      for (const call of piece.tool_calls) {
        const key = `call:${call.index ?? call.id ?? blockKeyOf(call)}`
        let block = state.open.get(key)
        if (!block) {
          block = openBlock('tool-call')
          if (call.id) block.id = call.id
          state.open.set(key, block)
        }
        const name = call.function?.name
        if (typeof name === 'string' && name) block.name = block.name ? block.name + name : name
        const argsDelta = call.function?.arguments
        if (typeof argsDelta === 'string' && argsDelta) {
          block.args += argsDelta
          emit({ type: 'tool-call-delta', index: block.index, id: block.id, name: block.name, argumentsDelta: argsDelta })
        } else if (block.name) {
          emit({ type: 'tool-call-delta', index: block.index, id: block.id, name: block.name, argumentsDelta: '' })
        }
      }
    }
    if (choice.finish_reason) {
      closeAll()
      setFinish(choice.finish_reason)
    }
  }

  // ── anthropic-messages ─────────────────────────────────────────────────────
  const feedClaude = event => {
    if (event.type === 'message_start') {
      if (event.message?.usage) setUsage(event.message.usage)
      return
    }
    if (event.type === 'content_block_start') {
      const kind = event.content_block?.type === 'thinking' ? 'reasoning'
        : event.content_block?.type === 'tool_use' ? 'tool-call' : 'text'
      const block = openBlock(kind)
      if (kind === 'tool-call') {
        state.sawToolCall = true
        if (event.content_block?.id) block.id = event.content_block.id
        if (event.content_block?.name) block.name = event.content_block.name
      }
      state.open.set(`cb:${event.index}`, block)
      return
    }
    if (event.type === 'content_block_delta') {
      const block = state.open.get(`cb:${event.index}`) ?? firstOpen('text')
      if (!block) return
      const delta = event.delta ?? {}
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        state.sawReasoning = true
        block.text += delta.thinking
        emit({ type: 'reasoning-delta', index: block.index, text: delta.thinking })
      } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        state.sawText = true
        block.text += delta.text
        emit({ type: 'text-delta', index: block.index, text: delta.text })
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        block.args += delta.partial_json
        emit({ type: 'tool-call-delta', index: block.index, id: block.id, name: block.name, argumentsDelta: delta.partial_json })
      }
      return
    }
    if (event.type === 'content_block_stop') {
      closeBlock(state.open.get(`cb:${event.index}`))
      state.open.delete(`cb:${event.index}`)
      return
    }
    if (event.type === 'message_delta') {
      if (event.usage) setUsage(event.usage)
      if (event.delta?.stop_reason) {
        closeAll()
        setFinish(event.delta.stop_reason)
      }
      return
    }
    if (event.type === 'message_stop') {
      closeAll()
      if (!state.sawFinish) setFinish('stop')
      return
    }
    if (event.type === 'error') {
      closeAll()
      setFinish('failed')
    }
  }

  const firstOpen = kind => {
    for (const block of state.open.values()) if (block.kind === kind) return block
    return undefined
  }

  const feed = data => {
    let parsed
    try { parsed = JSON.parse(data) } catch { return }
    if (!parsed || typeof parsed !== 'object') return
    if (wire === 'anthropic-messages') return feedClaude(parsed)
    return feedChat(parsed)
  }

  /**
   * Emit block-end for every still-open block. A turn that dies mid-stream
   * must not leave the harness holding unclosed blocks — this runs on the
   * error path right before the failure is handed upward.
   */
  const flushTails = () => {
    for (const block of [...state.open.values()]) closeBlock(block)
  }

  return { feed, outcome: summary, closeAll, flushTails }
}

function numberOr(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function blockKeyOf(call) {
  return String(call?.index ?? mintId('call'))
}
