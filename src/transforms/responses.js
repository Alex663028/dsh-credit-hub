/**
 * OpenAI Responses 线转换器（/v1/responses，Codex wire）。
 *
 * 从 forward.js 拆出（第三阶段模块化）。入站解析为纯函数；流式状态机
 * （outputIndex 推进、openMessage/closeReasoning 互斥）由调用方驱动，本模块
 * 提供入站转换与工具/完成映射。
 *
 * @module src/transforms/responses.js
 */

import { mintId } from '../util.js'

/** hub finish 块 → Responses 完成 token（completed 场景下的语义标记）。 */
export const outcomeFinishToken = reason => reason?.kind === 'max-tokens' ? 'max_tokens'
  : reason?.kind === 'stop' ? 'stop'
  : reason?.kind ?? 'stop'

/** Responses body.input → harness 消息（instructions 抽 system；message/function_call/function_call_output 全形态）。 */
export const responsesInputToHarness = body => {
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

/** Responses tools → harness 工具定义（过滤非 function；缺省参数补空 schema）。 */
export const responsesToolsToHarness = tools => (Array.isArray(tools) ? tools : [])
  .filter(tool => tool?.type === 'function' || tool?.name)
  .map(tool => ({
    name: String(tool.name ?? ''),
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
  }))

/** harness usage → Responses 线 usage 字段。 */
export const responsesUsage = usage => ({
  input_tokens: usage?.inputTokens ?? 0,
  output_tokens: usage?.outputTokens ?? 0,
  total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
})
