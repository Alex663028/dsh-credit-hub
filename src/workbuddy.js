/**
 * WorkBuddy / CodeBuddy（腾讯）原生账号渠道。
 *
 * 协议对齐开源参考 workbuddy2api（MIT, Sliverkiss / linguo2625469）：
 * 设备授权流登录、OpenAI 格式直通 + 少量出站修正、`{code,msg,data}` 业务信封、
 * 三域分工（chat=copilot.tencent.com，billing=www.codebuddy.cn，web=www.workbuddy.cn；
 * global 全部 www.workbuddy.ai）。
 *
 * 个人自用规模：多账号导入 + 轮转 + 冷却 + 单飞 refresh；刻意不做
 * WAF 对抗、IP 轮换与批量任务脚本。refreshToken 上游反重放——同账号
 * refresh 必须单飞，并发第二发会整条链作废（12153）。
 *
 * @module src/workbuddy.js
 */

import crypto from 'node:crypto'
import { postJson, getJson, postSse, UpstreamError, CODE } from './http.js'
import { createNormalizer } from './normalize.js'
import { toChatMessages, toChatTools, repairWorkbuddyBody } from './wire.js'
import { mintId, now, clamp, sanitizeEfforts } from './util.js'

const CHAT_BASE = { cn: 'https://copilot.tencent.com', global: 'https://www.workbuddy.ai' }
const BILLING_BASE = { cn: 'https://www.codebuddy.cn', global: 'https://www.workbuddy.ai' }
const WEB_BASE = { cn: 'https://www.workbuddy.cn', global: 'https://www.workbuddy.ai' }
const LOGIN_ORIGIN = { cn: 'https://www.codebuddy.cn', global: 'https://www.workbuddy.ai' }

const LOGIN_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const CLIENT_VERSION = '5.5.4'
const CLI_VERSION = '2.137.1'
const CHAT_UA = {
  cn: `WorkBuddy/${CLIENT_VERSION} WorkBuddy/${CLIENT_VERSION} CLI/${CLI_VERSION}`,
  global: `WorkBuddy/${CLIENT_VERSION} WorkBuddy AI/${CLIENT_VERSION} CLI/${CLI_VERSION}`,
}
const MODELS_UA = 'CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0'

/** 降级告警去重：同一原因只报一次，避免每次拉目录都刷屏。 */
const degradationWarned = new Set()

/**
 * 目录 id 是 `wb/<realm>/<model>`（见 listModels），而 streamTurn 早期接口
 * 直接收 `<realm>/<model>`。两种都认，且 global 必须走国际版账号池。
 * 旧实现只切第一段：`wb/cn/hy4free` 会被拆成 realm=cn / model=`cn/hy4free`，
 * 上游必然 400/11102「service info not found」；`wb/global/*` 还会被误投到
 * 国内版账号。同时 `${realm}/${bare}` 负缓存 key 也因此永远对不上。
 */
export function parseWorkbuddyModelId(modelId) {
  const raw = String(modelId ?? '')
  const parts = raw.split('/')
  if (parts[0] === 'wb' && parts.length >= 3) {
    return { realm: parts[1] === 'global' ? 'global' : 'cn', bare: parts.slice(2).join('/') }
  }
  if (parts.length >= 2) {
    return { realm: parts[0] === 'global' ? 'global' : 'cn', bare: parts.slice(1).join('/') }
  }
  return { realm: 'cn', bare: raw }
}

const staticCatalog = [
  { id: 'default-model', name: 'WorkBuddy Auto', contextWindow: 168000, maxOutput: 16384 },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1000000, maxOutput: 384000, reasoning: true, efforts: ['high'] },
  { id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 1000000, maxOutput: 131072, reasoning: true, efforts: ['high', 'xhigh'] },
  { id: 'glm-5.2', name: 'GLM 5.2', contextWindow: 1000000, maxOutput: 131072, reasoning: true, efforts: ['high', 'xhigh'] },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1048576, maxOutput: 131072 },
  { id: 'minimax-m3', name: 'MiniMax M3', contextWindow: 512000, maxOutput: 512000, reasoning: true },
  { id: 'hy4-preview', name: 'Hunyuan 4 Preview', contextWindow: 1000000, maxOutput: 64000 },
  { id: 'gpt-6-astra', name: 'GPT 6 Astra', contextWindow: 1050000, maxOutput: 128000, reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
]

const hex = bytes => crypto.randomBytes(bytes).toString('hex')
const sha36 = seed => crypto.createHash('sha256').update(seed).digest('hex').slice(0, 36)

const EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function nearestEffort(requested, supported) {
  if (!Array.isArray(supported) || supported.length === 0) return 'high'
  if (supported.includes(requested)) return requested
  const rank = value => EFFORT_LADDER.indexOf(value)
  const ceiling = supported.filter(value => rank(value) <= rank(requested))
  return ceiling.length > 0 ? ceiling[ceiling.length - 1] : supported[0]
}

function classify(status, envelope, message) {
  const code = typeof envelope?.code === 'number' ? envelope.code : undefined
  const text = String(message ?? envelope?.msg ?? '')
  if (status === 402 || code === 14018 || /积分不足|insufficient credit|额度不足/.test(text)) return 'hard-credit'
  if (code === 6004) return 'model-rate'
  if (status === 429) return 'soft-rate'
  if (status === 401 || code === 12153 || /offline user session not found/.test(text)) return 'session-dead'
  if (code === 11128) return 'channel-refused'
  if (code === 11140 || code === 14017) return 'account-fault'
  if (code === 11102 || code === 11158) return 'model-blocked'
  if (code === 6021) return 'busy'
  if (/blocked by security policy|unapproved channel|illegal api invocation/.test(text)) return 'content-blocked'
  if (code === 11115 || /prompt is too long/i.test(text)) return 'prompt-too-long'
  if (code === 11101 || /unmarshal chat params failed/i.test(text)) return 'bad-params'
  if (status === 403 && envelope === undefined) return 'waf'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'unknown'
}

/** Open one account's credential header set (never logs the token). */
function chatHeaders(account, { conversationId, requestId, messageId, accept = 'application/json, text/event-stream' } = {}) {
  const realm = account.realm
  const auth = account.auth ?? {}
  const uid = account.account?.uid ?? ''
  const enterprise = account.account?.enterpriseId ?? ''
  const domain = auth.domain ?? CHAT_BASE[realm]
  const headers = {
    'content-type': 'application/json',
    accept,
    'x-requested-with': 'XMLHttpRequest',
    origin: LOGIN_ORIGIN[realm],
    referer: `${LOGIN_ORIGIN[realm]}/`,
    'user-agent': CHAT_UA[realm],
    'x-codebuddy-request': '1',
    'accept-language': realm === 'cn' ? 'zh-CN' : 'en-US',
    'x-machine-id': sha36(`credit-hub:machine:${uid || account.id}`),
    'x-session-id': sha36(`credit-hub:session:${uid || account.id}`),
    'x-user-id': uid || '0',
    'x-agent-purpose': 'conversation',
    'x-ide-name': 'WorkBuddy',
    'x-ide-type': 'WorkBuddy',
    'x-ide-version': CLIENT_VERSION,
    'x-product': 'WorkBuddy',
    'x-conversation-id': conversationId ?? hex(16),
    'x-conversation-request-id': requestId ?? hex(16),
    'x-conversation-message-id': messageId ?? hex(16),
    'x-request-id': messageId ?? hex(16),
    'x-root-request-id': requestId ?? hex(16),
    'x-trace-id': requestId ?? hex(16),
    'x-b3-traceid': requestId ?? hex(16),
    'x-b3-spanid': hex(8),
    'x-b3-sampled': '1',
    'x-domain': domain,
  }
  if (auth.accessToken) headers.authorization = `Bearer ${auth.accessToken}`
  else headers['x-no-authorization'] = '1'
  if (realm === 'global' || !enterprise) headers['x-no-enterprise-id'] = '1'
  else headers['x-enterprise-id'] = enterprise
  return headers
}

function refreshHeaders(account) {
  const headers = chatHeaders(account, { accept: 'application/json' })
  headers['x-refresh-token'] = account.auth?.refreshToken ?? ''
  headers['x-auth-refresh-source'] = 'plugin'
  delete headers['x-agent-purpose']
  delete headers['x-ide-name']
  delete headers['x-ide-type']
  delete headers['x-ide-version']
  delete headers['x-conversation-id']
  delete headers['x-conversation-request-id']
  delete headers['x-conversation-message-id']
  delete headers['x-request-id']
  delete headers['x-root-request-id']
  delete headers['x-trace-id']
  delete headers['x-b3-traceid']
  delete headers['x-b3-spanid']
  delete headers['x-b3-sampled']
  return headers
}

function billingHeaders(account) {
  const realm = account.realm
  const uid = account.account?.uid ?? ''
  const enterprise = account.account?.enterpriseId ?? ''
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-codebuddy-request': '1',
    'accept-language': realm === 'cn' ? 'zh-CN' : 'en-US',
    'user-agent': `WorkBuddy/${CLIENT_VERSION}`,
    'x-user-id': uid || '0',
    'x-domain': account.auth?.domain ?? CHAT_BASE[realm],
  }
  if (account.auth?.accessToken) headers.authorization = `Bearer ${account.auth.accessToken}`
  if (enterprise) {
    headers['x-enterprise-id'] = enterprise
    headers['x-tenant-id'] = enterprise
  }
  return headers
}

export function createWorkbuddyRuntime({ stores, log, warn, onAccountsChanged }) {
  const logins = new Map()
  const refreshing = new Map()
  const modelCache = new Map()
  // 11102（模型被后端拒绝）负缓存：`<realm>/<modelId>` → 隐藏截止时间
  const modelBlockUntil = new Map()
  let rotateCursor = 0

  const readAccounts = () => {
    const data = stores.accounts.load()
    if (!Array.isArray(data.workbuddy)) data.workbuddy = []
    return data.workbuddy
  }
  const writeAccounts = list => stores.accounts.update(data => ({ ...data, workbuddy: list }))

  const cooling = account => typeof account.cooldownUntil === 'number' && account.cooldownUntil > now()
  const cool = (account, ms, reason) => {
    account.cooldownUntil = now() + ms
    account.cooldownReason = reason
  }

  const publicView = account => ({
    id: account.id,
    label: account.label ?? account.account?.nickname ?? account.account?.uid?.slice(0, 8) ?? 'workbuddy',
    realm: account.realm,
    uid: account.account?.uid,
    nickname: account.account?.nickname,
    enterprise: Boolean(account.account?.enterpriseId),
    enabled: account.enabled !== false,
    credits: account.credits ?? null,
    state: account.disabled === true ? 'disabled'
      : account.state === 'dead' ? 'dead'
      : cooling(account) ? 'cooling' : 'ok',
    reason: account.reason ?? account.cooldownReason,
    cooldownUntil: account.cooldownUntil,
    tokenExpiresAt: account.auth?.expiresAt,
    lastError: account.lastError,
  })

  // ── login（设备授权流：服务端签发 state） ─────────────────────────────────
  async function startLogin(realm = 'cn') {
    const base = CHAT_BASE[realm] ?? CHAT_BASE.cn
    const body = await postJson(`${base}/v2/plugin/auth/state?platform=CLI`, {
      headers: loginHeaders(realm),
      body: {},
    })
    if (body?.code !== 0 && body?.code !== undefined && !body?.data) {
      throw new UpstreamError(`登录发起失败：${body?.msg ?? 'unknown'}`, CODE.client)
    }
    const loginId = mintId('wblogin')
    logins.set(loginId, { state: body.data.state, realm, startedAt: now() })
    return { loginId, realm, authUrl: body.data.authUrl }
  }

  const loginHeaders = realm => ({
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    'x-requested-with': 'XMLHttpRequest',
    origin: LOGIN_ORIGIN[realm],
    referer: `${LOGIN_ORIGIN[realm]}/`,
    'user-agent': LOGIN_UA,
  })

  async function pollLogin(loginId) {
    const pending = logins.get(loginId)
    if (!pending) return { status: 'expired' }
    if (now() - pending.startedAt > 5 * 60_000) {
      logins.delete(loginId)
      return { status: 'expired' }
    }
    const base = CHAT_BASE[pending.realm]
    const body = await getJson(`${base}/v2/plugin/auth/token?state=${encodeURIComponent(pending.state)}`, {
      headers: loginHeaders(pending.realm),
    }).catch(error => {
      if (error?.code === CODE.auth) return null
      throw error
    })
    if (!body || body?.code !== 0 || !body?.data?.accessToken) return { status: 'pending' }
    const token = body.data
    const account = {
      id: mintId('wb'),
      realm: pending.realm,
      enabled: true,
      auth: {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: now() + Number(token.expiresIn ?? 5184000) * 1000,
        domain: token.domain,
      },
      account: null,
      credits: null,
    }
    try {
      const info = await getJson(`${base}/v2/plugin/login/account?state=${encodeURIComponent(pending.state)}`, {
        headers: { ...loginHeaders(pending.realm), authorization: `Bearer ${token.accessToken}` },
      })
      if (info?.data) account.account = { uid: info.data.uid, enterpriseId: info.data.enterpriseId ?? '', nickname: info.data.nickname ?? '' }
    } catch {}
    if (!account.account) account.account = { uid: '', enterpriseId: '', nickname: 'workbuddy' }
    account.label = account.account.nickname || account.account.uid.slice(0, 8)
    const list = readAccounts().filter(row => row.id !== account.id)
    list.push(account)
    writeAccounts(list)
    logins.delete(loginId)
    // 登录成功 = 目录新增一个 realm 的模型池，调用方需刷新目录缓存
    onAccountsChanged?.()
    return { status: 'done', account: publicView(account) }
  }

  /** Manual import — pasted tokens from the official client or a wb2api auth file. */
  function importAccount({ realm = 'cn', accessToken, refreshToken, expiresIn = 5184000, domain, uid = '', enterpriseId = '', nickname = '' }) {
    if (typeof accessToken !== 'string' || accessToken.length < 16) throw new UpstreamError('accessToken 缺失或过短', CODE.client)
    const account = {
      id: mintId('wb'),
      realm: realm === 'global' ? 'global' : 'cn',
      enabled: true,
      auth: { accessToken, refreshToken: refreshToken ?? '', expiresAt: now() + Number(expiresIn) * 1000, domain },
      account: { uid, enterpriseId, nickname },
      credits: null,
    }
    account.label = nickname || uid.slice(0, 8) || 'workbuddy'
    const list = readAccounts().filter(row => row.id !== account.id)
    list.push(account)
    writeAccounts(list)
    onAccountsChanged?.()
    return publicView(account)
  }

  // ── refresh（单飞——refreshToken 反重放） ─────────────────────────────────
  function refreshAccount(account) {
    const inflight = refreshing.get(account.id)
    if (inflight) return inflight
    const job = (async () => {
      const base = CHAT_BASE[account.realm]
      try {
        const body = await postJson(`${base}/v2/plugin/auth/token/refresh`, { headers: refreshHeaders(account), body: undefined })
        if (body?.code !== 0 || !body?.data?.accessToken) {
          const verdict = classify(200, body, body?.msg)
          if (verdict === 'session-dead' || verdict === 'account-fault') {
            account.state = 'dead'
            account.reason = body?.msg ?? 'refresh rejected'
            warn?.(`credit-hub: workbuddy ${account.label} refresh rejected — 重新登录该账号`)
          }
          return false
        }
        account.auth = {
          accessToken: body.data.accessToken,
          refreshToken: body.data.refreshToken ?? account.auth.refreshToken,
          expiresAt: now() + Number(body.data.expiresIn ?? 5184000) * 1000,
          domain: body.data.domain ?? account.auth.domain,
        }
        writeAccounts(readAccounts())
        return true
      } finally {
        refreshing.delete(account.id)
      }
    })()
    refreshing.set(account.id, job)
    return job
  }

  async function ensureFresh(account) {
    const expiresAt = account.auth?.expiresAt ?? 0
    if (expiresAt - now() < 10 * 60_000 && account.auth?.refreshToken) {
      await refreshAccount(account).catch(() => {})
    }
  }

  // ── account pick + rotation ───────────────────────────────────────────────
  function pool(realm) {
    return readAccounts().filter(row => row.realm === realm && row.enabled !== false && row.state !== 'dead')
  }

  function punish(account, verdict) {
    if (verdict === 'hard-credit') cool(account, 12 * 3600_000, '积分耗尽')
    else if (verdict === 'soft-rate') cool(account, 600_000, '限流冷却')
    else if (verdict === 'session-dead') cool(account, 120_000, '会话失效')
    else if (verdict === 'account-fault') {
      account.state = 'dead'
      account.reason = '账号被风控限制（11140），需申诉或重登'
    } else if (verdict === 'waf') cool(account, 60_000 + Math.floor(Math.random() * 30_000), 'WAF 拦截')
    else if (verdict === 'server') cool(account, 30_000, '上游 5xx')
    writeAccounts(readAccounts())
  }

  // ── models ────────────────────────────────────────────────────────────────
  async function fetchModels(realm) {
    const cached = modelCache.get(realm)
    if (cached && cached.expiresAt > now()) return cached.entries
    const account = pool(realm)[0]
    if (!account) return staticCatalog
    await ensureFresh(account)
    const base = CHAT_BASE[realm]
    const headers = {
      ...billingHeaders(account),
      accept: 'application/json, text/plain, */*',
      'user-agent': MODELS_UA,
      'x-product': 'SaaS',
      'x-domain': account.auth?.domain ?? CHAT_BASE[realm],
    }
    let entries = null
    try {
      const body = await getJson(`${base}/v3/config`, { headers })
      const rows = findModelRows(body)
      if (rows.length > 0) entries = rows.map(toEntry).filter(Boolean)
    } catch (error) {
      // 旧版把字符串传给 log()，被展开成 8 行逐字符畸形日志；且静默回退无记录
      const reason = `v3/config:${realm}:${error?.message ?? error}`
      if (!degradationWarned.has(reason)) {
        degradationWarned.add(reason)
        log?.({ scope: 'workbuddy', level: 'warn', message: `credit-hub: workbuddy ${realm} v3/config 拉取失败（${error?.message ?? error}），先用静态清单` })
      }
    }
    if (!entries) entries = staticCatalog
    // 11102 负缓存：上游明确拒绝的模型在目录里隐藏 30 分钟（到期自动回验），
    // 避免选择器/网关反复撞 "service info not found"
    const cutoff = now()
    for (const [key, until] of modelBlockUntil) {
      if (until <= cutoff) modelBlockUntil.delete(key)
    }
    entries = entries.filter(entry => {
      const blockedUntil = modelBlockUntil.get(`${realm}/${entry.id}`)
      return blockedUntil === undefined || blockedUntil <= cutoff
    })
    modelCache.set(realm, { entries, expiresAt: now() + 10 * 60_000 })
    return entries
  }

  function findModelRows(payload) {
    const rows = []
    const walk = node => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item)
        return
      }
      if (!node || typeof node !== 'object') return
      if (typeof node.id === 'string' && (node.maxOutputTokens !== undefined || node.credits !== undefined || node.name !== undefined)) {
        rows.push(node)
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') walk(value)
      }
    }
    walk(payload?.data ?? payload)
    return rows.filter(row => !/^(nes-|completion-|codewise-)/.test(row.id ?? '')
      && !/text-to-image|text-to-video|embedding|asr|tts|ocr/i.test(JSON.stringify(row.tags ?? '')))
  }

  const toEntry = row => {
    const id = String(row.id ?? '')
    if (!id) return undefined
    const maxOutput = typeof row.maxOutputTokens === 'number' && row.maxOutputTokens > 256 ? row.maxOutputTokens : 16384
    const reasoning = row.supportsReasoning === true || row.reasoning !== undefined
    // 上游 supportedEfforts 可能含重复/未知档位（实测 hy4free），宿主校验一票
    // 否决整条车道——出站前必须消毒；消毒后为空就不下发档位菜单。
    const clean = sanitizeEfforts(row.reasoning?.supportedEfforts, row.reasoning?.defaultEffort)
    return {
      id,
      name: String(row.name ?? id),
      contextWindow: typeof row.maxInputTokens === 'number' && row.maxInputTokens > 4096 ? row.maxInputTokens : 128000,
      maxOutput,
      vision: row.supportsImages === true,
      reasoning,
      canDisableThinking: row.reasoning?.canDisableThinking !== false,
      efforts: clean?.efforts,
      defaultEffort: clean?.defaultEffort,
      credits: typeof row.credits === 'string' ? row.credits : undefined,
    }
  }

  // ── chat turn（轮转 + 错误分类） ──────────────────────────────────────────
  async function streamTurn({ modelId, options, signal, onChunk }) {
    const { realm, bare } = parseWorkbuddyModelId(modelId)
    const entries = await fetchModels(realm)
    const found = entries.find(row => row.id === bare)
    const entry = found ?? { id: bare, name: bare, contextWindow: 128000, maxOutput: 16384 }
    if (!found) {
      // 旧版对未知模型静默兜底照发请求，用户只看到上游 400/11102，无从定位
      const reason = `unknown-model:${realm}/${bare}`
      if (!degradationWarned.has(reason)) {
        degradationWarned.add(reason)
        warn?.(`credit-hub: workbuddy 目录里找不到 ${realm}/${bare}，用默认参数兜底照发（可能 400/11102）`)
      }
    }
    const warnings = []
    const messages = toChatMessages(options.messages, warnings)
    // 国际版硬约束（wb2api payload.go 的 ensureConsoleSystem 同款）：首条消息
    // 必须是 system，否则 400 11128 "first message is not system prompt"。
    // 客户端不带 system 时前置一条中性提示。
    if (realm === 'global' && !(messages.length > 0 && messages[0].role === 'system')) {
      messages.unshift({ role: 'system', content: 'You are a helpful assistant.' })
    }
    const budget = clamp(options.maxTokens ?? 8192, 256, entry.maxOutput ?? 16384)
    const body = repairWorkbuddyBody({
      model: bare,
      messages,
      stream: true,
      max_tokens: budget,
      ...(Array.isArray(options.stop) && options.stop.length > 0 ? { stop: options.stop } : {}),
      ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
    })
    const tools = toChatTools(options.tools)
    if (tools.length > 0) body.tools = tools
    if (entry.reasoning === true && options.reasoningEffort !== undefined) {
      if (options.reasoningEffort === 'off' && entry.canDisableThinking !== false) {
        body.thinking = { type: 'disabled' }
      } else if (options.reasoningEffort !== 'off') {
        body.thinking = { type: 'enabled' }
        body.reasoning_effort = nearestEffort(String(options.reasoningEffort), entry.efforts)
      }
    }

    const candidates = pool(realm).filter(account => !cooling(account))
    if (candidates.length === 0) throw new UpstreamError('workbuddy 渠道没有可用账号（未登录或全部冷却/禁用）', CODE.auth)
    const tried = []
    let lastError
    // 11128「Illegal API invocation from an unapproved channel」的 displayTips 明确
    // 要求「重新发送」；但旧逻辑 attempt 上限 = min(3, candidates.length)，cn 池
    // 常常只有一个账号 → 上限 1 → 完全不重试，一次被拦整轮失败（2026-11-10）。
    // 这里给 channel-refused / busy 增加同账号退避重试（不消耗账号轮转次数）。
    let refusals = 0
    for (let attempt = 0; attempt < Math.min(3, candidates.length); attempt += 1) {
      const account = candidates[(rotateCursor + attempt) % candidates.length]
      await ensureFresh(account)
      const conversationId = hex(16)
      const requestId = hex(16)
      const messageId = hex(16)
      const normalizer = createNormalizer('openai-chat', onChunk)
      try {
        await postSse(`${CHAT_BASE[realm]}/v2/chat/completions`, {
          headers: chatHeaders(account, { conversationId, requestId, messageId }),
          body,
          signal,
          onEvent: data => {
            let parsed
            try { parsed = JSON.parse(data) } catch { return }
            if (parsed?.error !== undefined && parsed?.choices === undefined) {
              throw new UpstreamError(`workbuddy 上游错误帧：${JSON.stringify(parsed.error).slice(0, 300)}`, CODE.server, { status: 200, envelope: parsed })
            }
            normalizer.feed(data)
          },
        })
        const outcome = normalizer.outcome()
        if (outcome.sawFinish !== true || outcome.finish === 'failed') {
          throw new UpstreamError('workbuddy 流在 finish 之前结束', CODE.transport)
        }
        account.lastError = undefined
        writeAccounts(readAccounts())
        rotateCursor += 1
        return { ...outcome, warnings }
      } catch (error) {
        try { normalizer.flushTails() } catch {}
        if (signal?.aborted) throw error
        const status = error?.status
        const verdict = classify(status, error?.envelope, error?.message)
        lastError = error
        tried.push(`${account.label}:${verdict}${error?.retryAfterMs ? `(retry-after=${error.retryAfterMs}ms)` : ''}`)
        if (verdict === 'channel-refused' || verdict === 'busy' || verdict === 'content-blocked') {
          // 渠道校验/繁忙：上游允许重发，同账号退避重试两次再放弃。
          // content-blocked 是内容策略拦截，重发无意义，直接轮转下一账号。
          if (verdict !== 'content-blocked' && refusals < 2) {
            refusals += 1
            if (refusals === 1) {
              // 只记元数据：定位 11128 的可复现差异，不落用户消息内容
              const meta = {
                realm, model: bare, messages: body.messages?.length ?? 0,
                firstRole: body.messages?.[0]?.role ?? null,
                max_tokens: body.max_tokens, tools: body.tools?.length ?? 0,
                thinking: body.thinking, reasoning_effort: body.reasoning_effort,
                hasTemperature: typeof body.temperature === 'number',
                hasStop: Array.isArray(body.stop) && body.stop.length > 0,
              }
              warn?.(`credit-hub: workbuddy ${realm} 被渠道校验拦截（11128/6021），同账号重试；请求元数据 ${JSON.stringify(meta)}`)
            }
            await new Promise(resolve => {
              const timer = setTimeout(resolve, 500 * refusals + Math.floor(Math.random() * 300))
              timer.unref?.()
            })
            if (signal?.aborted) throw error
            attempt -= 1 // 不消耗账号轮转次数：下一次循环仍是同一账号
            continue
          }
          continue
        }
        if (verdict === 'session-dead') {
          const ok = await refreshAccount(account).catch(() => false)
          if (ok) continue
        }
        punish(account, verdict)
        if (verdict === 'model-blocked') {
          // 上游明确拒绝该模型（11102 等）：目录里隐藏 30 分钟，到期自动回验
          modelBlockUntil.set(`${realm}/${bare}`, now() + 30 * 60_000)
          modelCache.delete(realm)
        }
        // soft-rate 是账号级软限流：换下一个账号仍有机会，旧版直接 break
        // 白白放弃了账号池。模型级限流/封禁换账号无用，才停止轮转。
        if (verdict === 'model-rate' || verdict === 'model-blocked') {
          if (error?.retryAfterMs) warn?.(`credit-hub: workbuddy 模型级限流，上游建议 ${error.retryAfterMs}ms 后重试`)
          break
        }
        continue
      }
    }
    throw lastError ?? new UpstreamError(`workbuddy 轮转耗尽：${tried.join('; ')}`, CODE.server)
  }

  // ── credits + checkin ─────────────────────────────────────────────────────
  function billingWindow() {
    const format = date => {
      const pad = value => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }
    return { PackageEndTimeRangeBegin: format(new Date()), PackageEndTimeRangeEnd: format(new Date(Date.now() + 365 * 86400_000)) }
  }

  async function fetchCredits(accountId) {
    const account = readAccounts().find(row => row.id === accountId)
    if (!account) throw new UpstreamError('账号不存在', CODE.notFound)
    await ensureFresh(account)
    const base = BILLING_BASE[account.realm]
    const path = account.realm === 'cn' ? '/v2/billing/meter/get-user-resource' : '/billing/meter/get-user-resource'
    let body
    try {
      body = await postJson(`${base}${path}`, { headers: billingHeaders(account), body: { PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3], ...billingWindow() } })
    } catch (error) {
      if (account.realm === 'global' && error?.status === 404) {
        body = await postJson(`${base}/v2/billing/meter/get-user-resource`, { headers: billingHeaders(account), body: { PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3], ...billingWindow() } })
      } else throw error
    }
    // 上游两种响应形状混算，且 CapacityRemain / DeductionEndTime 可能是脏值：
    // NaN、负数、秒与毫秒混用都会把积分显示搞错，统一先校验再归一。
    const safeNum = value => {
      const n = Number(value)
      return Number.isFinite(n) && n >= 0 ? n : 0
    }
    const normalizeEpoch = value => {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return undefined
      return n < 1e11 ? n * 1000 : n
    }
    const rows = body?.data?.Response?.Data?.Accounts
    let remain = 0
    let total = 0
    let expireAt
    if (Array.isArray(rows)) {
      for (const pack of rows) {
        remain += safeNum(pack.CapacityRemain)
        total += safeNum(pack.CapacitySize ?? pack.CapacityRemain)
        const end = normalizeEpoch(pack.DeductionEndTime)
        if (end !== undefined && (expireAt === undefined || end < expireAt)) expireAt = end
      }
    } else if (body?.data?.credit !== undefined) {
      total = safeNum(body.data.limitNum)
      remain = Math.max(0, total - safeNum(body.data.credit))
    }
    account.credits = { remain, total, expireAt, updatedAt: now() }
    writeAccounts(readAccounts())
    return account.credits
  }

  async function checkin(accountId) {
    const account = readAccounts().find(row => row.id === accountId)
    if (!account) throw new UpstreamError('账号不存在', CODE.notFound)
    if (account.realm === 'global') throw new UpstreamError('国际版账号不支持签到', CODE.client)
    await ensureFresh(account)
    const body = await postJson(`${BILLING_BASE.cn}/v2/billing/meter/daily-checkin`, { headers: billingHeaders(account), body: {} })
    const ok = body?.code === 0 || /已签到|already/i.test(String(body?.msg ?? ''))
    return { ok, message: body?.msg ?? (ok ? '签到成功' : '签到失败') }
  }

  async function remove(accountId) {
    writeAccounts(readAccounts().filter(row => row.id !== accountId))
  }

  async function setEnabled(accountId, enabled) {
    const list = readAccounts()
    const account = list.find(row => row.id === accountId)
    if (!account) throw new UpstreamError('账号不存在', CODE.notFound)
    account.enabled = enabled === true
    writeAccounts(list)
  }

  /** Near-expiry token refresh sweep — called from the host's periodic tick. */
  async function tick() {
    for (const account of readAccounts()) {
      if (account.enabled === false || account.state === 'dead') continue
      if ((account.auth?.expiresAt ?? 0) - now() < 24 * 3600_000 && account.auth?.refreshToken) {
        await refreshAccount(account).catch(() => {})
      }
    }
  }

  return {
    channel: 'workbuddy',
    listAccounts: () => readAccounts().map(publicView),
    startLogin,
    pollLogin,
    importAccount,
    remove,
    setEnabled,
    fetchCredits,
    checkin,
    tick,
    async listModels() {
      const out = []
      for (const realm of ['cn', 'global']) {
        if (pool(realm).length === 0) continue
        for (const entry of await fetchModels(realm)) {
          out.push({
            id: `wb/${realm}/${entry.id}`,
            source: 'workbuddy',
            realm,
            modelId: entry.id,
            name: entry.name,
            contextWindow: entry.contextWindow,
            maxOutput: entry.maxOutput,
            vision: entry.vision === true,
            reasoning: entry.reasoning === true,
            efforts: entry.efforts,
            defaultEffort: entry.defaultEffort,
            description: `${entry.name} · WorkBuddy ${realm === 'cn' ? '国内版' : '国际版'}${entry.credits ? ` · ${entry.credits}` : ''}`,
          })
        }
      }
      return out
    },
    async resolveModel(modelId) {
      const entries = await this.listModels()
      return entries.find(row => row.id === modelId) ?? null
    },
    streamTurn,
    status() {
      const accounts = readAccounts()
      return {
        accounts: accounts.length,
        ok: accounts.filter(row => row.enabled !== false && row.state !== 'dead' && !cooling(row)).length,
      }
    },
  }
}
