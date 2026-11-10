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
import fs from 'node:fs'
import path from 'node:path'
import { createStores } from './src/store.js'
import { createWorkbuddyRuntime } from './src/workbuddy.js'
import { createUpstreamRuntime } from './src/aggregate.js'
import { createHubRuntime, ROUTE_MAIN } from './src/hub.js'
import { startGateway } from './src/forward.js'
import { createApiRoutes } from './src/api.js'
import { mountAccountPack } from './src/pack-mount.js'
import { createPackBridge } from './src/pack-bridge.js'
import { createWorkbuddyAdapter } from './src/workbuddy-adapter.js'
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
    thinkingOffByDefault: Schema.boolean().default(false).description('调用方未指定思考强度时默认关思考（提升简单客户端兼容性）'),
    packGateway: Schema.boolean().default(false).description('渠道包自带 8326 网关（单网关策略下保持关闭）'),
  }).description('积分汇通')
} catch (error) {
  // 旧版静默吞掉：link: 协议下 peerDeps 不解析时完全无感，配置面板降级不明不白
  console.warn?.(`credit-hub: @deepseek-ai/schemastery 不可用，宿主配置面板降级（运行态不受影响）：${error?.message ?? error}`)
}

export const name = 'credit-hub'

const SETTINGS_DEFAULTS = {
  enabled: true,
  gatewayEnabled: true,
  gatewayPort: 8330,
  accountPack: 'auto',
  autoCheckin: false,
  thinkingOffByDefault: false,
  // 单网关策略：8330 已通过 pack 桥接汇总全部模型，渠道包自带的 8326
  // 本地网关默认停用（进程级 env 硬开关，pack 的 RPC 也打不开）。
  packGateway: false,
}

/** llm 是唯一硬依赖：没有它本插件无事可做，其余服务缺席只降级单个功能。 */
export const inject = ['llm']

const SETTINGS_KEYS = ['enabled', 'gatewayEnabled', 'gatewayPort', 'accountPack', 'defaultMaxTokens', 'autoCheckin', 'onboardingSeen', 'modelDisabled', 'chainSilenceMs', 'singleSilenceMs', 'singleTurnMaxMs', 'packGateway', 'thinkingOffByDefault', 'schemaVersion', 'allowQueryKey', 'adminKey']

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const stores = createStores()
  // 数据格式迁移只跑一次：老版本的 checkinMarks 布尔键、缺失的 schemaVersion
  stores.migrate?.()
  // 分层配置：DEFAULTS < 宿主 config（profile patch）< settings.json。
  // settings.json 是设置页写入的**稀疏覆盖层**——首次启动不预写全量键，
  // 用户没在设置页改过的键，宿主配置面板的改动就真实生效。
  const patchConfig = config && typeof config === 'object' ? config : {}
  const settings = () => ({ ...SETTINGS_DEFAULTS, ...patchConfig, ...stores.settings.load() })
  const logRing = createRing(400)
  // 落盘日志：JSONL 追加写（异步、失败静默），供离线排查——超过 1MB 轮换成 .old
  const logFile = path.join(stores.dir, 'logs.jsonl')
  const oldLogFile = `${logFile}.old`
  let logWriteWarned = false
  const appendLog = row => {
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) {
        // 轮换前清掉上一份 .old，避免无限堆积；写失败只告警一次，不刷屏
        try { fs.rmSync(oldLogFile, { force: true }) } catch {}
        fs.renameSync(logFile, oldLogFile)
      }
      fs.appendFileSync(logFile, JSON.stringify(row) + '\n')
    } catch (error) {
      if (!logWriteWarned) {
        logWriteWarned = true
        logger.warn?.(`credit-hub: 运行日志写入失败（后续不再重复告警）：${error?.message ?? error}`)
      }
    }
  }
  const log = row => {
    // 兼容历史调用方误传字符串（旧版会把字符串展开成逐字符畸形日志）
    const input = typeof row === 'string' ? { message: row }
      : (row && typeof row === 'object' ? row : { message: String(row) })
    const full = { at: now(), level: 'info', ...input }
    // 兜底脱敏：任何调用方再把请求体拼进 message 都在这里截掉
    if (typeof full.message === 'string') {
      full.message = full.message.replace(/body=[^\n]{0,2000}/g, 'body=[redacted]').slice(0, 2000)
    }
    logRing.push(full)
    appendLog(full)
  }
  const warn = message => {
    logger.warn?.(`credit-hub: ${message}`)
    const full = { at: now(), level: 'warn', message: String(message).slice(0, 500) }
    logRing.push(full)
    appendLog(full)
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
  // 默认必须显式关掉 8326：旧版只在 `=== false` 时设置，配置层一旦被覆盖
  // 就变成隐式默认开启，两个网关抢端口会把 host 带崩。
  if (settings().packGateway !== true) {
    process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'
    logger.info?.('credit-hub: 渠道包 8326 本地网关已按单网关策略停用（settings.packGateway）')
  } else {
    delete process.env.DSH_OPENAI_GATEWAY_ENABLED
  }

  const workbuddy = createWorkbuddyRuntime({ stores, log, warn, onAccountsChanged: broadcastCatalogChanged })
  const upstreams = createUpstreamRuntime({ stores, log })
  // 渠道包模型桥接：把宿主 llm 注册表里的渠道包 provider（raccoon/qoder/…）
  // 以 `pk/<provider>/<model>` 并入目录；请求走 ctx.llm.stream 进程内转发。
  const packBridge = createPackBridge({ logger, warn })
  packBridge.setLlm(ctx.llm)
  // 逐模型用量：内存聚合 + 节流落盘（旧版进程重启即清零）
  let disposed = false
  const usageFile = path.join(stores.dir, 'usage.json')
  const usageStats = new Map()
  try {
    const saved = JSON.parse(fs.readFileSync(usageFile, 'utf8'))
    for (const [model, row] of Object.entries(saved?.models ?? {})) {
      if (row && typeof row === 'object') {
        usageStats.set(model, { ok: 0, failed: 0, skipped: 0, inputTokens: 0, outputTokens: 0, lastAt: 0, ...row })
      }
    }
  } catch {}
  let usageFlushTimer = null
  const flushUsage = () => {
    if (usageFlushTimer) { clearTimeout(usageFlushTimer); usageFlushTimer = null }
    try {
      const temp = `${usageFile}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ at: now(), models: Object.fromEntries(usageStats) }, null, 2))
      fs.renameSync(temp, usageFile)
    } catch {}
  }
  const scheduleUsageFlush = () => {
    if (usageFlushTimer || disposed) return
    usageFlushTimer = setTimeout(() => { usageFlushTimer = null; flushUsage() }, 5000)
    usageFlushTimer.unref?.()
  }
  const recordTurn = ({ model, ok, skipped, usage }) => {
    const row = usageStats.get(model) ?? { ok: 0, failed: 0, skipped: 0, inputTokens: 0, outputTokens: 0, lastAt: 0 }
    if (ok === true) row.ok += 1
    else if (skipped === true) row.skipped += 1
    else row.failed += 1
    row.inputTokens += usage?.inputTokens ?? 0
    row.outputTokens += usage?.outputTokens ?? 0
    row.lastAt = now()
    usageStats.set(model, row)
    scheduleUsageFlush()
    log({ scope: 'turn', message: `${model}: ${ok === true ? 'ok' : skipped === true ? 'skipped' : 'failed'}` })
  }
  const hub = createHubRuntime({ stores, workbuddy, upstreams, packBridge, logger, warn, recordTurn, settings })
  const gateway = startGateway({ stores, hub, logger, settings, log })

  // ── 模型车道注册 ───────────────────────────────────────────────────────────
  // 聚合路由 credit-hub 供管理面/网关/降级链使用。
  let registration
  try {
    registration = ctx.llm.registerAdapter([ROUTE_MAIN], hub.adapter)
    logger.info?.(`credit-hub: 模型车道已注册（${ROUTE_MAIN}）`)
  } catch (error) {
    warn(`llm.registerAdapter 失败：${error?.message ?? error}`)
  }
  ctx.effect(() => () => { registration?.() }, 'credit-hub: adapter routes')

  // WorkBuddy 独立 provider：DSH 模型选择器按 provider 分组展示（channel-pack
  // 的 qoder/raccoon 都是独立 provider 才能进选择器），credit-hub 聚合路由
  // 不保证出现在聊天框选择器里。单独注册 workbuddy 让「WorkBuddy」分组直接
  // 可选；请求映射回 credit-hub 完整目录 id，复用统一流转。
  // 安全：本 adapter 的 listModels 直接调 workbuddy.listModels()，不经过
  // hub.catalog；packBridge 排除表已加 'workbuddy'，不会桥接成 pk/workbuddy/*。
  let wbRegistration
  try {
    wbRegistration = ctx.llm.registerAdapter(['workbuddy'], createWorkbuddyAdapter({ workbuddy, hub, settings }))
    logger.info?.('credit-hub: WorkBuddy 独立车道已注册（workbuddy）')
  } catch (error) {
    warn(`credit-hub: workbuddy 车道注册失败：${error?.message ?? error}`)
  }
  ctx.effect(() => () => { wbRegistration?.() }, 'credit-hub: workbuddy adapter route')

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
  // 挂载链必须有 catch + dispose：未处理的 rejection 会带崩 host；卸载时不清理
  // 会在下一轮 apply 里重复注册 RPC/路由/8326 端口。
  let packDispose = null
  ctx.inject(['credentials', 'commands', 'llm'], scoped => {
    void mountAccountPack(scoped, { settings, stores, logger, warn })
      .then(status => {
        packStatus = status
        const dispose = typeof status?.dispose === 'function' ? status.dispose : null
        if (disposed) { try { dispose?.() } catch {} } else packDispose = dispose
      })
      .catch(error => warn(`credit-hub: account pack 挂载链异常：${error?.message ?? error}`))
  })

  // ── 周期任务：token 刷新 + 可选每日签到 + 模型目录广播 ────────────────────
  const tick = async () => {
    if (disposed) return
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
      // 每 5 分钟广播一次模型目录变化，确保 DSH UI 能刷到新的 hub catalog
      if (ctx.llm?.emitAdaptersUpdated) {
        ctx.llm.emitAdaptersUpdated()
      }
    } catch (error) {
      warn(`周期任务失败：${error?.message ?? error}`)
    }
  }
  const timer = setInterval(() => { void tick() }, 30 * 60_000)
  timer.unref?.()
  // 句柄必须保存并在 dispose 清理：旧版卸载后 20s 仍会跑一次 tick
  const startTimer = setTimeout(() => { void tick() }, 20_000)
  startTimer.unref?.()

  // ── 清理 ──────────────────────────────────────────────────────────────────
  ctx.effect(() => () => {
    disposed = true
    clearInterval(timer)
    clearTimeout(startTimer)
    flushUsage()
    try { packDispose?.() } catch (error) { warn(`credit-hub: account pack 卸载失败：${error?.message ?? error}`) }
    packDispose = null
    void gateway.stop().catch(error => warn(`credit-hub: 网关关闭失败：${error?.message ?? error}`))
    stores.dispose()
  }, 'credit-hub: dispose')
}
