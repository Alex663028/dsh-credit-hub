# 协议兼容矩阵

本表描述 8330 网关对三种上游线格式的支持程度。**结论以 `test/run.mjs` 的实际测试为准**，
不是按代码路径推断——每行末尾标注了覆盖它的测试名。

## 总览

| Wire | 流式 | 非流式 | 工具调用 | 视觉 | 推理/思考 | usage | 错误事件 |
|---|---|---|---|---|---|---|---|
| **OpenAI Chat**（`/v1/chat/completions`） | ✅ | ✅ | ✅ | ✅ | ⚠️ 部分 | ✅ | ✅ |
| **Anthropic Messages**（`/v1/messages`） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **OpenAI Responses**（`/v1/responses`） | ✅ | ✅ | ✅ | ⚠️ 待确认 | ✅ | ✅ | ✅ |

图例：✅ = 有测试覆盖并验证通过；⚠️ = 有实现但语义受限或未充分验证。

## 逐项说明

### OpenAI Chat Completions

| 能力 | 状态 | 说明 | 测试 |
|---|---|---|---|
| 流式增量 | ✅ | `text-delta` → `delta.content`；`finish_reason` 收尾 + `[DONE]` | protocol fixture |
| 非流式 | ✅ | `choices[0].message` 完整内容 + `reasoning_content` | gateway e2e |
| 工具调用 | ✅ | `tool-call-delta` 跨帧累积 → 单帧完整 `tool_calls` | transforms/openai chunk 映射 |
| 视觉 | ✅ | `image_url`（字符串或对象）→ harness image block | transforms/openai inbound |
| 推理 | ⚠️ | 映射到 `reasoning_content`（非官方字段）。厂商私有字段，客户端不一定渲染 | protocol fixture |
| usage | ✅ | `prompt_tokens/completion_tokens/total_tokens`；含 `reasoning_tokens`/`cached_tokens` 明细 | transforms/openai usage |
| 错误 | ✅ | 失败流发独立 `error` 帧，已交付内容保留 + `[DONE]` | gateway e2e |

### Anthropic Messages

| 能力 | 状态 | 说明 | 测试 |
|---|---|---|---|
| 流式事件序列 | ✅ | `message_start` → `content_block_start/delta/stop` → `message_delta` → `message_stop` | protocol fixture |
| 非流式 | ✅ | `content[]` + `stop_reason` + `usage` | gateway e2e |
| 工具调用 | ✅ | `tool_use` 块 + `input_json_delta` 拼接成完整 JSON | protocol fixture |
| 视觉 | ✅ | `image` + base64 source → data URL | transforms/claude inbound |
| 推理 | ✅ | `thinking_delta`（`content_block.type = thinking`） | protocol fixture |
| usage | ✅ | 挂在 `message_delta` 的 `usage` 字段 | protocol fixture |
| 错误 | ✅ | `event: error`（协议原生），**不发** `message_stop` | gateway e2e |
| 块索引 | ✅ | 每块递增、不复用（`content_block_start.index` 唯一有序） | protocol fixture |

### OpenAI Responses（Codex wire）

| 能力 | 状态 | 说明 | 测试 |
|---|---|---|---|
| 流式事件序列 | ✅ | `response.created` → `output_item.added` → delta → `output_item.done` → `response.completed` | protocol fixture |
| 非流式 | ✅ | `output[]` + `status` + `usage` | gateway e2e |
| 工具调用 | ✅ | `function_call` item；`function_call_arguments.delta/done` | protocol fixture |
| 视觉 | ⚠️ | `input_image` 入站已支持；**出站图像尚未验证** | — |
| 推理 item 生命周期 | ✅ | `added` → `reasoning_summary_text.delta` → `.done` → `output_item.done` | protocol fixture |
| usage | ✅ | `response.completed` 的 `usage.{input,output,total}_tokens` | protocol fixture |
| 错误 | ✅ | `response.failed`（协议原生） | 代码路径（待补测试） |
| 文本收尾 | ⚠️ | 用 `content_part.done` + `output_item.done`，**非**官方 `output_text.done` 事件名 | protocol fixture |

## 已知差异（不是 bug，是取舍）

1. **OpenAI 的 `reasoning_content`**：官方 Chat Completions 没有推理字段，这是社区约定（DeepSeek/vLLM 系都用它）。客户端不认就静默忽略，不会崩。
2. **Responses 的 `content_part.done`**：本网关用这个事件收尾文本块。按 OpenAI 官方事件名状态机实现的客户端可能等不到 `output_text.done`——但 codex-proxy 链路（本网关的主要消费方）实测正常。
3. **错误帧位置**：OpenAI 线把 `error` 塞进最后一个 chunk 对象（多数客户端当 APIError 抛）；Anthropic/Responses 用协议原生的 `event: error` / `response.failed`。

## 内部 chunk 形状（一致性锚点）

三个转换器消费的都是同一套 harness chunk：

```
text-delta        { type, text }
reasoning-delta   { type, text }
tool-call-delta   { type, index, id?, name?, argumentsDelta? }
block-start       { type, index, blockType }
block-end         { type, index, block: { type: 'text'|'tool-call'|'reasoning', ... } }
usage             { type, usage: { inputTokens, outputTokens, ... } }
finish            { type, reason: { kind: 'stop'|'max-tokens'|'error'|'aborted', failure? } }
```

`test/run.mjs` 里的 `scriptedUpstream` 产生这份形状，一份剧本驱动三条线断言——
新增协议适配器时应当复用同一剧本，而不是另写一套 mock。

## 如何为新协议补支持

1. 在 `src/transforms/` 加一个模块：入站解析 + chunk → 线事件映射（纯函数）
2. 在 `src/forward.js` 加路由：`streamXxx` / `completeXxx`（流控 + res 写出）
3. 在 `test/run.mjs` 的 protocol fixture 里追加该线断言（复用同一个 `scriptedUpstream`）
4. 更新本矩阵表格