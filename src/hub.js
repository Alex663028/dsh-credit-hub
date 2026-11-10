/**
 * 积分汇通 — hub 适配器与统一运行时。
 *
 * 一条宿主车道（route `credit-hub`）承载全部来源：WorkBuddy 原生渠道、
 * 自填上游（官方 API / 中转）、以及虚拟降级链（combo）。适配器结构化满足
 * 宿主 adapter 契约（registerAdapter 按方法校验，不做 instanceof）。
 *
 * 降级链的提交规则沿用 ours-free-model 的设计：候选在交出第一个"答案"块
 * 之前失败则整段丢弃，切换对调用方不可见；推理增量不算答案——
 * "想了很久才撞墙"正是降级最有价值的场景。
 *
 * @module src/hub.js
 */

import { UpstreamError, CODE } from './http.js'
import { now, sanitizeEfforts, finiteOr } from './util.js'

export const ROUTE_MAIN = 'credit-hub'

const ROUTE_LABELS = { [ROUTE_MAIN]: '积分汇通' }

const SILENT = Symbol('credit-hub-silent-candidate')

const FALLBACK_IMAGE_PRICING = Object.freeze({
  priceImages(images) {
    return images.map(image => image?.offloaded === true
      ? { visualTokens: 0, text: '[image omitted]' }
      : { visualTokens: 1024, text: '[image]' })
  },
})

/** Minimal push/pull bridge between a callback-style turn and a generator. */
function createChannel() {
  const queue = []
  let notify
  let closed = false
  return {
    push(value) {
      if (closed) return
      queue.push(value)
      notify?.()
    },
    close() {
      closed = true
      notify?.()
    },
    async * read() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()
          continue
        }
        if (closed) return
        await new Promise(resolve => { notify = resolve })
        notify = undefined
      }
    },
  }
}

const commitsAnswer = chunk => {
  if (chunk === null || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.trim() !== ''
  if (chunk.type === 'tool-call-delta') return true
  if (chunk.type !== 'block-end') return false
  if (chunk.block?.type === 'reasoning') return false
  if (chunk.block?.type === 'text') return typeof chunk.block.text === 'string' && chunk.block.text.trim() !== ''
  return true
}

async function nextOrSilence(iterator, ms) {
  let timer
  try {
    const silence = new Promise(resolve => { timer = setTimeout(() => resolve(SILENT), ms) })
    const row = await Promise.race([iterator.next(), silence])
    if (row !== SILENT) return row
    try { iterator.return?.(undefined) } catch {}
    return { done: true, value: { advance: true } }
  } finally {
    clearTimeout(timer)
  }
}

export function createHubRuntime({ stores, workbuddy, upstreams, packBridge, packModels, logger, warn, recordTurn, settings: settingsFn }) {
  const settings = settingsFn ?? (() => stores.settings.load())
  const combos = () => {
    const data = stores.routes.load()
    return Array.isArray(data.combos) ? data.combos : []
  }
  // 链路静默看门狗：可在 settings.chainSilenceMs 覆盖（≥500ms），测试用
  const chainSilenceMs = () => {
    const value = Number(settings().chainSilenceMs)
    return Number.isFinite(value) && value >= 500 ? value : 25_000
  }
  // 单模型回合看门狗：combo 有 chainSilenceMs，但 runSingle 以前是裸 await，
  // 上游（实测 iamhc）建立连接后一个字都不吐就能把网关请求挂到客户端超时。
  const singleSilenceMs = () => {
    const value = Number(settings().singleSilenceMs)
    return Number.isFinite(value) && value >= 500 ? value : 120_000
  }
  const singleTotalMs = () => {
    const value = Number(settings().singleTurnMaxMs)
    return Number.isFinite(value) && value >= 5000 ? value : 600_000
  }

  let catalogCache
  let catalogAt = 0
  let lastDegraded = -1

  async function catalog(force = false) {
    if (!force && catalogCache && now() - catalogAt < 45_000) return catalogCache
    const entries = []
    let degraded = 0
    try { entries.push(...await workbuddy.listModels()) } catch (error) {
      degraded += 1
      warn?.(`credit-hub: [来源 1/3 workbuddy] 模型清单失败，本轮跳过该来源（${error?.message ?? error}）`)
    }
    try { entries.push(...await upstreams.listModels()) } catch (error) {
      degraded += 1
      warn?.(`credit-hub: [来源 2/3 upstreams] 模型清单失败，本轮跳过该来源（${error?.message ?? error}）`)
    }
    if (packBridge) {
      try { entries.push(...await packBridge.listModels()) } catch (error) {
        degraded += 1
        warn?.(`credit-hub: [来源 3/3 packBridge] 模型清单失败，本轮跳过该来源（${error?.message ?? error}）`)
      }
    } else if (packModels) {
      try { entries.push(...await packModels()) } catch (error) {
        degraded += 1
        warn?.(`credit-hub: [来源 3/3 packModels] 模型清单失败，本轮跳过该来源（${error?.message ?? error}）`)
      }
    }
    // 降级数变化时汇总一条：目录少了一半模型时不再只靠用户自己发现
    if (degraded !== lastDegraded) {
      lastDegraded = degraded
      if (degraded > 0) warn?.(`credit-hub: 本轮模型目录 ${degraded} 个来源降级（共 3 个来源）`)
    }
    const rows = [...entries]
    for (const combo of combos()) {
      if (!Array.isArray(combo.chain) || combo.chain.length === 0) continue
      const members = combo.chain.map(id => entries.find(row => row.id === id)).filter(Boolean)
      rows.push({
        id: `combo/${combo.name}`,
        source: 'combo',
        name: combo.name,
        combo: combo.chain,
        strategy: combo.strategy === 'round-robin' ? 'round-robin' : 'fallback',
        // 链路容量取成员实测元数据：上下文取最短板，输出取最大可分期值
        contextWindow: members.length > 0 ? Math.min(...members.map(row => finiteOr(row.contextWindow, 128000))) : 128000,
        maxOutput: members.length > 0 ? Math.max(...members.map(row => finiteOr(row.maxOutput, 8192))) : 16384,
        description: `${combo.chain.length} 模型链：${combo.chain.join(' → ')}`,
      })
    }
    // 用户级模型开关：disabled 模型仍保留在目录里（降级链成员不受影响），
    // 只是从选择器与网关清单里隐藏。
    const disabledMap = settings().modelDisabled ?? {}
    for (const row of rows) row.disabled = disabledMap[row.id] === true
    catalogCache = rows
    catalogAt = now()
    return rows
  }

  function invalidate() {
    catalogAt = 0
  }

  function comboChain(entry, rows) {
    const chain = []
    for (const modelId of entry.combo ?? []) {
      const target = rows.find(row => row.id === modelId)
      if (target && target.source !== 'combo') chain.push(target)
    }
    return chain
  }

  /** One physical turn into a channel; resolves to the turn outcome. */
  function dispatch(entry, options, onChunk, signal) {
    if (entry.source === 'workbuddy') {
      return workbuddy.streamTurn({ modelId: entry.id, options, signal, onChunk })
    }
    if (entry.source === 'upstream') {
      return upstreams.streamTurn({ modelId: entry.id, options, signal, onChunk })
    }
    if (entry.source === 'pack' && packBridge) {
      return packBridge.streamTurn({ modelId: entry.id, options, signal, onChunk })
    }
    return Promise.reject(new UpstreamError(`credit-hub 不认识来源 "${entry.source}"`, CODE.client))
  }

  function runInto(entry, options, onChunk, signal) {
    const channel = createChannel()
    const request = dispatch(entry, options, value => channel.push(value), signal)
      .then(outcome => { channel.push({ __outcome: outcome }); channel.close() })
      .catch(error => {
        channel.push({ __error: error instanceof Error ? error : new Error(String(error)) })
        channel.close()
      })
    return { channel, request }
  }

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: ROUTE_LABELS[provider] ?? provider }
    },

    providerRetryPolicy() {
      return Object.freeze({
        mode: 'normal',
        maxRetries: 1,
        retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
        initialDelayMs: 800,
        maxDelayMs: 8000,
        jitterRatio: 0.2,
      })
    },

    imageRequestPricing() {
      return FALLBACK_IMAGE_PRICING
    },

    async listModels(provider) {
      const rows = await catalog()
      // 不仅暴露给 credit-hub route，也让 DSH UI 能读到 workbuddy/qoder 等 provider
      return rows.filter(entry => entry.disabled !== true).map(entry => ({
        provider,
        id: entry.id,
        name: entry.name,
        description: entry.description,
        inputModalities: entry.vision === true ? ['text', 'image'] : ['text'],
      }))
    },

    async resolveModel(provider, model) {
      const rows = await catalog()
      const entry = rows.find(row => row.id === model)
      // 未知模型 fail-fast：装作解析成功只会把错误推迟到上游请求之后
      if (!entry) throw new UpstreamError(`credit-hub 没有模型 "${model}"`, CODE.notFound)
      // 宿主校验一票否决整条 provider——所有来源的档位/数值都在出口再消毒一次。
      const reasoning = sanitizeEfforts(entry.efforts, entry.defaultEffort)
      return {
        provider,
        id: entry.id,
        name: entry.name,
        inputModalities: entry.vision === true ? ['text', 'image'] : ['text'],
        context: { contextWindow: finiteOr(entry.contextWindow, 128000) },
        defaultMaxTokens: Math.min(finiteOr(entry.maxOutput, 16384), 32768),
        ...(reasoning !== undefined ? { reasoning } : {}),
      }
    },

    async prepareCall(provider, model) {
      const rows = await catalog()
      const entry = rows.find(row => row.id === model) ?? null
      return {
        model: await this.resolveModel(provider, model),
        stream: options => this.stream(options, entry, rows),
      }
    },

    stream(options, pinned, rows) {
      const controller = new AbortController()
      const onAbort = () => controller.abort(options.signal?.reason)
      if (options.signal?.aborted === true) onAbort()
      else options.signal?.addEventListener('abort', onAbort, { once: true })
      const iterator = this.runStream({ ...options, signal: controller.signal }, pinned, rows ?? null)
      const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
      const step = async (method, value) => {
        try {
          const row = await iterator[method](value)
          if (row.done) cleanup()
          return row
        } catch (error) {
          cleanup()
          throw error
        }
      }
      return {
        [Symbol.asyncIterator]() { return this },
        next: value => step('next', value),
        return: value => { controller.abort(); cleanup(); return step('return', value) },
        throw: error => { controller.abort(error); cleanup(); return step('throw', error) },
      }
    },

    async * runStream(options, pinned, rows) {
      const currentRows = rows ?? await catalog()
      const entry = pinned ?? currentRows.find(row => row.id === options.model) ?? null
      // 简单客户端兼容：调用方未指定思考强度且设置开启时，思考模型默认关思考——
      // 否则思考阶段没有可见输出，只会渲染 content 的客户端表现为"没响应"
      if (entry !== null && entry.reasoning === true
        && settings().thinkingOffByDefault === true && options.reasoningEffort === undefined) {
        options = { ...options, reasoningEffort: 'off' }
      }
      if (entry !== null && entry.source === 'combo') {
        yield * this.runCombo(options, entry, currentRows)
        return
      }
      yield * this.runSingle(options, entry, {})
    },

    async * runCombo(options, entry, rows) {
      if (settings().enabled === false) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: '积分汇通已在设置页关闭', code: 'CONFIG_DISABLED' } } }
        return
      }
      const chain = comboChain(entry, rows)
      if (chain.length === 0) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: `链路 "${entry.name}" 没有可用成员`, code: CODE.server } } }
        return
      }
      const startIndex = entry.strategy === 'round-robin'
        ? (entry.cursor = ((entry.cursor ?? 0) + 1) % chain.length)
        : 0
      const tried = []
      for (let index = 0; index < chain.length; index += 1) {
        const candidate = chain[(startIndex + index) % chain.length]
        // 每个候选独立的 AbortController：静默超时/换跳时真正中止它的上游
        // 请求——否则 nextOrSilence 只关了读端，挂死的请求会在下方 request
        // 等待里堵死整条链，CHAIN_SILENCE_MS 形同虚设。
        const controller = new AbortController()
        const onOuterAbort = () => controller.abort(options.signal?.reason)
        if (options.signal?.aborted === true) onOuterAbort()
        else options.signal?.addEventListener('abort', onOuterAbort, { once: true })
        const { channel, request } = runInto(candidate, { ...options, signal: controller.signal }, () => {}, controller.signal)
        let committed = false
        let held = []
        let endValue
        const reader = channel.read()
        try {
          while (true) {
            const row = committed ? await reader.next() : await nextOrSilence(reader, chainSilenceMs())
            if (row.done === true) { endValue = row.value; break }
            const chunk = row.value
            if (chunk?.__outcome !== undefined) { endValue = { value: chunk.__outcome }; break }
            // A candidate fault before commit is advanceable — walk to the next
            // link instead of surfacing the error to the caller.
            if (chunk?.__error !== undefined) { endValue = { value: { advance: true, error: chunk.__error } }; break }
            if (committed) { yield chunk; continue }
            held.push(chunk)
            if (commitsAnswer(chunk)) {
              committed = true
              for (const item of held) yield item
              held = []
            }
          }
        } finally {
          // 无条件中止：候选结算后请求本就该停（成功时是空操作），
          // 换跳/静默超时/失败时则是真正切断挂死传输的唯一手段。
          controller.abort()
          options.signal?.removeEventListener('abort', onOuterAbort)
          try { reader?.return?.() } catch {}
          await Promise.race([
            request.catch(() => {}),
            new Promise(resolve => { const timer = setTimeout(resolve, 2000); timer.unref?.() }),
          ])
        }
        if (committed) {
          // The chain owns the ending: emit the winner's usage + finish so the
          // caller sees a complete turn, exactly like a single-model one.
          const outcome = endValue?.value ?? {}
          yield { type: 'usage', usage: outcome.usage ?? { inputTokens: 0, outputTokens: 0 } }
          const kind = outcome.finish === 'max_tokens' || outcome.finish === 'length' ? 'max-tokens' : 'stop'
          yield { type: 'finish', reason: { kind } }
          recordTurn?.({ at: Date.now(), model: candidate.id, ok: true, usage: outcome.usage })
          return
        }
        const failure = endValue?.value?.error
        tried.push(`${candidate.id}${failure ? ` (${String(failure?.message ?? 'failed').slice(0, 80)})` : ''}`)
        warn?.(`credit-hub: 链路 "${entry.name}" 跳过 ${candidate.id}${failure ? ` — ${failure.message ?? ''}` : ''}`)
        // 被跳过的成员失败也留痕，用量统计才完整
        recordTurn?.({ at: Date.now(), model: candidate.id, ok: false, skipped: true, error: failure?.message })
      }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `链路 "${entry.name}" 全部候选失败：${tried.join('; ')}`, code: CODE.server } } }
    },

    async * runSingle(options, entry) {
      if (settings().enabled === false) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: '积分汇通已在设置页关闭', code: 'CONFIG_DISABLED' } } }
        return
      }
      if (entry === null) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: `积分汇通没有模型 "${options.model}"`, code: CODE.server } } }
        return
      }
      const startedAt = now()
      // 自有 controller：静默/总时长到期时不仅要停止读取，还要 abort 上游请求；
      // 外层 signal（客户端断开）仍照常透传。
      const controller = new AbortController()
      const onOuterAbort = () => controller.abort(options.signal?.reason)
      if (options.signal?.aborted === true) controller.abort(options.signal?.reason)
      else options.signal?.addEventListener('abort', onOuterAbort, { once: true })
      const innerSignal = controller.signal
      const { channel, request } = runInto(entry, { ...options, signal: innerSignal }, () => {}, innerSignal)
      let outcome
      let streamError
      let timedOut = false
      const silenceMs = singleSilenceMs()
      const totalMs = singleTotalMs()
      try {
        const reader = channel.read()
        while (true) {
          const remaining = totalMs - (now() - startedAt)
          const totalLimited = remaining <= silenceMs
          const waitMs = Math.max(1, Math.min(silenceMs, remaining))
          const row = await Promise.race([
            reader.next(),
            new Promise(resolve => { const timer = setTimeout(() => resolve(SILENT), waitMs); timer.unref?.() }),
          ])
          if (row === SILENT) {
            timedOut = true
            controller.abort()
            const message = totalLimited
              ? `单模型回合超过 ${Math.round(totalMs / 1000)}s 上限，已中止`
              : `上游 ${Math.round(silenceMs / 1000)}s 无任何输出，已中止`
            streamError = Object.assign(new Error(message), { code: CODE.timeout })
            break
          }
          if (row.done === true) break
          const chunk = row.value
          if (chunk?.__outcome !== undefined) { outcome = chunk.__outcome; break }
          if (chunk?.__error !== undefined) { streamError = chunk.__error; break }
          yield chunk
        }
        if (timedOut) {
          // 挂死的渠道可能不响应 abort：给 request 2s 上界，绝不无限等
          try { reader.return?.() } catch {}
          await Promise.race([
            request.catch(() => {}),
            new Promise(resolve => { const timer = setTimeout(resolve, 2000); timer.unref?.() }),
          ])
        } else await request
      } catch (error) {
        streamError = error
      } finally {
        options.signal?.removeEventListener('abort', onOuterAbort)
      }
      const failure = streamError ?? outcome?.__error
      if (failure !== undefined || outcome === undefined) {
        // 崩溃堆栈落日志（warn → logs.jsonl）：只有 message 的错误无法定位
        if (failure?.stack) {
          warn?.(`turn ${entry?.id ?? options.model} 崩溃堆栈: ${String(failure.stack).split('\n').slice(0, 10).join(' ⏎ ')}`)
        }
        const aborted = options.signal?.aborted === true || failure?.code === CODE.aborted
        // 排空 channel 里剩余的块收尾帧（flushTails 在错误前推入的 block-end），
        // 有 2s 上界——渠道实现若没关闭也不无限等。
        try {
          const drain = channel.read()
          while (true) {
            const row = await Promise.race([
              drain.next(),
              new Promise(resolve => { const timer = setTimeout(() => resolve({ done: true }), 2000); timer.unref?.() }),
            ])
            if (row.done === true) break
            if (row.value?.type !== undefined) yield row.value
          }
        } catch {}
        yield {
          type: 'finish',
          reason: {
            kind: aborted ? 'aborted' : 'error',
            failure: {
              message: String(failure?.message ?? 'credit-hub turn failed').slice(0, 500),
              code: typeof failure?.code === 'string' ? failure.code : CODE.transport,
              ...(Number.isInteger(failure?.status) ? { status: failure.status } : {}),
            },
          },
        }
        recordTurn?.({ at: startedAt, model: entry.id, ok: false, error: failure?.message })
        return
      }
      yield { type: 'usage', ...(outcome.usage !== undefined ? { usage: outcome.usage } : { usage: { inputTokens: 0, outputTokens: 0 } }) }
      const finishToken = outcome.finish
      const kind = finishToken === 'max_tokens' || finishToken === 'length' ? 'max-tokens' : 'stop'
      yield { type: 'finish', reason: { kind }, ...(kind === 'stop' && !['stop', 'end_turn', 'stop_sequence'].includes(finishToken) ? { upstreamFinish: finishToken } : {}) }
      recordTurn?.({ at: startedAt, model: entry.id, ok: true, usage: outcome.usage })
    },
  }

  return {
    route: ROUTE_MAIN,
    adapter,
    catalog,
    invalidate,
    combos,
    async setCombos(list) {
      stores.routes.update(data => ({ ...data, combos: list }))
      invalidate()
    },
  }
}
