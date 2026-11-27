/**
 * 管理面 REST 路由（挂 `/api/credit-hub`）。
 *
 * 设置页的全部数据源。响应只有 JSON；任何秘密（token / API Key）都不回显，
 * 只回 `hasKey` 与指纹。GET 只读，其余一律 POST。
 *
 * @module src/api.js
 */

import fs from 'node:fs'
import crypto from 'node:crypto'
import { loadOrCreateApiKey } from './forward.js'
import { packStateView, packStateFiles, ofmPresent } from './pack-mount.js'
import { now } from './util.js'
import { UpstreamError } from './http.js'
import { assertValid, schemas, rules } from './validate.js'

const MAX_BODY = 1024 * 1024
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/i
const keyFingerprint = key => crypto.createHash('sha256').update(String(key ?? '')).digest('hex').slice(0, 8)

/** 管理面只服务本机：回环 Host + 同源/回环 Origin，兼防跨站与 DNS rebinding。 */
function localRequestAllowed(req) {
  const host = String(req.headers?.host ?? '')
  const origin = String(req.headers?.origin ?? '')
  const site = String(req.headers?.['sec-fetch-site'] ?? '')
  if (host !== '' && !LOOPBACK_HOST.test(host)) return false
  // Electron renderer 可能是 file:// / 自定义 scheme，此时 Origin 为 `null` 或
  // file:// —— 这些是本地页面，应当放行；真正要挡的是 http(s) 跨站来源。
  const localOrigin = origin === '' || origin === 'null' || /^file:\/\//i.test(origin) || LOOPBACK_ORIGIN.test(origin)
  if (!localOrigin) return false
  if (site !== '' && site !== 'same-origin' && site !== 'none') return false
  return true
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('request body too large'), { statusCode: 413 })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 })
  }
}

export function createApiRoutes(deps) {
  const { stores, hub, workbuddy, upstreams, gateway, version, settingsKeys, log, warn } = deps

  const handle = async (req, res) => {
    // 这些守卫在 send 定义之前执行，直接写响应，避免 TDZ。
    if (!localRequestAllowed(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ error: 'management API is loopback-only' }))
    }
    // 可选的强鉴权：设置 adminKey 后所有写操作必须带 x-credit-hub-admin。
    // 默认关闭是因为设置页本身不带凭证，贸然开启会让整个管理页失效。
    const adminKey = String(stores.settings.load().adminKey ?? '')
    if (adminKey && String(req.method ?? 'GET').toUpperCase() !== 'GET'
      && String(req.headers?.['x-credit-hub-admin'] ?? '') !== adminKey) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify({ error: 'admin key required' }))
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const marker = '/api/credit-hub'
    const markerAt = url.pathname.indexOf(marker)
    const routePath = markerAt >= 0 ? url.pathname.slice(markerAt + marker.length).replace(/\/+$/, '') || '/' : '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    const settings = deps.settings ?? (() => stores.settings.load())
    const saveSettings = patch => {
      const dropped = Object.keys(patch ?? {}).filter(key => !settingsKeys.includes(key))
      if (dropped.length > 0) warn?.(`credit-hub api /settings: 忽略未登记的设置键 ${dropped.join(', ')}`)
      stores.settings.update(current => {
        const next = { ...current }
        for (const key of settingsKeys) {
          if (patch[key] !== undefined) next[key] = patch[key]
        }
        return next
      })
      return settings()
    }

    try {
      // ── summary / settings / models / logs ─────────────────────────────────
      if (method === 'GET' && routePath === '/summary') {
        return send(200, {
          version,
          at: now(),
          enabled: settings().enabled !== false,
          workbuddy: workbuddy.status(),
          upstreams: upstreams.status(),
          pack: {
            view: packStateView(stores),
            status: deps.packStatus?.() ?? { mounted: false, reason: 'unknown' },
            ofmPresent: ofmPresent(stores.home),
          },
          gateway: { running: gateway.running, bind: gateway.running ? gateway.bind() : null, stats: gateway.stats() },
          usage: typeof deps.usage === 'function' ? deps.usage() : [],
          breaker: typeof hub.breaker === 'function' ? hub.breaker() : {},
          sources: typeof hub.sourceStatus === 'function' ? hub.sourceStatus() : {},
          modelCount: (await hub.catalog()).length,
        })
      }
      // ── 统一诊断快照（优先级五：前端只读一个接口，避免多处轮询状态漂移） ──
      if (method === 'GET' && routePath === '/diagnostics') {
        const catalogStatus = typeof hub.catalogStatus === 'function' ? hub.catalogStatus() : {}
        const breakerRows = typeof hub.breaker === 'function' ? hub.breaker() : {}
        return send(200, {
          at: now(),
          version,
          ok: settings().enabled !== false && gateway.running !== false,
          catalog: {
            ...catalogStatus,
            sources: typeof hub.sourceStatus === 'function' ? hub.sourceStatus() : {},
          },
          breakers: {
            summary: typeof hub.breakerSummary === 'function' ? hub.breakerSummary() : {},
            entries: breakerRows,
          },
          gateway: {
            running: gateway.running,
            bind: gateway.running ? gateway.bind() : null,
            stats: gateway.stats(),
          },
          channels: {
            workbuddy: workbuddy.status(),
            upstreams: upstreams.status(),
            pack: {
              status: deps.packStatus?.() ?? { mounted: false, reason: 'unknown' },
              ofmPresent: ofmPresent(stores.home),
            },
          },
          // 最近失败原因（前端"最近失败"区块直接用，不再各自拉日志）
          recentFailures: (typeof deps.usage === 'function' ? deps.usage() : [])
            .filter(row => (row.failed ?? 0) > 0)
            .slice(0, 5)
            .map(row => ({ model: row.model, failed: row.failed, lastAt: row.lastAt })),
        })
      }
      if (method === 'GET' && routePath === '/settings') return send(200, { settings: settings() })
      if (method === 'POST' && routePath === '/settings') {
        const body = await readJson(req)
        // 用原始值比较：稀疏配置里没写 gatewayPort 时是 undefined，
        // Number(undefined) 会得到 NaN，NaN !== NaN 会让「保存任何设置」都误重启网关。
        const portBefore = settings().gatewayPort
        const next = saveSettings(body)
        if (next.gatewayEnabled !== false && settings().enabled !== false) {
          // 端口变了必须真正重启：旧版只 start()，start 见已有 server 直接返回，
          // 显示端口与实际监听端口不一致。
          if (settings().gatewayPort !== portBefore) await gateway.stop().catch(() => {})
          await gateway.start().catch(error => warn(`credit-hub: 网关启动失败 ${error?.message ?? error}`))
        } else await gateway.stop().catch(() => {})
        return send(200, { settings: settings() })
      }
      if (method === 'GET' && routePath === '/models') {
        return send(200, { models: await hub.catalog() })
      }
      // ── 强制刷新模型清单（上游新上架模型 / 渠道新增模型） ────────────────
      // 旧版「刷新」只重读缓存，模型上架后永远看不到。这里做真正的刷新：
      //   1. 清 WorkBuddy 模型缓存（含 11102 负缓存）
      //   2. 对所有启用且有 Key 的上游重新 discover（拿最新 /models）
      //   3. 强制重算目录（force=true，跳过 45s 缓存）
      // 单条上游失败不中断，结果里逐条汇报。
      if (method === 'POST' && routePath === '/refresh-models') {
        const before = (await hub.catalog()).length
        const details = { workbuddy: 'skipped', upstreams: [], errors: [] }
        try {
          if (typeof workbuddy.clearModelCache === 'function') workbuddy.clearModelCache()
          details.workbuddy = 'cleared'
        } catch (error) { details.errors.push(`workbuddy: ${String(error?.message ?? error).slice(0, 120)}`) }
        for (const row of upstreams.list()) {
          if (row.enabled === false || row.hasKey !== true) continue
          try {
            const found = await upstreams.discover(row.id)
            details.upstreams.push({ id: row.id, name: row.name, models: found.length })
          } catch (error) {
            details.upstreams.push({ id: row.id, name: row.name, error: String(error?.message ?? error).slice(0, 160) })
            details.errors.push(`${row.name ?? row.id}: ${String(error?.message ?? error).slice(0, 120)}`)
          }
        }
        const rows = await hub.catalog(true)
        hub.invalidate()
        deps.broadcast?.()
        return send(200, {
          before,
          after: rows.length,
          added: Math.max(0, rows.length - before),
          details,
        })
      }
      if (method === 'POST' && routePath === '/models/toggle') {
        const body = await readJson(req)
        assertValid(body, schemas.modelToggle)
        const id = String(body.id ?? '')
        if (!id) throw Object.assign(new Error('id required'), { statusCode: 400 })
        let disabled
        stores.settings.update(current => {
          const map = { ...(current.modelDisabled ?? {}) }
          disabled = body.disabled === undefined ? map[id] !== true : body.disabled === true
          if (disabled) map[id] = true
          else delete map[id]
          return { ...current, modelDisabled: map }
        })
        hub.invalidate()
        deps.broadcast?.()
        return send(200, { id, disabled })
      }
      if (method === 'GET' && routePath === '/pack/probe') {
        const result = {
          ofmPresent: ofmPresent(stores.home),
          mount: deps.packStatus?.() ?? null,
          importOk: false,
        }
        try {
          await import('../vendor/channel-pack/pack.js')
          result.importOk = true
        } catch (error) {
          result.importError = String(error?.message ?? error).slice(0, 400)
        }
        // 两层路径都探测（旧版 env 指到 channel-pack，pack 又自己拼了一层）
        result.stateFiles = packStateFiles(stores).map(file => {
          try {
            const state = JSON.parse(fs.readFileSync(file, 'utf8'))
            const accounts = state?.accounts ?? {}
            return {
              file,
              accounts: Object.entries(accounts).slice(0, 50).map(([id, row]) => ({
                id, provider: row?.provider ?? String(id).split(':')[0], nickname: row?.nickname, enabled: row?.enabled,
              })),
            }
          } catch { return { file, accounts: null } }
        })
        return send(200, result)
      }
      if (method === 'GET' && routePath === '/logs') {
        // 历史日志里可能还留着旧版写入的请求体，读出一律脱敏
        const rows = (typeof deps.logs === 'function' ? deps.logs() : []).map(row => ({
          ...row,
          ...(typeof row?.message === 'string'
            ? { message: row.message.replace(/body=[^\n]{0,2000}/g, 'body=[redacted]') }
            : {}),
        }))
        return send(200, { logs: rows })
      }
      if (method === 'POST' && routePath === '/logs/clear') {
        deps.clearLogs()
        return send(200, { ok: true })
      }

      // ── workbuddy channel ──────────────────────────────────────────────────
      if (routePath.startsWith('/workbuddy')) {
        const action = routePath.slice('/workbuddy'.length)
        if (method === 'GET' && (action === '' || action === '/accounts')) {
          return send(200, { accounts: workbuddy.listAccounts() })
        }
        if (method === 'POST' && action === '/login') {
          const body = await readJson(req)
          assertValid(body, schemas.workbuddyRealm)
          return send(200, await workbuddy.startLogin(body.realm === 'global' ? 'global' : 'cn'))
        }
        if (method === 'POST' && action === '/poll') {
          const body = await readJson(req)
          assertValid(body, { loginId: [rules.string('loginId', { max: 120 })] })
          return send(200, await workbuddy.pollLogin(String(body.loginId ?? '')))
        }
        if (method === 'POST' && action === '/import') {
          const body = await readJson(req)
          assertValid(body, {
            accessToken: [rules.string('accessToken', { max: 4096 })],
            refreshToken: [rules.secret('refreshToken', { max: 4096 })],
            realm: [rules.enum('realm', ['cn', 'global'], { optional: true })],
            label: [rules.string('label', { max: 80, optional: true })],
          })
          return send(200, { account: workbuddy.importAccount(body) })
        }
        if (method === 'POST' && action === '/remove') {
          const body = await readJson(req)
          assertValid(body, schemas.workbuddyAction)
          await workbuddy.remove(String(body.id ?? ''))
          hub.invalidate()
          deps.broadcast?.()
          return send(200, { accounts: workbuddy.listAccounts() })
        }
        if (method === 'POST' && action === '/enable') {
          const body = await readJson(req)
          assertValid(body, schemas.workbuddyAction)
          await workbuddy.setEnabled(String(body.id ?? ''), body.enabled === true)
          hub.invalidate()
          deps.broadcast?.()
          return send(200, { accounts: workbuddy.listAccounts() })
        }
        if (method === 'POST' && action === '/credits') {
          const body = await readJson(req)
          assertValid(body, schemas.workbuddyAction)
          return send(200, { credits: await workbuddy.fetchCredits(String(body.id ?? '')) })
        }
        if (method === 'POST' && action === '/checkin') {
          const body = await readJson(req)
          assertValid(body, schemas.workbuddyAction)
          return send(200, await workbuddy.checkin(String(body.id ?? '')))
        }
        return send(404, { error: 'not found' })
      }

      // ── upstreams ──────────────────────────────────────────────────────────
      if (routePath.startsWith('/upstreams')) {
        const action = routePath.slice('/upstreams'.length)
        if (method === 'GET' && (action === '' || action === '/')) return send(200, { upstreams: upstreams.list() })
        if (method === 'GET' && action === '/presets') return send(200, { presets: upstreams.presets })
        if (method === 'POST' && action === '/save') {
          const body = await readJson(req)
          assertValid(body, schemas.upstreamSave)
          const view = upstreams.upsert(body)
          hub.invalidate()
          deps.broadcast?.()
          return send(200, { upstream: view })
        }
        if (method === 'POST' && action === '/install') {
          const body = await readJson(req)
          assertValid(body, schemas.presetInstall)
          return send(200, { upstream: upstreams.installPreset(String(body.presetId ?? '')) })
        }
        if (method === 'POST' && action === '/remove') {
          const body = await readJson(req)
          assertValid(body, schemas.upstreamAction)
          upstreams.remove(String(body.id ?? ''))
          hub.invalidate()
          deps.broadcast?.()
          return send(200, { upstreams: upstreams.list() })
        }
        if (method === 'POST' && action === '/enable') {
          const body = await readJson(req)
          assertValid(body, schemas.upstreamAction)
          upstreams.setEnabled(String(body.id ?? ''), body.enabled === true)
          hub.invalidate()
          deps.broadcast?.()
          return send(200, { upstreams: upstreams.list() })
        }
        if (method === 'POST' && action === '/discover') {
          const body = await readJson(req)
          assertValid(body, schemas.upstreamAction)
          const found = await upstreams.discover(String(body.id ?? ''))
          hub.invalidate()
          deps.broadcast?.()
          return send(200, { models: found })
        }
        return send(404, { error: 'not found' })
      }

      // ── combos（降级链） ────────────────────────────────────────────────────
      if (method === 'GET' && routePath === '/combos') return send(200, { combos: hub.combos() })
      if (method === 'POST' && routePath === '/combos/save') {
        const body = await readJson(req)
        assertValid(body, schemas.comboSave)
        const list = Array.isArray(body.combos) ? body.combos : []
        const clean = list.map(row => ({
          name: String(row.name ?? '').trim().slice(0, 60),
          strategy: row.strategy === 'round-robin' ? 'round-robin' : 'fallback',
          chain: (Array.isArray(row.chain) ? row.chain : []).map(String).filter(Boolean),
        })).filter(row => row.name && row.chain.length > 0)
        await hub.setCombos(clean)
        deps.broadcast?.()
        return send(200, { combos: hub.combos() })
      }

      // ── 熔断器诊断（清单：可观测 + 手动恢复） ──────────────────────────────
      if (method === 'GET' && routePath === '/breaker') {
        return send(200, { breaker: typeof hub.breaker === 'function' ? hub.breaker() : {} })
      }
      // 手动重置单独暴露为 POST + confirm 语义（前端二次确认），避免误操作
      // 影响在线流量：重置会把冷却中的成员立即放回轮转。
      if (method === 'POST' && routePath === '/breaker/reset') {
        const body = await readJson(req)
        if (typeof hub.resetBreaker !== 'function') return send(404, { error: 'not supported' })
        hub.resetBreaker(Array.isArray(body.ids) ? body.ids.filter(row => typeof row === 'string') : undefined)
        deps.broadcast?.()
        return send(200, { breaker: hub.breaker() })
      }

      // ── gateway ────────────────────────────────────────────────────────────
      if (method === 'GET' && routePath === '/gateway') {
        const key = gateway.running ? gateway.key() : loadOrCreateApiKey(stores.gatewayDir)
        return send(200, {
          running: gateway.running,
          bind: gateway.running ? gateway.bind() : null,
          key,
          keyFingerprint: keyFingerprint(key),
          stats: gateway.stats(),
        })
      }
      if (method === 'POST' && routePath === '/gateway/restart') {
        await gateway.stop().catch(() => {})
        await gateway.start()
        return send(200, { running: true, bind: gateway.bind(), key: gateway.key() })
      }
      if (method === 'POST' && routePath === '/gateway/set-key') {
        const body = await readJson(req)
        assertValid(body, schemas.gatewaySetKey)
        const key = await gateway.setKey(String(body.key ?? ''))
        return send(200, { key })
      }

      return send(404, { error: 'not found' })
    } catch (error) {
      const status = error instanceof UpstreamError ? (error.code === 'AUTH' ? 502 : 400)
        : Number.isInteger(error?.statusCode) ? error.statusCode : 500
      log?.({ at: now(), level: 'error', scope: routePath, message: String(error?.message ?? error) })
      warn?.(`credit-hub api ${routePath}: ${error?.message ?? error}`)
      return send(status, { error: String(error?.message ?? error) })
    }
  }

  // 宿主的 webServer 未必消费 async 返回值：显式 catch，避免漏网异常变成
  // unhandledRejection 把 DSH host 带崩。
  return function handler(req, res) {
    void handle(req, res).catch(error => {
      warn?.(`credit-hub api: 未捕获异常：${error?.message ?? error}`)
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ error: 'internal api error' }))
      }
    })
  }
}
