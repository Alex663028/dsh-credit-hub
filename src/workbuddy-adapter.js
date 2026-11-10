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

export function createWorkbuddyAdapter({ workbuddy, hub, settings }) {
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

    async listModels(provider) {
      const disabled = disabledMap()
      const rows = await workbuddy.listModels()
      return rows
        .filter(row => disabled[`wb/${row.realm}/${row.modelId}`] !== true)
        .map(row => ({
          provider,
          id: row.modelId,
          name: row.name,
          description: row.description,
          inputModalities: row.vision === true ? ['text', 'image'] : ['text'],
        }))
    },

    async resolveModel(provider, model) {
      const rows = await workbuddy.listModels()
      const entry = rows.find(row => row.modelId === model)
      if (!entry) throw new UpstreamError(`workbuddy 没有模型 "${model}"`, CODE.notFound)
      const reasoning = sanitizeEfforts(entry.efforts, entry.defaultEffort)
      return {
        provider,
        id: model,
        name: entry.name,
        inputModalities: entry.vision === true ? ['text', 'image'] : ['text'],
        context: { contextWindow: finiteOr(entry.contextWindow, 128000) },
        defaultMaxTokens: Math.min(finiteOr(entry.maxOutput, 16384), 32768),
        ...(reasoning !== undefined ? { reasoning } : {}),
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