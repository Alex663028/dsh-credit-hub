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
          modelCount: (await hub.catalog()).length,
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
      if (method === 'POST' && routePath === '/models/toggle') {
        const body = await readJson(req)
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
          return send(200, await workbuddy.startLogin(body.realm === 'global' ? 'global' : 'cn'))
        }
        if (method === 'POST' && action === '/poll') {
          const body = await readJson(req)
          return send(200, await workbuddy.pollLogin(String(body.loginId ?? '')))
        }
        if (method === 'POST' && action === '/import') {
          const body = await readJson(req)
          return send(200, { account: workbuddy.importAccount(body) })
        }
        if (method === 'POST' && action === '/remove') {
          const body = await readJson(req)
          await workbuddy.remove(String(body.id ?? ''))
          hub.invalidate()
          deps.broadcast?.()
          return send(200, { accounts: workbuddy.listAccounts() })
        }
        if (method === 'POST' && action === '/enable') {
          const body = await readJson(req)
          await workbuddy.setEnabled(String(body.id ?? ''), body.enabled === true)
          hub.invalidate()
          deps.broadcast?.()
          return send(200, { accounts: workbuddy.listAccounts() })
        }
        if (method === 'POST' && action === '/credits') {
          const body = await readJson(req)
          return send(200, { credits: await workbuddy.fetchCredits(String(body.id ?? '')) })
        }
        if (method === 'POST' && action === '/checkin') {
          const body = await readJson(req)
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
          const view = upstreams.upsert(body)
          hub.invalidate()
          deps.broadcast?.()
          return send(200, { upstream: view })
        }
        if (method === 'POST' && action === '/install') {
          const body = await readJson(req)
          return send(200, { upstream: upstreams.installPreset(String(body.presetId ?? '')) })
        }
        if (method === 'POST' && action === '/remove') {
          const body = await readJson(req)
          upstreams.remove(String(body.id ?? ''))
          hub.invalidate()
          deps.broadcast?.()
          return send(200, { upstreams: upstreams.list() })
        }
        if (method === 'POST' && action === '/enable') {
          const body = await readJson(req)
          upstreams.setEnabled(String(body.id ?? ''), body.enabled === true)
          hub.invalidate()
          deps.broadcast?.()
          return send(200, { upstreams: upstreams.list() })
        }
        if (method === 'POST' && action === '/discover') {
          const body = await readJson(req)
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
