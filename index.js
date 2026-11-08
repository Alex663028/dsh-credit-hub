/**
 * dsh-credit-hub — 积分汇通。
 *
 * Host 半身入口。装配：存储 → WorkBuddy 原生渠道 → 自填上游 → hub 适配器
 * （route `credit-hub`）→ 本地网关（OpenAI + Anthropic 兼容）→ 管理面 REST
 * （/api/credit-hub）→ vendored account-pack（可选，auto 跳过 ofm 共存场景）。
 * 除 `llm` 外全部依赖机会式读取（ctx.inject / ctx.get），缺什么降什么。
 *
 * @module index.js
 */

import { createRequire } from 'node:module'
import { createStores } from './src/store.js'
import { createWorkbuddyRuntime } from './src/workbuddy.js'
import { createUpstreamRuntime } from './src/aggregate.js'
import { createHubRuntime, ROUTE_MAIN } from './src/hub.js'
import { startGateway } from './src/forward.js'
import { createApiRoutes } from './src/api.js'
import { mountAccountPack } from './src/pack-mount.js'
import { createPackBridge } from './src/pack-bridge.js'
import { createRing, now } from './src/util.js'

const require = createRequire(import.meta.url)
const { version } = require('./package.json')

/** schemastery 配置面（可选宿主依赖）：缺席时 Config 为 undefined，只影响
 * 宿主配置 UI 的呈现；运行态真身始终是 settings.json（config 仅作默认值层）。 */
export let Config
try {
  const Schema = (await import('@deepseek-ai/schemastery')).default
  Config = Schema.object({
    enabled: Schema.boolean().default(true).description('启用积分汇通模型车道'),
    gatewayEnabled: Schema.boolean().default(true).description('启用本地网关（仅回环）'),
    gatewayPort: Schema.number().default(8330).description('本地网关端口'),
    accountPack: Schema.union(['auto', 'on', 'off']).default('auto').description('渠道包模式：auto 避让 ofm / on 独立反代 / off'),
    autoCheckin: Schema.boolean().default(false).description('WorkBuddy 每日自动签到'),
    packGateway: Schema.boolean().default(false).description('渠道包自带 8326 网关（单网关策略下保持关闭）'),
  }).description('积分汇通')
} catch {}

export const name = 'credit-hub'

const SETTINGS_DEFAULTS = {
  enabled: true,
  gatewayEnabled: true,
  gatewayPort: 8330,
  accountPack: 'auto',
  autoCheckin: false,
  // 单网关策略：8330 已通过 pack 桥接汇总全部模型，渠道包自带的 8326
  // 本地网关默认停用（进程级 env 硬开关，pack 的 RPC 也打不开）。
  packGateway: false,
}

/** llm 是唯一硬依赖：没有它本插件无事可做，其余服务缺席只降级单个功能。 */
export const inject = ['llm']

const SETTINGS_KEYS = ['enabled', 'gatewayEnabled', 'gatewayPort', 'accountPack', 'defaultMaxTokens', 'autoCheckin', 'onboardingSeen', 'modelDisabled', 'chainSilenceMs', 'packGateway']

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const stores = createStores()
  // 分层配置：DEFAULTS < 宿主 config（profile patch）< settings.json。
  // settings.json 是设置页写入的**稀疏覆盖层**——首次启动不预写全量键，
  // 用户没在设置页改过的键，宿主配置面板的改动就真实生效。
  const patchConfig = config && typeof config === 'object' ? config : {}
  const settings = () => ({ ...SETTINGS_DEFAULTS, ...patchConfig, ...stores.settings.load() })
  const logRing = createRing(400)
  const log = row => logRing.push({ at: now(), level: 'info', ...row })
  const warn = message => {
    logger.warn?.(`credit-hub: ${message}`)
    logRing.push({ at: now(), level: 'warn', message: String(message).slice(0, 500) })
  }
  let packStatus = { mounted: false, reason: 'pending' }

  // 目录变更广播：模型开关/上游/链路改动后通知宿主刷新选择器缓存。
  // 宿主把各 provider 的模型目录缓存在本地——不广播的话，WB 等汇通模型的
  // 开关在选择器里永远不生效（渠道包自己的 setDisabled 会广播，无需代劳）。
  // ⚠️ 必须在所有引用它的 runtime 创建之前定义（const 无提升）。
  const broadcastCatalogChanged = () => {
    try { ctx.llm?.emitAdaptersUpdated?.() } catch {}
    try { ctx.emit?.('llm/adapters-updated') } catch {}
  }

  // 渠道包 8326 网关的进程级硬开关：必须在 pack 挂载前设置。pack 挂载是
  // 异步的（ctx.inject 回调），这里同步先设，保证竞态安全。
  if (settings().packGateway === false) {
    process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'
    logger.info?.('credit-hub: 渠道包 8326 本地网关已按单网关策略停用（settings.packGateway）')
  }

  const workbuddy = createWorkbuddyRuntime({ stores, log, warn, onAccountsChanged: broadcastCatalogChanged })
  const upstreams = createUpstreamRuntime({ stores, log })
  // 渠道包模型桥接：把宿主 llm 注册表里的渠道包 provider（raccoon/qoder/…）
  // 以 `pk/<provider>/<model>` 并入目录；请求走 ctx.llm.stream 进程内转发。
  const packBridge = createPackBridge({ logger, warn })
  packBridge.setLlm(ctx.llm)
  // 逐模型用量（内存聚合，随进程生命周期）：模型 → {ok, failed, skipped, lastAt, tokens}
  const usageStats = new Map()
  const recordTurn = ({ model, ok, skipped, usage }) => {
    const row = usageStats.get(model) ?? { ok: 0, failed: 0, skipped: 0, inputTokens: 0, outputTokens: 0, lastAt: 0 }
    if (ok === true) row.ok += 1
    else if (skipped === true) row.skipped += 1
    else row.failed += 1
    row.inputTokens += usage?.inputTokens ?? 0
    row.outputTokens += usage?.outputTokens ?? 0
    row.lastAt = now()
    usageStats.set(model, row)
    log({ scope: 'turn', message: `${model}: ${ok === true ? 'ok' : skipped === true ? 'skipped' : 'failed'}` })
  }
  const hub = createHubRuntime({ stores, workbuddy, upstreams, packBridge, logger, warn, recordTurn, settings })
  const gateway = startGateway({ stores, hub, logger, settings })

  // ── 模型车道注册 ───────────────────────────────────────────────────────────
  let registration
  try {
    registration = ctx.llm.registerAdapter([ROUTE_MAIN], hub.adapter)
    logger.info?.(`credit-hub: 模型车道已注册（${ROUTE_MAIN}）`)
  } catch (error) {
    warn(`llm.registerAdapter 失败：${error?.message ?? error}`)
  }
  ctx.effect(() => () => { registration?.() }, 'credit-hub: adapter routes')

  // ── 管理面 REST ────────────────────────────────────────────────────────────
  ctx.inject(['webServer'], scoped => {
    const api = createApiRoutes({
      stores, hub, workbuddy, upstreams, gateway, version,
      settingsKeys: SETTINGS_KEYS,
      packStatus: () => packStatus,
      broadcast: broadcastCatalogChanged,
      usage: () => [...usageStats.entries()].map(([model, row]) => ({ model, ...row })).sort((a, b) => (b.ok + b.failed) - (a.ok + a.failed)).slice(0, 12),
      logs: () => logRing.list(),
      clearLogs: () => logRing.clear(),
      log, warn,
    })
    scoped.effect(() => scoped.webServer.register({ kind: 'prefix', path: '/api/credit-hub', handler: api }), 'credit-hub: api routes')
    logger.info?.('credit-hub: 管理面已挂载 /api/credit-hub')
  })

  // ── 本地网关（按设置启停） ─────────────────────────────────────────────────
  ctx.effect(() => {
    const settings = stores.settings.load()
    if (settings.enabled === false || settings.gatewayEnabled === false) return
    gateway.start().catch(error => warn(`网关启动失败：${error?.message ?? error}`))
  }, 'credit-hub: gateway boot')

  // ── vendored account-pack（Raccoon/Qoder/ZCode/MiniMax/…） ────────────────
  ctx.inject(['credentials', 'commands', 'llm'], scoped => {
    void mountAccountPack(scoped, { settings, stores, logger, warn }).then(status => { packStatus = status })
  })

  // ── 周期任务：token 刷新 + 可选每日签到 ────────────────────────────────────
  const tick = async () => {
    try {
      await workbuddy.tick()
      const current = settings()
      if (current.enabled === false || current.autoCheckin !== true) return
      // 本地日期（UTC 的 toISOString 会让北京时间的"每日"晚 8 小时才轮转）
      const localDay = ts => {
        const date = new Date(ts)
        const pad = value => String(value).padStart(2, '0')
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      }
      const today = localDay(Date.now())
      const marks = { ...(stores.settings.load().checkinMarks ?? {}) }
      // 裁剪 30 天前的标记（key 前缀即本地日期；旧版无账号后缀的全局 key 一并老化）
      const cutoff = localDay(Date.now() - 30 * 86400_000)
      for (const key of Object.keys(marks)) if (key.slice(0, 10) < cutoff) delete marks[key]
      let pending = false
      for (const account of workbuddy.listAccounts()) {
        if (account.enabled === false || account.realm !== 'cn') continue
        const key = `${today}:${account.id}`
        if (marks[key] === 'ok') continue
        pending = true
        try {
          const result = await workbuddy.checkin(account.id)
          marks[key] = 'ok'
          log({ scope: 'checkin', message: `${account.label}: ${result.message}` })
        } catch (error) {
          // 失败不打勾——下个 tick（30 分钟后）自动重试
          marks[key] = 'fail'
          log({ scope: 'checkin', level: 'warn', message: `${account.label}: ${error?.message ?? error}` })
        }
      }
      if (pending) {
        stores.settings.update(current => ({ ...current, checkinMarks: marks }))
      }
    } catch (error) {
      warn(`周期任务失败：${error?.message ?? error}`)
    }
  }
  const timer = setInterval(() => { void tick() }, 30 * 60_000)
  timer.unref?.()
  setTimeout(() => { void tick() }, 20_000).unref?.()

  // ── 清理 ──────────────────────────────────────────────────────────────────
  ctx.effect(() => () => {
    clearInterval(timer)
    void gateway.stop().catch(() => {})
    stores.dispose()
  }, 'credit-hub: dispose')
}
