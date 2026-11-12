/**
 * 聚合上游 — 自填官方 API / 任意 OpenAI 兼容中转。
 *
 * 一条上游 = { baseURL, apiKey, kind, models[] }。kind 决定线格式：
 * `openai-chat`（绝大多数官方 API 与中转站）或 `anthropic-messages`。
 * 内置注册表只是填 Key 的预设（baseURL + 默认模型清单），不做任何账号逻辑；
 * Key 只写本机 0600 的 accounts.json，管理接口只回显 hasKey 与指纹。
 *
 * @module src/aggregate.js
 */

import { postSse, getJson, UpstreamError, CODE } from './http.js'
import { createNormalizer } from './normalize.js'
import { toChatMessages, toClaudeMessages, toChatTools, toClaudeTools } from './wire.js'
import { mintId, now, clamp } from './util.js'

/** thinking budget 降级告警去重（同一上游 + 同一组合只报一次）。 */
const budgetWarned = new Set()

/** 填 Key 预设。baseURL 一律带到版本段（…/v1）。models 留空则靠“发现模型”。 */
export const BUILTIN_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek 开放平台', baseURL: 'https://api.deepseek.com/v1', kind: 'openai-chat',
    models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 131072, maxOutput: 8192 },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextWindow: 131072, maxOutput: 65536, reasoning: true }] },
  { id: 'zai', name: 'Z.ai（智谱开放平台）', baseURL: 'https://api.z.ai/api/paas/v4', kind: 'openai-chat',
    models: [{ id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 1048576, maxOutput: 131072, reasoning: true }] },
  { id: 'moonshot', name: 'Kimi 开放平台', baseURL: 'https://api.moonshot.cn/v1', kind: 'openai-chat',
    models: [{ id: 'kimi-k3', name: 'Kimi K3', contextWindow: 262144, maxOutput: 65536 }] },
  { id: 'minimax', name: 'MiniMax 开放平台', baseURL: 'https://api.minimaxi.com/v1', kind: 'openai-chat',
    models: [{ id: 'MiniMax-M3.1', name: 'MiniMax M3.1', contextWindow: 202000, maxOutput: 131072, reasoning: true }] },
  { id: 'siliconflow', name: 'SiliconFlow 硅基流动', baseURL: 'https://api.siliconflow.cn/v1', kind: 'openai-chat', models: [] },
  { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', kind: 'openai-chat', models: [] },
  { id: 'dashscope', name: '阿里云百炼（Qwen）', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', kind: 'openai-chat',
    models: [{ id: 'qwen4-max', name: 'Qwen4 Max', contextWindow: 262144, maxOutput: 65536 }] },
  { id: 'stepfun', name: '阶跃星辰', baseURL: 'https://api.stepfun.com/v1', kind: 'openai-chat', models: [] },
  { id: 'anthropic', name: 'Anthropic 官方', baseURL: 'https://api.anthropic.com/v1', kind: 'anthropic-messages',
    models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000, maxOutput: 64000, reasoning: true }] },
  { id: 'sensenova', name: '商汤日日新 SenseNova', baseURL: 'https://api.sensenova.cn/compatible-mode/v1', kind: 'openai-chat', models: [] },
  { id: 'ark', name: '火山方舟（豆包 Seed）', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', kind: 'openai-chat', models: [] },
  { id: 'qianfan', name: '百度千帆（文心/DeepSeek）', baseURL: 'https://qianfan.baidubce.com/v2', kind: 'openai-chat', models: [] },
  { id: 'modelscope', name: '魔搭 API-Inference', baseURL: 'https://api-inference.modelscope.cn/v1', kind: 'openai-chat', models: [] },
]

const fingerprint = key => typeof key === 'string' && key.length >= 8 ? `…${key.slice(-4)}` : undefined

export function createUpstreamRuntime({ stores, log }) {
  const read = () => {
    const data = stores.accounts.load()
    if (!Array.isArray(data.upstreams)) data.upstreams = []
    return data.upstreams
  }
  const write = list => stores.accounts.update(data => ({ ...data, upstreams: list }))

  const publicView = entry => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    baseURL: entry.baseURL,
    enabled: entry.enabled !== false,
    builtin: entry.builtin === true,
    hasKey: typeof entry.apiKey === 'string' && entry.apiKey.length > 0,
    keyFingerprint: fingerprint(entry.apiKey),
    modelCount: Array.isArray(entry.models) ? entry.models.length : 0,
    models: entry.models ?? [],
    lastError: entry.lastError,
  })

  function upsert(input) {
    const list = read()
    const kind = input.kind === 'anthropic-messages' ? 'anthropic-messages' : 'openai-chat'
    const baseURL = String(input.baseURL ?? '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(baseURL)) throw new UpstreamError('baseURL 必须是 http(s) 地址', CODE.client)
    let entry = list.find(row => row.id === input.id)
    if (!entry) {
      entry = { id: input.id?.startsWith('up-') ? input.id : mintId('up'), builtin: false }
      list.push(entry)
    }
    entry.name = String(input.name ?? entry.name ?? '自定义中转').slice(0, 80)
    entry.kind = kind
    entry.baseURL = baseURL
    if (typeof input.apiKey === 'string') entry.apiKey = input.apiKey.trim()
    if (Array.isArray(input.models)) entry.models = input.models.map(row => ({
      id: String(row.id ?? '').trim(),
      name: String(row.name ?? row.id ?? '').trim(),
      contextWindow: Number.isFinite(row.contextWindow) ? row.contextWindow : 128000,
      maxOutput: Number.isFinite(row.maxOutput) ? row.maxOutput : 16384,
      vision: row.vision === true,
      reasoning: row.reasoning === true,
      efforts: Array.isArray(row.efforts) ? row.efforts : undefined,
    })).filter(row => row.id)
    entry.enabled = input.enabled !== false
    write(list)
    return publicView(entry)
  }

  /** Install a preset row once (keeps the user's key if re-run). */
  function installPreset(presetId) {
    const preset = BUILTIN_PRESETS.find(row => row.id === presetId)
    if (!preset) throw new UpstreamError('未知预设', CODE.notFound)
    const list = read()
    let entry = list.find(row => row.id === `preset-${preset.id}`)
    if (!entry) {
      entry = { id: `preset-${preset.id}`, builtin: true, models: structuredClone(preset.models) }
      list.push(entry)
    }
    entry.name = preset.name
    entry.kind = preset.kind
    entry.baseURL = preset.baseURL
    if (!Array.isArray(entry.models) || entry.models.length === 0) entry.models = structuredClone(preset.models)
    write(list)
    return publicView(entry)
  }

  function remove(id) {
    write(read().filter(row => row.id !== id))
  }

  function setEnabled(id, enabled) {
    const list = read()
    const entry = list.find(row => row.id === id)
    if (!entry) throw new UpstreamError('上游不存在', CODE.notFound)
    entry.enabled = enabled === true
    write(list)
  }

  function headersOf(entry) {
    if (entry.kind === 'anthropic-messages') {
      return {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-api-key': entry.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      }
    }
    return {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${entry.apiKey ?? ''}`,
    }
  }

  /** List models from the upstream's own /models endpoint (no generation spent). */
  async function discover(id) {
    const entry = read().find(row => row.id === id)
    if (!entry) throw new UpstreamError('上游不存在', CODE.notFound)
    const headers = entry.kind === 'anthropic-messages'
      ? { 'x-api-key': entry.apiKey ?? '', 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${entry.apiKey ?? ''}` }
    const body = await getJson(`${entry.baseURL}/models`, { headers })
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
    const previous = new Map((entry.models ?? []).map(model => [model.id, model]))
    const found = rows.map(row => {
      const id = String(row.id ?? row.name ?? '')
      if (!id) return null
      const prior = previous.get(id)
      return {
        id,
        // 手工填过的元数据（名称/窗口/视觉/思考）优先于发现结果
        ...(prior ?? {}),
        name: prior?.name && prior.name !== id ? prior.name : String(row?.name ?? row?.display_name ?? id),
        contextWindow: prior?.contextWindow ?? (Number.isFinite(row.context_length) ? row.context_length : 128000),
        maxOutput: prior?.maxOutput ?? (Number.isFinite(row.max_output_tokens) ? row.max_output_tokens : 16384),
      }
    }).filter(Boolean)
    entry.models = found
    entry.lastError = undefined
    write(read())
    return found
  }

  async function listModels() {
    const out = []
    for (const entry of read()) {
      if (entry.enabled === false || typeof entry.apiKey !== 'string' || entry.apiKey === '') continue
      for (const model of entry.models ?? []) {
        out.push({
          id: `up/${entry.id}/${model.id}`,
          source: 'upstream',
          upstreamId: entry.id,
          upstreamName: entry.name,
          modelId: model.id,
          wire: entry.kind,
          name: model.name || model.id,
          contextWindow: model.contextWindow ?? 128000,
          maxOutput: model.maxOutput ?? 16384,
          vision: model.vision === true,
          reasoning: model.reasoning === true,
          efforts: model.efforts,
          description: `${model.name || model.id} · ${entry.name}`,
        })
      }
    }
    return out
  }

  async function streamTurn({ modelId, options, signal, onChunk }) {
    const [, upstreamId, ...rest] = modelId.split('/')
    const bare = rest.join('/')
    const entry = read().find(row => row.id === upstreamId)
    if (!entry) throw new UpstreamError(`上游 ${upstreamId} 不存在`, CODE.notFound)
    if (typeof entry.apiKey !== 'string' || entry.apiKey === '') throw new UpstreamError(`上游 ${entry.name} 未填 API Key`, CODE.auth)
    const wire = entry.kind
    const warnings = []
    let body
    if (wire === 'anthropic-messages') {
      const shaped = toClaudeMessages(options.messages, warnings)
      const maxTokens = clamp(options.maxTokens ?? 8192, 256, 128000)
      body = {
        model: bare,
        messages: shaped.messages,
        stream: true,
        max_tokens: maxTokens,
        ...(shaped.system !== undefined ? { system: shaped.system } : {}),
        ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
      }
      // 扩展思考映射：reasoningEffort → thinking.budget_tokens（协议要求
      // max_tokens > budget_tokens，装不下就静默关闭而不是发一个必 400 的请求）
      if (options.reasoningEffort !== undefined && options.reasoningEffort !== 'off') {
        const budgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 65536 }
        const requested = budgets[String(options.reasoningEffort)] ?? 8192
        const budget = Math.min(requested, maxTokens - 1024)
        if (budget >= 1024) {
          body.thinking = { type: 'enabled', budget_tokens: budget }
        } else {
          // 旧版静默关闭思考：调用方以为开了 thinking，实际没有，且日志里查不到
          const reason = `${entry.id ?? bare}:${requested}:${maxTokens}`
          if (!budgetWarned.has(reason)) {
            budgetWarned.add(reason)
            log?.({ scope: 'upstream', level: 'warn', message: `credit-hub: ${entry.name} thinking budget ${requested} 装不下 max_tokens=${maxTokens}，本次不启用扩展思考` })
          }
        }
      }
      const tools = toClaudeTools(options.tools)
      if (tools.length > 0) body.tools = tools
    } else {
      body = {
        model: bare,
        messages: toChatMessages(options.messages, warnings),
        stream: true,
        max_tokens: clamp(options.maxTokens ?? 8192, 256, 262144),
        ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
        ...(Array.isArray(options.stop) && options.stop.length > 0 ? { stop: options.stop } : {}),
      }
      const tools = toChatTools(options.tools)
      if (tools.length > 0) body.tools = tools
      if (options.reasoningEffort !== undefined && options.reasoningEffort !== 'off') {
        body.reasoning_effort = String(options.reasoningEffort)
      }
    }
    const url = `${entry.baseURL}${wire === 'anthropic-messages' ? '/messages' : '/chat/completions'}`
    // 429 有限重试（最多 2 次）。重试前重建 normalizer，且只有上游一个事件都没吐过
    // 才允许重试 —— 否则重放会让客户端收到重复文本。
    let normalizer = createNormalizer(wire, onChunk)
    let sawEvent = false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) throw new UpstreamError('request aborted', CODE.transport)
      try {
        await postSse(url, {
          headers: headersOf(entry),
          body,
          signal,
          onEvent: data => { sawEvent = true; normalizer.feed(data) },
        })
        break
      } catch (error) {
        try { normalizer.flushTails() } catch {}
        const rateLimited = error?.rateLimited === true || Number(error?.status) === 429
        if (!rateLimited || sawEvent || attempt === 2 || signal?.aborted) throw error
        const wait = Math.min(Math.max(Number(error?.retryAfterMs) || (attempt === 0 ? 500 : 1500), 0), 30_000)
        log?.({ scope: 'upstream', level: 'warn', message: `credit-hub: ${entry.name} 429 限流，${wait}ms 后重试（${attempt + 1}/2）` })
        await new Promise(resolve => {
          const timer = setTimeout(resolve, wait)
          timer.unref?.()
          signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve() }, { once: true })
        })
        normalizer = createNormalizer(wire, onChunk)
        sawEvent = false
      }
    }
    const outcome = normalizer.outcome()
    if (outcome.sawFinish !== true || outcome.finish === 'failed') {
      throw new UpstreamError(`上游 ${entry.name} 流在 finish 之前结束`, CODE.transport)
    }
    return { ...outcome, warnings }
  }

  return {
    channel: 'upstream',
    presets: BUILTIN_PRESETS.map(({ id, name, kind, baseURL, models }) => ({ id, name, kind, baseURL, modelCount: models.length })),
    list: () => read().map(publicView),
    upsert,
    installPreset,
    remove,
    setEnabled,
    discover,
    listModels,
    streamTurn,
    status() {
      const rows = read().filter(row => row.enabled !== false && typeof row.apiKey === 'string' && row.apiKey !== '')
      return { upstreams: rows.length, models: rows.reduce((sum, row) => sum + (row.models?.length ?? 0), 0) }
    },
  }
}
