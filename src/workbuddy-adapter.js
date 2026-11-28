/**
 * workbuddy-adapter — WorkBuddy 独立 provider 适配器。
 *
 * 积分汇通的聚合路由 `credit-hub` 只对管理面/网关/降级链可见；DSH 的
 * 模型选择器按 provider 分组展示（channel-pack 的 qoder/raccoon 等都是
 * 独立 provider 才能进选择器）。本适配器把 WorkBuddy 注册成独立 provider
 * `workbuddy`，模型 id 用渠道内裸 id（`hy4free`），让聊天框模型选择器
 * 直接出现「WorkBuddy」分组。
 *
 * 请求侧不做二次协议处理：prepareCall 把 `workbuddy/<modelId>` 映射回
 * hub 的完整目录 id（`wb/<realm>/<modelId>`），完全复用 credit-hub 的
 * 流转（错误分类/用量/收尾），保证与网关行为一致。
 *
 * @module src/workbuddy-adapter.js
 */

import { UpstreamError, CODE } from './http.js'
import { sanitizeEfforts, finiteOr } from './util.js'

export function createWorkbuddyAdapter({ workbuddy, hub, settings, warn } = {}) {
  const disabledMap = () => settings()?.modelDisabled ?? {}

  return {
    providerInfo(provider) {
      return { id: provider, name: 'WorkBuddy' }
    },

    providerRetryPolicy() {
      return hub.adapter.providerRetryPolicy()
    },

    imageRequestPricing() {
      return hub.adapter.imageRequestPricing()
    },

    /**
     * 宿主模型选择器对抛错的 provider 记「{name} 加载失败：{message}」并缓存，
     * 之后只在 adapters-updated 事件或手动重试时重拉。因此本方法**永不抛错**：
     * 出错时返回空清单（宿主显示空分组，事件触发后自动恢复），而不是把一次
     * 网络抖动永久钉在 UI 上。同时加 12s 超时竞速——即使 runtime 内部卡住，
     * 也不许拖死宿主目录 RPC。
     */
    async listModels(provider) {
      try {
        const rows = await Promise.race([
          workbuddy.listModels(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('workbuddy 目录响应超时')), 12_000)),
        ])
        return rows
          .filter(row => disabledMap()[`wb/${row.realm}/${row.modelId}`] !== true)
          .map(row => ({
            provider,
            id: row.modelId,
            name: row.name,
            description: row.description,
            inputModalities: row.vision === true ? ['text', 'image'] : ['text'],
          }))
      } catch (error) {
        warn?.(`credit-hub: workbuddy 适配器目录读取失败（宿主将显示空分组）：${String(error?.message ?? error).slice(0, 120)}`)
        return []
      }
    },

    async resolveModel(provider, model) {
      const rows = await workbuddy.listModels()
      const entry = rows.find(row => row.modelId === model)
      if (!entry) throw new UpstreamError(`workbuddy 没有模型 "${model}"`, CODE.notFound)
      // DSH 期望 LlmReasoningInfo.efforts 是 [{id, name}, ...] 对象数组，不是字符串数组
      const reasoning = sanitizeEfforts(entry.efforts, entry.defaultEffort)
      return {
        provider,
        id: model,
        name: entry.name,
        inputModalities: entry.vision === true ? ['text', 'image'] : ['text'],
        context: { contextWindow: finiteOr(entry.contextWindow, 128000) },
        defaultMaxTokens: Math.min(finiteOr(entry.maxOutput, 16384), 32768),
        ...(reasoning !== undefined ? {
          reasoning: {
            efforts: reasoning.efforts.map(effort => ({ id: effort, name: effort })),
            defaultEffort: reasoning.defaultEffort,
          },
        } : {}),
      }
    },

    async prepareCall(provider, model) {
      const rows = await workbuddy.listModels()
      const entry = rows.find(row => row.modelId === model)
      if (!entry) throw new UpstreamError(`workbuddy 没有模型 "${model}"`, CODE.notFound)
      const resolved = await this.resolveModel(provider, model)
      // 映射回积分汇通完整目录 id，复用 hub 的统一流转（含错误分类与用量）。
      const modelId = `wb/${entry.realm}/${entry.modelId}`
      return {
        model: resolved,
        stream: async function* (options) {
          const call = await hub.adapter.prepareCall('credit-hub', modelId)
          yield* call.stream(options)
        },
      }
    },
  }
}