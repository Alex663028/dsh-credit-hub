/**
 * pack-bridge — 渠道包模型桥接进 credit-hub 目录。
 *
 * 渠道包（vendored channel-pack）把 Raccoon/Qoder/TRAE/ZCode/Gemini/…
 * 注册为宿主 llm 注册表里的**独立 provider**（`lobsterai`/`qoder`/…），
 * 不经过 credit-hub 的 adapter，因此 8330 网关此前只能转出
 * WorkBuddy + 自填上游。桥接层做两件事：
 *
 *  1. `listModels()`：枚举宿主 llm 注册表（跳过本插件 route 与已知的
 *     官方/内置 provider），把每个 provider 的模型以 `pk/<provider>/<model>`
 *     的形式并入 credit-hub 目录；
 *  2. `streamTurn()`：请求按同一 id 拆回 `{provider, model}`，走宿主
 *     `ctx.llm.stream()` 发出——渠道包适配器与 hub 适配器在同一进程的
 *     同一个 llm 服务上，这就是 pack 自家网关（8326）同款的调用形态，
 *     输出正是 hub 消费的块协议（text-delta / block-end / usage / finish）。
 *
 * provider 排除表：`credit-hub`（本插件 route，防止自环）与 9 个官方/
 * 深度系 provider（anthropic/openai/deepseek 官方直连，key 在宿主里管理，
 * 挂进积分汇通会造成重复计费路径）。渠道包未来若新增 provider 会自动
 * 进入桥接，无需改这里。
 *
 * @module src/pack-bridge.js
 */

import crypto from 'node:crypto'

const EXCLUDED_PROVIDERS = new Set([
  'credit-hub',
  // WorkBuddy 已注册为独立 provider（workbuddy 分组直接进模型选择器），
  // 不再桥接成 pk/workbuddy/* 造成重复。
  'workbuddy',
  'anthropic',
  'openai',
  'openai-responses',
  'deepseek',
  'deepseek-official',
  'gemini-web',
  'browser-use',
  'computer-use',
])

/** `pk/<provider>/<model>` → { provider, model }；不匹配返回 null。 */
export function parsePackModelId(id) {
  if (typeof id !== 'string' || !id.startsWith('pk/')) return null
  const slashAt = id.indexOf('/', 3)
  if (slashAt <= 3 || slashAt === id.length - 1) return null
  return { provider: id.slice(3, slashAt), model: id.slice(slashAt + 1) }
}

/** 宿主 dsh-llm 的懒加载（createToolResultMessage / ReasoningEffortId）：
 *  与 pack.js 同一解析链，宿主进程内可达；不可达时退回字面量兜底。 */
let dshLlmModule = null
async function dshLlmHelpers() {
  if (dshLlmModule === null) {
    try { dshLlmModule = await import('@deepseek-ai/dsh-llm') } catch { dshLlmModule = false }
  }
  return dshLlmModule === false ? null : dshLlmModule
}

export function createPackBridge({ logger, warn } = {}) {
  let llm = null
  let warnedProviderEnum = false

  /** 宿主 llm 服务的延迟绑定（pack 挂载晚于 hub 创建）。 */
  const setLlm = service => { llm = service }

  const listProviders = async () => {
    if (llm === null) return []
    try {
      const providers = await llm.listProviders()
      if (!Array.isArray(providers)) return []
      return providers.filter(provider => {
        const id = typeof provider === 'string' ? provider : provider?.id
        return typeof id === 'string' && id !== '' && !EXCLUDED_PROVIDERS.has(id)
      }).map(provider => typeof provider === 'string' ? { id: provider } : provider)
    } catch (error) {
      // 每次目录刷新都会走到这里，失败只告警一次避免日志刷屏
      if (warnedProviderEnum === false) {
        warnedProviderEnum = true
        warn?.(`credit-hub: pack 桥接枚举 provider 失败（${error?.message ?? error}）`)
      }
      return []
    }
  }

  async function listModels() {
    const out = []
    for (const provider of await listProviders()) {
      let rows = []
      try { rows = await llm.listModels(provider.id) } catch (error) {
        warn?.(`credit-hub: pack 桥接读取 ${provider.id} 模型失败（${error?.message ?? error}）`)
        continue
      }
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        if (typeof row?.id !== 'string' || row.id === '') continue
        out.push({
          id: `pk/${provider.id}/${row.id}`,
          source: 'pack',
          provider: provider.id,
          modelId: row.id,
          name: row.name ?? row.id,
          contextWindow: row.context?.contextWindow ?? row.contextWindow,
          maxOutput: row.defaultMaxTokens ?? row.maxOutput,
          vision: Array.isArray(row.inputModalities) && row.inputModalities.includes('image'),
          description: `${row.name ?? row.id} · ${provider.name ?? provider.id}`,
        })
      }
    }
    return out
  }

  // 模型思考档位缓存：pkId → { efforts, defaultEffort }（无菜单 = 不支持思考）
  const modelMeta = new Map()

  /** 查宿主模型的思考档位菜单；查不到 = 无菜单（调用方 effort 应整个去掉）。
   *  菜单条目可能是对象（{id}/{name}/{level}）——一律归一化为字符串。 */
  async function resolveMeta(provider, model) {
    const key = `pk/${provider}/${model}`
    if (modelMeta.has(key)) return modelMeta.get(key)
    let meta = { efforts: undefined, defaultEffort: undefined }
    try {
      const info = await llm.resolveModelInfo?.(provider, model)
      const r = info?.reasoning
      const efforts = (Array.isArray(r?.efforts) ? r.efforts : [])
        .map(effort => typeof effort === 'string' ? effort : String(effort?.id ?? effort?.name ?? effort?.level ?? ''))
        .filter(effort => effort !== '')
      if (efforts.length > 0) {
        meta = { efforts, defaultEffort: typeof r.defaultEffort === 'string' ? r.defaultEffort : efforts[efforts.length - 1] }
      }
    } catch (error) {
      // 旧版静默吞掉：推理档位探测失败会让模型看起来「不支持思考」，且无从排查
      warn?.(`credit-hub: pack 桥接读取 ${provider}/${model} 推理档位失败（${error?.message ?? error}）`)
    }
    modelMeta.set(key, meta)
    return meta
  }

  const EFFORT_RANK = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 }

  /** 请求档位钳制到模型受支持集合：不支持思考 → undefined（整个不发）。 */
  function clampEffort(requested, meta) {
    const list = (meta?.efforts ?? []).map(effort => typeof effort === 'string' ? effort : String(effort?.id ?? effort?.name ?? '')).filter(effort => effort !== '')
    if (list.length === 0) return undefined
    const requestedNorm = String(requested).toLowerCase()
    if (requestedNorm === 'off') return list.includes('off') ? 'off' : undefined
    if (list.includes(requestedNorm)) return requestedNorm
    const reqRank = EFFORT_RANK[requestedNorm] ?? 4
    const below = list.filter(effort => (EFFORT_RANK[effort.toLowerCase()] ?? 4) <= reqRank)
    return below.length > 0 ? below[below.length - 1] : list[0]
  }

  /**
   * One physical turn over the host llm service. Emits the same chunk
   * vocabulary `dispatch()` consumers already handle and resolves to
   * `{ usage, finish, sawFinish }` so hub 的提交/收尾逻辑零改动。
   */
  async function streamTurn({ modelId, options, signal, onChunk }) {
    const route = parsePackModelId(modelId)
    if (route === null) {
      const error = new Error(`credit-hub: 无法解析 pack 模型 id "${modelId}"`)
      error.code = 'CLIENT'
      throw error
    }
    if (llm === null) {
      const error = new Error('credit-hub: 宿主 llm 服务未绑定，pack 渠道不可用')
      error.code = 'SERVER'
      throw error
    }
    const messages = Array.isArray(options?.messages) ? options.messages : []
    const systemText = messages
      .filter(message => message?.role === 'system' || message?.role === 'developer')
      .map(message => typeof message.content === 'string' ? message.content : '')
      .filter(Boolean)
      .join('\n\n')
    const chat = messages.filter(message => message?.role !== 'system' && message?.role !== 'developer')
    // 思考强度钳制：调用方的 effort 必须落在该模型受支持的档位集合内——
    // 模型不支持思考（无菜单）时整个去掉，否则 Raccoon 等适配器直接报
    // "does not support reasoning effort"
    let clampedEffort
    if (options?.reasoningEffort !== undefined) {
      const meta = await resolveMeta(route.provider, route.model)
      clampedEffort = clampEffort(String(options.reasoningEffort), meta)
    }
    // 消息构造完全对齐 pack 自家网关的 toGenerateOptions/convertMessage：
    // ① content 一律块数组（宿主消息约定，字符串内容会打崩部分适配器）
    // ② 每条消息带 id + source 元数据（宿主会话记录按消息 id 建档）
    // ③ 工具结果经宿主 createToolResultMessage 工厂构造（形状由宿主管）
    // ④ generate 里没有独立的 system 字段——system 就是 messages 里的一条
    const dshLlm = await dshLlmHelpers()
    const uuid8 = () => crypto.randomBytes(8).toString('hex')
    const gwMessage = (role, content, extra = {}) => ({ id: uuid8(), role, content, ...extra })
    const gwMessages = []
    for (const message of messages) {
      const blocks = typeof message?.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message?.content) ? message.content : []
      if (message?.role === 'system' || message?.role === 'developer') {
        const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
        if (text) gwMessages.push(gwMessage('system', [{ type: 'text', text }], { source: { kind: 'plugin:credit-hub' } }))
        continue
      }
      if (message?.role === 'tool') {
        if (dshLlm?.createToolResultMessage) {
          for (const result of blocks.filter(block => block.type === 'tool-result')) {
            const inner = (Array.isArray(result.content) ? result.content : []).filter(part => part.type === 'text').map(part => ({ type: 'text', text: part.text }))
            gwMessages.push(dshLlm.createToolResultMessage({ callId: String(result.toolCallId ?? ''), content: inner, isError: false }))
          }
        } else {
          // dsh-llm 不可达时的兜底形状（与宿主工具消息同构的字面量）
          for (const result of blocks.filter(block => block.type === 'tool-result')) {
            const inner = (Array.isArray(result.content) ? result.content : []).filter(part => part.type === 'text').map(part => ({ type: 'text', text: String(part.text ?? '') }))
            gwMessages.push({ id: uuid8(), role: 'tool', callId: String(result.toolCallId ?? ''), content: inner, isError: false })
          }
        }
        continue
      }
      if (message?.role === 'assistant') {
        const content = []
        if (typeof message.reasoning_content === 'string' && message.reasoning_content) content.push({ type: 'reasoning', text: message.reasoning_content })
        for (const block of blocks) {
          if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text })
          else if (block.type === 'reasoning' && block.text) content.push({ type: 'reasoning', text: block.text })
          else if (block.type === 'tool-call') content.push({ type: 'tool-call', id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}) })
        }
        if (content.length > 0) gwMessages.push(gwMessage('assistant', content, { source: { kind: 'model', provider: route.provider, model: route.model } }))
        continue
      }
      const content = []
      for (const block of blocks) {
        if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text })
        else if (block.type === 'image' && typeof block.image === 'string') content.push({ type: 'image_url', image_url: { url: block.image } })
      }
      if (content.length > 0) gwMessages.push(gwMessage('user', content, { source: { kind: 'user' } }))
    }
    // 思考强度规范化：钳制到模型菜单后，还要过宿主 ReasoningEffortId
    // （与 pack 自家网关同款——原始字符串不保证是合法枚举值）
    let reasoningPatch = {}
    if (clampedEffort !== undefined) {
      try {
        if (dshLlm?.ReasoningEffortId) reasoningPatch = { reasoningEffort: dshLlm.ReasoningEffortId(clampedEffort) }
        else reasoningPatch = { reasoningEffort: clampedEffort }
      } catch { reasoningPatch = {} }
    }
    const tools = (Array.isArray(options?.tools) ? options.tools : []).map(tool => {
      const source = tool && typeof tool.function === 'object' && tool.function !== null ? tool.function : tool
      const name = String(source?.name ?? '').trim()
      if (!name) return null
      return {
        name,
        description: typeof source?.description === 'string' ? source.description : '',
        parameters: source?.parameters && typeof source.parameters === 'object' && !Array.isArray(source.parameters)
          ? source.parameters
          : { type: 'object', properties: {} },
      }
    }).filter(Boolean)
    const generate = {
      provider: route.provider,
      model: route.model,
      messages: gwMessages,
      // 与 pack 自家网关同构：tools/stop 空时整个省略（undefined），不传空数组
      ...(tools.length > 0 ? { tools } : {}),
      // clamp：外部传来的 maxTokens 不再裸透传给宿主 llm（NaN/超大值会打崩上游）
      ...(Number.isFinite(options?.maxTokens)
        ? { maxTokens: Math.min(Math.max(Math.floor(options.maxTokens), 1), 200000) }
        : {}),
      ...(typeof options?.temperature === 'number' ? { temperature: options.temperature } : {}),
      ...(Array.isArray(options?.stop) && options.stop.length > 0 ? { stop: options.stop } : {}),
      ...reasoningPatch,
      signal,
    }
    let outcome = { sawFinish: false, finish: undefined, usage: undefined }
    try {
      for await (const chunk of llm.stream(generate)) {
        if (signal?.aborted === true) break
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'usage') outcome.usage = chunk.usage
        else if (chunk.type === 'finish') {
          outcome.sawFinish = true
          outcome.finish = chunk.reason
          // finish 不经 onChunk 下发：hub 的 runSingle 会在 outcome 之后统一
          // 收尾，双发 finish 会破坏"一回合一次收尾"约定。错误收尾以异常走
          // hub 的统一错误路径（带出 failure 消息）。
          if (chunk.reason?.kind === 'error') {
            throw new Error(chunk.reason?.failure?.message ?? 'pack 渠道请求失败')
          }
          continue
        }
        onChunk?.(chunk)
      }
    } catch (error) {
      error.packProvider = route.provider
      throw error
    }
    // 与 workbuddy/upstream 渠道同约定：流在 finish 之前结束视为传输故障。
    if (outcome.sawFinish !== true) {
      const error = new Error('pack 渠道流在 finish 之前结束')
      error.code = 'TRANSPORT'
      throw error
    }
    // hub 的收尾映射认 wire 形 token（'max_tokens'），pack 的 kind 是
    // 'max-tokens'——归一化，'stop'/'tool-calls' 等其余值 hub 已能兜住。
    if (outcome.finish?.kind === 'max-tokens') outcome.finish = 'max_tokens'
    else outcome.finish = outcome.finish?.kind ?? 'stop'
    return outcome
  }

  return {
    channel: 'pack',
    setLlm,
    listModels,
    streamTurn,
    async status() {
      const providers = await listProviders()
      return { providers: providers.length, bridged: llm !== null }
    },
  }
}
