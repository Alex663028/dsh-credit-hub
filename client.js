/**
 * dsh-credit-hub — 浏览器半身（设置 → 积分汇通）。
 *
 * ModuleLoader bundle，依赖 shell 提供的 react。UI 对齐 dsh-our-free-model
 * 的使用体验：渠道卡片化、一键登录（popup 预留 + 自动轮询）、Key 直接填在
 * 预设卡上、首次进入三步引导、网关配方一键复制。
 *
 * 数据两条通道：
 *  - 本插件 REST：/api/credit-hub/*（WorkBuddy 原生渠道、上游、链路、网关、日志）
 *  - channel-pack RPC：connection.rpc.call('/api','channel-pack',…)（与 ofm 同一
 *    端点，渠道包由本插件或 ofm 挂载均可驱动——账号渠道的登录/启停/积分领取）
 *
 * @module client.js
 */

window.__chLoaded = (window.__chLoaded ?? 0) + 1
window.__ModuleLoader__?.load({
  id: 'dsh-credit-hub',
  factory: require => {
    window.__chFactoryRan = (window.__chFactoryRan ?? 0) + 1
    const React = require('react')
    const NS = 'settings.creditHub'
    const DICT = {
  zh: {
    nav: '积分汇通',
    'tab.overview': '总览',
    'tab.channels': '账号渠道',
    'tab.upstreams': 'API 中转',
    'tab.combos': '降级链',
    'tab.gateway': '网关',
    'tab.logs': '日志',

    'onb.title': '三步开始用',
    'onb.s1': '在「账号渠道」登录 WorkBuddy，或接入你想用的账号渠道',
    'onb.s2': '在「API 中转」给预设填一个 Key（没有也行，账号渠道就够用）',
    'onb.s3': '聊天框的模型选择器里找「积分汇通」分组；外部工具用网关页的配方接入',
    'onb.done': '知道了，不再显示',
    'onb.go': '去登录渠道',

    'ov.models': '汇通模型',
    'ov.gateway': '本地网关',
    'ov.off': '未开启',
    'ov.sources': '来源状态',
    'ov.src.wb': 'WorkBuddy（腾讯）',
    'ov.src.pack': '账号渠道包',
    'ov.src.up': 'API 中转',
    'ov.configure': '去配置',
    'ov.pack.auto': '由 Our Free Model 提供',
    'ov.pack.mounted': '本插件独立反代',
    'ov.pack.off': '未挂载',
    'ov.packmode': '渠道包模式',
    'ov.packmode.auto': '自动避让 ofm（共存时推荐）',
    'ov.packmode.on': '独立反代（需先停用 ofm）',
    'ov.packmode.off': '关闭',
    'ov.packmode.hint': '同一进程双挂载渠道包会撞端口与注册，导致 DSH 崩溃；切「独立反代」前必须先在 DSH 插件管理停用 Our Free Model。',
    'ov.layer.hint': '配置分层：本页改动写入覆盖层、优先于宿主配置面板；只在面板改过的键以面板为准。',
    'ov.recipe': '接入外部工具',
    'ov.recipe.openai': 'OpenAI 兼容（Cherry Studio / Codex / curl…）',
    'ov.recipe.claude': 'Claude Code / Anthropic 兼容',
    'ov.copy': '复制',
    'ov.copied': '已复制',
    'ov.enabled': '启用积分汇通',
    'ov.gatewayToggle': '本地网关',
    'ov.autoCheckin': 'WorkBuddy 每日自动签到',
    'ov.packGateway': '渠道包独立网关（8326）',
    'ov.packGateway.hint': '关闭后 8330 单网关转出全部模型；开启则渠道包另起 8326 网关（与本插件功能重叠）。重启 DSH 后生效。',
    'ov.refresh': '刷新',
    'ov.pick.hint': '这些模型出现在聊天框模型选择器的「积分汇通」分组里',
    'ov.chips.hint': '点击开关模型（关闭后从选择器与网关隐藏，降级链不受影响）',
    'ov.chips.enableAll': '全部启用',
    'chan.checkNow': '立即检查',
    'chan.modelsToggle': '模型',
    'chan.model.on': '开',
    'chan.model.off': '关',
    'chan.model.restore': '恢复',
    'chan.model.dead': '失效',
    'chan.model.hidden': '已隐藏',
    'chan.model.free': '免费',
    'chan.model.enableAll': '全部启用',
    'chan.model.disableAll': '全部停用',

    'chan.wb.desc': '原生渠道 · 设备流登录 · 账号池 · 积分与签到',
    'chan.wb.cn': '登录国内版',
    'chan.wb.global': '登录国际版',
    'chan.wb.waiting': '等待授权完成…（已打开浏览器授权页）',
    'chan.wb.import': '手工导入 Token',
    'chan.wb.accessToken': 'accessToken',
    'chan.wb.refreshToken': 'refreshToken（可选）',
    'chan.wb.importBtn': '导入',
    'chan.wb.risk': '逆向接入，腾讯正在收紧识别：仅限自用账号，存在风控风险，勿用于转卖。',
    'chan.credits': '查积分',
    'chan.checkin': '签到',
    'chan.claim': '一键领取',
    'chan.enable': '启用',
    'chan.disable': '停用',
    'chan.remove': '删除',
    'chan.refreshAcct': '刷新',
    'chan.login': '登录',
    'chan.empty': '未登录',
    'chan.accounts': '账号',
    'chan.models': '模型',
    'chan.loginDone': '登录成功：{login}',
    'chan.loginFailed': '登录失败：{reason}',
    'chan.loginExpired': '登录超时，请重试',
    'chan.pack.byOfm': '由 Our Free Model 挂载运行——本插件的渠道卡可同等驱动（登录/领取写回同一账号池）。要完全独立反代：先在 DSH 插件管理停用 Our Free Model，再在总览页把「渠道包模式」切到「独立反代」。',
    'chan.pack.ofmBlock': '「独立反代」已选择，但检测到 Our Free Model 仍在安装——为避免双挂载崩溃，本插件暂不挂载渠道包。先停用 Our Free Model，然后重启 DSH；若已停用仍提示，可删除数据目录下 our-free-model/catalog.json 标记后重启。',
    'chan.pack.byMe': '本插件独立反代 · 账号数据在 credit-hub 数据目录',
    'chan.pack.dual': '⚠ 检测到 Our Free Model 也在运行同源渠道包：双份挂载会导致 DSH 崩溃，请立即停用其中一方。',
    'chan.pack.none': '未挂载（把总览页「渠道包模式」切到「独立反代」）',
    'chan.pack.offLine': '渠道包未挂载',
    'bridge.title': '桥接渠道（宿主注册 provider）',
    'bridge.hint': '经 pk/ 桥接接入的宿主渠道模型——可逐个开关',
    'chan.pack.diag': '诊断',
    'chan.rpc.unavailable': '渠道服务不可用（需要 DSH 桌面端环境）',
    'chan.openLogin': '打开授权页',

    'up.desc': '填 Key 即接入；所有上游模型都经本地网关提供给本机任意 agent',
    'up.keyPlaceholder': '粘贴 API Key…',
    'up.key': 'API Key',
    'gw.portInvalid': '端口需为 1024-65535 的整数',
    'ov.usage': '用量（按模型）',
    'common.confirmRemove': '确定删除？',
    'state.ok': '正常',
    'state.cooling': '冷却中',
    'state.dead': '已失效',
    'state.disabled': '已停用',
    'state.off': '未启用',
    'up.save': '保存',
    'up.saved': '已保存并启用',
    'up.discover': '发现模型',
    'up.discovered': '发现 {n} 个模型',
    'up.edit': '编辑',
    'up.local': '本机接入',
    'up.modelsField': '模型清单（每行一个：id | 显示名 | 上下文窗口，后两项可省）',
    'up.custom': '自定义中转 / 官方 API',
    'up.name': '名称',
    'up.baseURL': 'Base URL（含版本段）',
    'up.kind': '线格式',
    'up.models': '个模型',
    'up.noKey': '未填 Key',
    'up.enable': '启用',
    'up.disable': '停用',
    'up.remove': '删除',
    'up.keyKeep': 'Key 留空保持不变',

    'combo.hint': '按顺序尝试，成员交出首个答案前失败会自动换下一跳，调用方无感。',
    'combo.scope': '链成员当前覆盖 WorkBuddy 与自填上游；渠道包模型（Qoder/Raccoon 等）走各自独立车道，暂不能入链。',
    'combo.add': '新建链路',
    'combo.name': '链名',
    'combo.strategy.fallback': 'fallback（固定顺序）',
    'combo.strategy.round': 'round-robin（轮换起点）',
    'combo.pick': '添加模型…',
    'combo.save': '保存',
    'combo.empty': '还没有链路。从上面选两个模型串一条即可。',
    'combo.moveUp': '上移',
    'combo.moveDown': '下移',

    'gw.recipes': '接入配方',
    'gw.key': '网关 Key',
    'gw.show': '显示',
    'gw.hide': '隐藏',
    'gw.thinkingOff': '思考模型默认关思考（调用方未指定强度时——简单客户端即时出字）',
    'gw.setKey': '自定义 Key（16-80 位字母数字，立即生效）',
    'gw.keyApplied': 'Key 已生效，本机 agent 用新 Key 即可',
    'gw.rotate': '重置 Key',
    'gw.port': '端口',
    'gw.apply': '应用',
    'gw.stats': '用量',
    'gw.requests': '请求',
    'gw.ok': '成功',
    'gw.failed': '失败',
    'gw.running': '运行中',
    'gw.stopped': '已停止',
    'gw.start': '启动网关',

    'logs.clear': '清空',
    'logs.empty': '暂无日志。',
    'common.loading': '加载中…',
    'common.failed': '失败',
    'common.ok': '成功',
  },
  en: {
    nav: 'Credit Hub',
    'tab.overview': 'Overview',
    'tab.channels': 'Channels',
    'tab.upstreams': 'API Relays',
    'tab.combos': 'Chains',
    'tab.gateway': 'Gateway',
    'tab.logs': 'Logs',

    'onb.title': 'Three steps to start',
    'onb.s1': 'Log in to WorkBuddy under Channels, or connect any account channel',
    'onb.s2': 'Paste a key on any preset under API Relays (optional — channels alone work)',
    'onb.s3': 'Pick models from the "Credit Hub" group in the chat picker; external tools use the Gateway recipes',
    'onb.done': 'Got it',
    'onb.go': 'Open channels',

    'ov.models': 'Hub models',
    'ov.gateway': 'Local gateway',
    'ov.off': 'off',
    'ov.sources': 'Sources',
    'ov.src.wb': 'WorkBuddy (Tencent)',
    'ov.src.pack': 'Account channels',
    'ov.src.up': 'API relays',
    'ov.configure': 'Configure',
    'ov.pack.auto': 'Provided by Our Free Model',
    'ov.pack.mounted': 'Self-hosted by this plugin',
    'ov.pack.off': 'Not mounted',
    'ov.recipe': 'Connect external tools',
    'ov.recipe.openai': 'OpenAI compatible (Cherry Studio / Codex / curl…)',
    'ov.recipe.claude': 'Claude Code / Anthropic compatible',
    'ov.copy': 'Copy',
    'ov.copied': 'Copied',
    'ov.enabled': 'Enable Credit Hub',
    'ov.gatewayToggle': 'Local gateway',
    'ov.autoCheckin': 'WorkBuddy daily check-in',
    'ov.packGateway': 'Channel-pack gateway (8326)',
    'ov.packGateway.hint': 'Off = single 8330 gateway serves every model. On = the channel pack also starts its own 8326 gateway (overlapping). Applies after restart.',
    'ov.refresh': 'Refresh',
    'ov.pick.hint': 'These models appear in the chat picker under "Credit Hub"',

    'chan.wb.desc': 'Native channel · device-flow login · account pool · credits & check-in',
    'chan.wb.cn': 'Login CN',
    'chan.wb.global': 'Login Global',
    'chan.wb.waiting': 'Waiting for authorization… (browser opened)',
    'chan.wb.import': 'Import token manually',
    'chan.wb.accessToken': 'accessToken',
    'chan.wb.refreshToken': 'refreshToken (optional)',
    'chan.wb.importBtn': 'Import',
    'chan.wb.risk': 'Reverse-engineered channel; Tencent is tightening detection. Own accounts only, never for resale.',
    'chan.credits': 'Credits',
    'chan.checkin': 'Check in',
    'chan.claim': 'Claim all',
    'chan.enable': 'Enable',
    'chan.disable': 'Disable',
    'chan.remove': 'Remove',
    'chan.refreshAcct': 'Refresh',
    'chan.login': 'Login',
    'chan.empty': 'Not logged in',
    'chan.accounts': 'accounts',
    'chan.models': 'models',
    'chan.loginDone': 'Logged in: {login}',
    'chan.loginFailed': 'Login failed: {reason}',
    'chan.loginExpired': 'Login timed out, try again',
    'chan.pack.byOfm': 'Provided by the Our Free Model channel pack (set accountPack to on to self-host)',
    'chan.pack.byMe': 'Self-hosted reverse proxy by this plugin · data under credit-hub dir',
    'chan.pack.dual': '⚠ Our Free Model is also running its channel pack. This plugin registers first; consider disabling Our Free Model in DSH plugin manager to avoid duplicate channels & check-ins.',
    'chan.pack.none': 'Not mounted (set accountPack to on)',
    'chan.pack.offLine': 'Channel pack not mounted',
    'bridge.title': 'Bridged channels (host-registered providers)',
    'bridge.hint': 'Host provider models bridged via pk/ — toggle individually',
    'chan.pack.diag': 'Diagnose',
    'chan.checkNow': 'Check now',
    'chan.modelsToggle': 'Models',
    'chan.model.on': 'On',
    'chan.model.off': 'Off',
    'chan.model.restore': 'Restore',
    'chan.model.dead': 'Dead',
    'chan.model.hidden': 'Hidden',
    'chan.model.free': 'Free',
    'chan.model.enableAll': 'Enable all',
    'chan.model.disableAll': 'Disable all',
    'chan.rpc.unavailable': 'Channel service unavailable (needs DSH desktop)',
    'chan.openLogin': 'Open authorize page',

    'up.desc': 'Paste a key to connect; all upstream models are served through the local gateway to any agent',
    'up.keyPlaceholder': 'Paste API key…',
    'up.key': 'API Key',
    'gw.portInvalid': 'Port must be an integer in 1024-65535',
    'ov.usage': 'Usage (per model)',
    'common.confirmRemove': 'Remove this entry?',
    'state.ok': 'ok',
    'state.cooling': 'cooling',
    'state.dead': 'dead',
    'state.disabled': 'disabled',
    'state.off': 'off',
    'ov.packmode': 'Channel pack mode',
    'ov.packmode.auto': 'Auto-avoid ofm (recommended when coexisting)',
    'ov.packmode.on': 'Self-hosted (disable ofm first)',
    'ov.packmode.off': 'Off',
    'ov.packmode.hint': 'Two channel packs in one process collide on ports & registration and crash DSH. Disable Our Free Model in the DSH plugin manager before switching to self-hosted.',
    'ov.layer.hint': 'Config layering: changes on this page write the overlay and win over the host config panel; keys changed only in the panel follow the panel.',
    'ov.chips.hint': 'Click to toggle a model (hidden from picker & gateway when off; chains unaffected)',
    'ov.chips.enableAll': 'Enable all',
    'up.save': 'Save',
    'up.saved': 'Saved & enabled',
    'up.discover': 'Discover models',
    'up.discovered': 'Found {n} models',
    'up.edit': 'Edit',
    'up.local': 'Local access',
    'up.modelsField': 'Models (one per line: id | name | context — name/context optional)',
    'up.custom': 'Custom relay / official API',
    'up.name': 'Name',
    'up.baseURL': 'Base URL (with version)',
    'up.kind': 'Wire format',
    'up.models': 'models',
    'up.noKey': 'no key',
    'up.enable': 'Enable',
    'up.disable': 'Disable',
    'up.remove': 'Remove',
    'up.keyKeep': 'Leave key blank to keep',

    'combo.hint': 'Tried in order; a member failing before its first answer is skipped invisibly.',
    'combo.scope': 'Chains currently cover WorkBuddy and self-filled upstreams; channel-pack models (Qoder/Raccoon/…) run in their own lanes and cannot join yet.',
    'combo.add': 'New chain',
    'combo.name': 'Name',
    'combo.strategy.fallback': 'fallback (fixed order)',
    'combo.strategy.round': 'round-robin (rotating start)',
    'combo.pick': 'Add model…',
    'combo.save': 'Save',
    'combo.empty': 'No chains yet. Pick two models above and chain them.',
    'combo.moveUp': 'Up',
    'combo.moveDown': 'Down',

    'gw.recipes': 'Recipes',
    'gw.key': 'Gateway key',
    'gw.show': 'Show',
    'gw.hide': 'Hide',
    'gw.thinkingOff': 'Default thinking OFF when caller omits effort (instant text for simple clients)',
    'gw.setKey': 'Custom key (16-80 alnum chars, effective immediately)',
    'gw.keyApplied': 'Key updated — local agents can use the new key now',
    'gw.rotate': 'Reset key',
    'gw.port': 'Port',
    'gw.apply': 'Apply',
    'gw.stats': 'Usage',
    'gw.requests': 'Requests',
    'gw.ok': 'OK',
    'gw.failed': 'Failed',
    'gw.running': 'running',
    'gw.stopped': 'stopped',
    'gw.start': 'Start gateway',

    'logs.clear': 'Clear',
    'logs.empty': 'No logs.',
    'common.loading': 'Loading…',
    'common.failed': 'failed',
    'common.ok': 'ok',
  },
}

    const { createElement: h, useState, useEffect, useCallback, useRef } = React
    const lang = String(navigator.language ?? 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    const t = key => DICT[lang][key] ?? DICT.zh[key] ?? key
    const fmt = (key, vars) => Object.entries(vars ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), t(key))

    const api = async (path, body) => {
      const response = await fetch(`/api/credit-hub${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error ?? `${response.status}`)
      return payload
    }

    /** 与 ofm 渠道卡一致的 provider 常量（accent 色同样取自 ofm）。 */
    const CHANNEL_PROVIDERS = [
      { id: 'lobsterai', name: 'LobsterAI', org: '有道', accent: '#FF6A00' },
      { id: 'qoder', name: 'Qoder', org: '阿里系', accent: '#615CED' },
      { id: 'qodercn', name: 'Qoder 中国版', org: '阿里系', accent: '#7A6CF0' },
      { id: 'trae', name: 'TRAE', org: '字节', accent: '#00BFA6' },
      { id: 'cline', name: 'Cline', org: 'Cline', accent: '#5B5BD6' },
      { id: 'loomy', name: 'Loomy', org: '讯飞', accent: '#2F6BFF' },
      { id: 'raccoon', name: 'Raccoon 小浣熊', org: '商汤', accent: '#00A6A6' },
      { id: 'minimax', name: 'MiniMax Code', org: 'MiniMax', accent: '#E4007F' },
      { id: 'zcode', name: 'ZCode', org: '智谱', accent: '#3B6EF6' },
      { id: 'gemini', name: 'Gemini', org: 'Google', accent: '#4285F4' },
    ]

    // ── atoms ──────────────────────────────────────────────────────────────────
    const Card = props => h('div', { className: `ch-card${props.className ? ` ${props.className}` : ''}` },
      props.title ? h('div', { className: 'ch-card-head' },
        h('div', { className: 'ch-card-title' },
          props.accent ? h('span', { className: 'ch-accent', style: { background: props.accent } }) : null,
          props.title,
          props.badge),
        props.actions) : null,
      props.children)

    const Btn = props => h('button', {
      className: `ch-btn${props.small ? ' ch-btn-sm' : ''}${props.kind ? ` ch-btn-${props.kind}` : ''}${props.active ? ' ch-btn-active' : ''}`,
      onClick: props.onClick, disabled: props.disabled === true || props.busy === true,
      title: props.title,
    }, props.busy === true ? '…' : props.children)

    const Toggle = props => h('label', { className: 'ch-toggle' },
      h('span', { className: `ch-switch${props.checked ? ' on' : ''}`, onClick: () => props.onChange(!props.checked) },
        h('span', { className: 'ch-knob' })),
      h('span', { className: 'ch-toggle-label', onClick: () => props.onChange(!props.checked) }, props.label))

    const Field = props => h('label', { className: 'ch-field' },
      props.label ? h('span', { className: 'ch-field-label' }, props.label) : null,
      props.area
        ? h('textarea', { className: 'ch-input', value: props.value, onChange: e => props.onChange(e.target.value), rows: props.rows ?? 2, placeholder: props.placeholder ?? '' })
        : h('input', { className: 'ch-input', type: props.type ?? 'text', value: props.value, onChange: e => props.onChange(e.target.value), placeholder: props.placeholder ?? '' }))

    const Dot = ({ state }) => h('span', { className: `ch-dot ch-dot-${state ?? 'off'}` })
    const StateBadge = ({ state, text }) => h('span', { className: `ch-badge ch-badge-${state ?? 'off'}` }, text ?? state)
    const Muted = props => h('span', { className: 'ch-muted' }, props.children)

    const useToast = () => {
      const [toast, setToast] = useState(null)
      const timer = useRef(null)
      const show = useCallback((text, kind = 'ok') => {
        setToast({ text: String(text), kind })
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setToast(null), 3600)
      }, [])
      return [toast, show]
    }

    const Notice = props => props.text ? h('div', { className: `ch-notice ch-notice-${props.kind ?? 'info'}` }, props.text) : null

    const Toast = ({ toast }) => toast ? h('div', { className: `ch-toast ch-toast-${toast.kind}` }, toast.text) : null

    const CopyBtn = ({ text, small = true }) => {
      const [done, setDone] = useState(false)
      return h(Btn, {
        small, onClick: async () => {
          try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) } catch {}
        },
      }, done ? `✔ ${t('ov.copied')}` : t('ov.copy'))
    }

    /** 每 interval 自动轮询；tab 不可见时暂停；offset 错峰（多卡不同相位）。 */
    const usePoll = (fn, ms, offset = 0) => {
      const saved = useRef(fn)
      saved.current = fn
      useEffect(() => {
        let alive = true
        let timer = null
        const tick = () => { if (alive && document.visibilityState !== 'hidden') void saved.current?.() }
        const kickoff = setTimeout(() => { tick(); timer = setInterval(tick, ms) }, offset)
        return () => { alive = false; clearTimeout(kickoff); if (timer) clearInterval(timer) }
      }, [ms, offset])
    }

    // ── channel-pack RPC（与 ofm 的 useChannelRpc 同款） ────────────────────────
    function useChannelRpc(ctx) {
      const readTransport = useCallback(() => {
        let connection
        try { connection = ctx?.connection } catch {}
        if (connection === undefined || connection === null) {
          try { connection = ctx?.get?.('connection') } catch {}
        }
        try {
          const call = connection?.rpc?.call
          return typeof call === 'function' ? { connection, call } : null
        } catch { return null }
      }, [])
      const [transport, setTransport] = useState(readTransport)
      useEffect(() => {
        let alive = true
        const check = () => { if (alive) setTransport(previous => { const next = readTransport(); return next === previous ? previous : next }) }
        check()
        const timer = setInterval(check, 800)
        return () => { alive = false; clearInterval(timer) }
      }, [readTransport])
      const rpc = useCallback(async (method, payload, timeoutMs = 60_000) => {
        const latest = readTransport()
        if (latest === null) throw new Error('no-connection')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const result = await latest.call.call(latest.connection.rpc, '/api', 'channel-pack', { method, payload }, controller.signal)
          if (result?.ok === true) return result.value
          if (result?.ok === false) throw new Error(result.error?.message ?? result.error?.code ?? 'rpc-failed')
          return result
        } finally { clearTimeout(timer) }
      }, [readTransport, transport])
      return { available: transport !== null, rpc }
    }

    // ── onboarding ─────────────────────────────────────────────────────────────
    const Onboarding = ({ settings, onSettings, goTab }) => {
      if (settings?.onboardingSeen === true) return null
      const step = (n, text) => h('div', { className: 'ch-onb-step' },
        h('span', { className: 'ch-onb-num' }, n), h('span', null, text))
      return h('div', { className: 'ch-onb' },
        h('div', { className: 'ch-onb-title' }, `✦ ${t('onb.title')}`),
        step(1, t('onb.s1')),
        step(2, t('onb.s2')),
        step(3, t('onb.s3')),
        h('div', { className: 'ch-onb-actions' },
          h(Btn, { kind: 'primary', onClick: () => goTab('channels') }, t('onb.go')),
          h(Btn, { small: true, onClick: () => onSettings({ onboardingSeen: true }) }, t('onb.done'))))
    }

    // ── 总览 ───────────────────────────────────────────────────────────────────
    function Overview({ settings, onSettings, goTab }) {
      const [summary, setSummary] = useState(null)
      const [gateway, setGateway] = useState(null)
      const load = useCallback(() => {
        void api('/summary').then(setSummary).catch(() => {})
        void api('/gateway').then(setGateway).catch(() => {})
      }, [])
      usePoll(load, 10_000)

      const bind = gateway?.bind ?? '127.0.0.1:8330'
      const key = gateway?.key ?? ''
      const openaiRecipe = `OPENAI_BASE_URL=http://${bind}/v1\nOPENAI_API_KEY=${key}`
      const claudeRecipe = `ANTHROPIC_BASE_URL=http://${bind}\nANTHROPIC_AUTH_TOKEN=${key}`

      const stat = (label, value, sub) => h('div', { className: 'ch-stat' },
        h('div', { className: 'ch-stat-value' }, value ?? '—'),
        h('div', { className: 'ch-stat-label' }, label),
        sub ? h('div', { className: 'ch-stat-sub' }, sub) : null)

      const srcCard = (title, dot, line, tab) => h('div', { className: 'ch-src' },
        h('div', { className: 'ch-src-head' }, h(Dot, { state: dot.state }), h('b', null, title)),
        h('div', { className: 'ch-src-line' }, line),
        h('button', { className: 'ch-link', onClick: () => goTab(tab) }, `${t('ov.configure')} →`))

      const statsBlock = h('div', { className: 'ch-stats' },
        stat(t('ov.gateway'), summary?.gateway?.running ? summary.gateway.bind : t('ov.off')),
        stat(t('ov.src.wb'), `${summary?.workbuddy?.ok ?? 0}/${summary?.workbuddy?.accounts ?? 0}`),
        stat(t('ov.src.up'), summary?.upstreams?.models ?? 0, `${summary?.upstreams?.upstreams ?? 0} upstream`))

      const recipeCard = (title, recipe) => h(Card, { title, accent: '#4b7bff' },
        h('pre', { className: 'ch-recipe' }, recipe),
        h('div', { className: 'ch-row' }, h(CopyBtn, { text: recipe })))

      return h('div', { className: 'ch-stack' },
        h(Onboarding, { settings, onSettings, goTab }),
        statsBlock,
        h(Card, { title: t('ov.recipe'), accent: '#9d5cff' },
          h('div', { className: 'ch-grid2' },
            recipeCard(t('ov.recipe.openai'), openaiRecipe),
            recipeCard(t('ov.recipe.claude'), claudeRecipe))),
        h(Card, { title: t('ov.sources') },
          h('div', { className: 'ch-grid2' },
            srcCard(t('ov.src.wb'), { state: (summary?.workbuddy?.ok ?? 0) > 0 ? 'ok' : 'off' },
              `${summary?.workbuddy?.accounts ?? 0} ${t('chan.accounts')}`, 'channels'),
            srcCard(t('ov.src.up'), { state: (summary?.upstreams?.upstreams ?? 0) > 0 ? 'ok' : 'off' },
              `${summary?.upstreams?.upstreams ?? 0} upstream · ${summary?.upstreams?.models ?? 0} ${t('up.models')}`, 'upstreams'))),
        summary?.usage?.length > 0 && h(Card, { title: t('ov.usage') },
          h('div', { className: 'ch-rows' }, summary.usage.map(row => h('div', { className: 'ch-rowline', key: row.model },
            h('div', { className: 'ch-rowline-main' },
              h('b', null, row.model),
              h('span', { className: 'ch-credit' }, `✔ ${row.ok}`),
              row.failed > 0 ? h('span', { className: 'ch-error' }, `✘ ${row.failed}`) : null,
              row.skipped > 0 ? h(Muted, null, `⤼ ${row.skipped}`) : null,
              h(Muted, null, `${row.inputTokens ?? 0} → ${row.outputTokens ?? 0} tok`)),
            h('div', { className: 'ch-muted' }, row.lastAt ? new Date(row.lastAt).toLocaleTimeString() : ''))))),
        h(Card, { title: undefined },
          h('div', { className: 'ch-toggles' },
            h(Toggle, { label: t('ov.enabled'), checked: settings.enabled !== false, onChange: value => onSettings({ enabled: value }) }),
            h(Toggle, { label: t('ov.gatewayToggle'), checked: settings.gatewayEnabled !== false, onChange: value => onSettings({ gatewayEnabled: value }) }),
            h(Toggle, { label: t('ov.autoCheckin'), checked: settings.autoCheckin === true, onChange: value => onSettings({ autoCheckin: value }) }),
            h(Toggle, { label: t('ov.packGateway'), checked: settings.packGateway === true, onChange: value => onSettings({ packGateway: value }), title: t('ov.packGateway.hint') }),
            h(Btn, { small: true, onClick: load }, t('ov.refresh'))),
          h('div', { className: 'ch-muted', style: { marginTop: '8px' } }, t('ov.layer.hint'))))
    }

    // ── WorkBuddy 卡 ───────────────────────────────────────────────────────────
    function WorkBuddyCard() {
      const [accounts, setAccounts] = useState(null)
      const [login, setLogin] = useState(null) // {loginId, realm}
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [showImport, setShowImport] = useState(false)
      const [showWbModels, setShowWbModels] = useState(false)
      const [wbModels, setWbModels] = useState(null)
      const [import_, setImport] = useState({ accessToken: '', refreshToken: '' })
      const [toast, showToast] = useToast()

      const load = useCallback(() => { void api('/workbuddy/accounts').then(payload => setAccounts(payload.accounts)).catch(() => {}) }, [])
      usePoll(load, 8000)

      const loadWbModels = useCallback(async () => {
        try {
          const payload = await api('/models')
          setWbModels((payload.models ?? []).filter(row => row.source === 'workbuddy'))
        } catch { setWbModels([]) }
      }, [])

      const toggleWbModel = async model => {
        try {
          await api('/models/toggle', { id: model.id, disabled: model.disabled !== true })
          await loadWbModels()
        } catch (error) { showToast(String(error.message), 'warn') }
      }

      useEffect(() => {
        if (!login?.loginId) return undefined
        let alive = true
        const timer = setInterval(async () => {
          try {
            const result = await api('/workbuddy/poll', { loginId: login.loginId })
            if (!alive) return
            if (result.status === 'done') {
              setLogin(null)
              setNotice({ kind: 'ok', text: fmt('chan.loginDone', { login: result.account?.label ?? 'workbuddy' }) })
              load()
            } else if (result.status === 'expired') {
              setLogin(null)
              setNotice({ kind: 'warn', text: t('chan.loginExpired') })
            }
          } catch { /* keep polling */ }
        }, 2500)
        return () => { alive = false; clearInterval(timer) }
      }, [login?.loginId])

      const startLogin = async realm => {
        setBusy(realm); setNotice(null)
        try {
          const started = await api('/workbuddy/login', { realm })
          try { window.open(started.authUrl, '_blank', 'noopener') } catch {}
          setLogin(started)
        } catch (error) { setNotice({ kind: 'warn', text: String(error.message) }) } finally { setBusy('') }
      }
      const act = async (key, fn, okText) => {
        setBusy(key)
        try { await fn(); if (okText) showToast(okText); load() } catch (error) { showToast(`${t('common.failed')}: ${error.message}`, 'warn') } finally { setBusy('') }
      }

      const loginRow = h('div', { className: 'ch-row' },
        h(Btn, { kind: 'primary', busy: busy === 'cn', onClick: () => startLogin('cn') }, t('chan.wb.cn')),
        h(Btn, { busy: busy === 'global', onClick: () => startLogin('global') }, t('chan.wb.global')),
        h(Btn, { small: true, onClick: () => setShowImport(!showImport) }, t('chan.wb.import')),
        h(Btn, { small: true, active: showWbModels, onClick: () => { const next = !showWbModels; setShowWbModels(next); if (next && wbModels === null) loadWbModels() } },
          `${t('chan.modelsToggle')}${wbModels !== null ? ` · ${wbModels.length}` : ''}`),
        login ? h('span', { className: 'ch-waiting' }, t('chan.wb.waiting')) : null)

      const wbModelsPanel = showWbModels ? h('div', { className: 'ch-uppanel' },
        h('div', { className: 'ch-row', style: { marginBottom: '8px' } },
          h(Muted, null, t('ov.chips.hint')),
          wbModels !== null && wbModels.some(model => model.disabled === true) && h(Btn, { small: true, onClick: async () => {
            for (const model of wbModels.filter(row => row.disabled === true)) await toggleWbModel({ ...model, disabled: false })
          } }, t('chan.model.enableAll'))),
        wbModels === null ? h('div', { className: 'ch-muted' }, t('common.loading'))
          : h('div', { className: 'ch-rows' }, wbModels.map(model => h('div', { className: 'ch-rowline', key: model.id },
            h('div', { className: 'ch-rowline-main' },
              h('b', null, model.name),
              h(Muted, null, model.realm === 'global' ? 'global' : 'cn'),
              h(Muted, null, model.modelId),
              model.disabled === true ? h(StateBadge, { text: t('chan.model.hidden') }) : null),
            h('div', { className: 'ch-rowline-actions' },
              h(Btn, { small: true, kind: model.disabled === true ? 'primary' : undefined, onClick: () => toggleWbModel(model) },
                model.disabled === true ? t('chan.model.on') : t('chan.model.off'))))))) : null

      const importBlock = showImport ? h('div', { className: 'ch-import' },
        h('div', { className: 'ch-grid' },
          h(Field, { label: t('chan.wb.accessToken'), value: import_.accessToken, onChange: value => setImport({ ...import_, accessToken: value }) }),
          h(Field, { label: t('chan.wb.refreshToken'), value: import_.refreshToken, onChange: value => setImport({ ...import_, refreshToken: value }) })),
        h(Btn, { small: true, disabled: import_.accessToken.trim().length < 8, onClick: () => act('import', async () => {
          await api('/workbuddy/import', { realm: 'cn', accessToken: import_.accessToken.trim(), refreshToken: import_.refreshToken.trim() || undefined })
          setImport({ accessToken: '', refreshToken: '' })
        }, t('chan.wb.importBtn')) }, t('chan.wb.importBtn'))) : null

      const rows = accounts === null ? h('div', { className: 'ch-muted ch-pad' }, t('common.loading'))
        : accounts.length === 0 ? h('div', { className: 'ch-muted ch-pad' }, t('chan.empty'))
          : h('div', { className: 'ch-rows' }, accounts.map(account => h('div', { className: 'ch-rowline', key: account.id },
            h('div', { className: 'ch-rowline-main' },
              h(Dot, { state: account.state === 'ok' ? 'ok' : account.state }),
              h('b', null, account.label ?? account.id),
              h(Muted, null, account.realm === 'global' ? 'global' : 'cn'),
              account.credits ? h('span', { className: 'ch-credit' }, `${account.credits.remain}/${account.credits.total}`) : null,
              account.lastError ? h('span', { className: 'ch-error', title: account.lastError }, '⚠') : null),
            h('div', { className: 'ch-rowline-actions' },
              h(Btn, { small: true, busy: busy === `c-${account.id}`, onClick: () => act(`c-${account.id}`, () => api('/workbuddy/credits', { id: account.id })) }, t('chan.credits')),
              account.realm === 'cn' && h(Btn, { small: true, busy: busy === `k-${account.id}`, onClick: () => act(`k-${account.id}`, () => api('/workbuddy/checkin', { id: account.id }), '✔') }, t('chan.checkin')),
              h(Btn, { small: true, onClick: () => act(`e-${account.id}`, () => api('/workbuddy/enable', { id: account.id, enabled: account.enabled === false })) }, account.enabled === false ? t('chan.enable') : t('chan.disable')),
              h(Btn, { small: true, kind: 'danger', onClick: () => { if (!window.confirm(t('common.confirmRemove'))) return; act(`d-${account.id}`, () => api('/workbuddy/remove', { id: account.id })) } }, t('chan.remove'))))))

      return h(Card, { title: 'WorkBuddy / CodeBuddy', accent: '#2b6cf0', badge: h(StateBadge, { state: (accounts?.length ?? 0) > 0 ? 'ok' : 'off', text: `${accounts?.length ?? 0} ${t('chan.accounts')}` }) },
        h('div', { className: 'ch-muted', style: { marginBottom: '10px' } }, t('chan.wb.desc')),
        loginRow,
        importBlock,
        wbModelsPanel,
        notice ? h('div', { className: `ch-notice ch-notice-${notice.kind}` }, notice.text) : null,
        rows,
        h('div', { className: 'ch-risk' }, `ℹ ${t('chan.wb.risk')}`),
        h(Toast, { toast }))
    }

    // ── 渠道包卡（RPC 驱动） ────────────────────────────────────────────────────
    function PackChannelCard({ channel, rpc, packNote }) {
      const [accounts, setAccounts] = useState(null)
      const [modelCount, setModelCount] = useState(null)
      const [showModels, setShowModels] = useState(false)
      const [models, setModels] = useState(null)
      const [modelBusy, setModelBusy] = useState('')
      const [login, setLogin] = useState(null)
      const [pollInfo, setPollInfo] = useState(null)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [toast, showToast] = useToast()

      const load = useCallback(async () => {
        try {
          const value = await rpc('account.list', { provider: channel.id })
          setAccounts(value?.accounts ?? [])
        } catch { setAccounts(null); return }
        if (showModels !== true) return
        try {
          const value = await rpc('model.list', { provider: channel.id })
          const rows = Array.isArray(value?.models) ? value.models : Array.isArray(value?.ids) ? value.ids.map(id => ({ id, name: id })) : []
          setModelCount(rows.length)
          setModels(rows)
        } catch { setModelCount(null) }
      }, [rpc, channel.id, showModels])
      usePoll(load, 15_000, channel.offset ?? 0)

      const loadModels = useCallback(async () => {
        if (rpc === null) return
        try {
          const value = await rpc('model.list', { provider: channel.id })
          setModels(Array.isArray(value?.models) ? value.models : Array.isArray(value?.ids) ? value.ids.map(id => ({ id, name: id })) : [])
        } catch (error) { showToast(String(error?.message ?? error), 'warn') }
      }, [rpc, channel.id])

      const toggleModel = async model => {
        if (rpc === null) return
        setModelBusy(model.id)
        try {
          if (model.dead === true) await rpc('model.clearDead', { provider: channel.id, modelId: model.id })
          else await rpc('model.setDisabled', { provider: channel.id, modelId: model.id, disabled: model.disabled !== true })
          await loadModels()
        } catch (error) { showToast(String(error?.message ?? error), 'warn') } finally { setModelBusy('') }
      }

      const setAllModels = async disabled => {
        if (rpc === null) return
        setModelBusy('all')
        try {
          await rpc('model.setAllDisabled', { provider: channel.id, disabled })
          await loadModels()
        } catch (error) { showToast(String(error?.message ?? error), 'warn') } finally { setModelBusy('') }
      }

      const pollOnce = useCallback(async () => {
        if (!login) return null
        try {
          const value = await rpc('login.poll', { accountId: login.accountId, provider: channel.id })
          setPollInfo({ at: Date.now(), raw: value ?? null, error: null })
          if (value?.done === true) {
            setLogin(null)
            if (value.success === false) setNotice({ kind: 'warn', text: fmt('chan.loginFailed', { reason: value.error ?? '?' }) })
            else { setNotice({ kind: 'ok', text: fmt('chan.loginDone', { login: value.login ?? channel.name }) }); load() }
          }
          return value
        } catch (error) {
          setPollInfo({ at: Date.now(), error: String(error?.message ?? error).slice(0, 160) })
          return null
        }
      }, [login, rpc, channel.id, load])

      useEffect(() => {
        if (!login) return undefined
        let alive = true
        const timer = setInterval(() => {
          if (!alive) return
          if (Date.now() - login.startedAt > 10 * 60_000) {
            setLogin(null)
            setNotice({ kind: 'warn', text: t('chan.loginExpired') })
            return
          }
          void pollOnce()
        }, 3000)
        return () => { alive = false; clearInterval(timer) }
      }, [login, pollOnce])

      if (rpc === null) {
        return h(Card, { title: channel.name, accent: channel.accent }, h('div', { className: 'ch-muted' }, t('chan.rpc.unavailable')))
      }

      const startLogin = async () => {
        setBusy('login'); setNotice(null)
        let popup = null
        try { popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null } catch { popup = null }
        try {
          const value = await rpc('account.create', {
            provider: channel.id,
            ...(channel.id === 'zcode' ? { zcodeProvider: 'bigmodel' } : {}),
          }, 90_000)
          const url = value?.loginUrl
          const accountId = value?.accountId
          if (typeof accountId !== 'string' || accountId === '') throw new Error('bad-answer')
          if (typeof url === 'string' && url !== '') {
            let opened = false
            try { if (popup && !popup.closed) { popup.location.replace(url); opened = true } } catch {}
            try { popup?.close?.() } catch {}
            if (!opened) { try { window.open(url, '_blank', 'noopener') } catch {} }
          } else { try { popup?.close?.() } catch {} }
          setLogin({ accountId, startedAt: Date.now() })
        } catch (error) {
          try { popup?.close?.() } catch {}
          setNotice({ kind: 'warn', text: String(error.message ?? error) })
        } finally { setBusy('') }
      }
      const act = async (key, fn) => {
        setBusy(key)
        try { await fn(); load() } catch (error) { showToast(String(error.message ?? error), 'warn') } finally { setBusy('') }
      }

      const headActions = h('div', { className: 'ch-row' },
        h(Btn, { small: true, kind: 'primary', busy: busy === 'login' || login !== null, onClick: startLogin }, t('chan.login')),
        (accounts?.length ?? 0) > 0 && h(Btn, { small: true, busy: busy === 'claim', onClick: () => act('claim', () => rpc('credits.claimAll', { provider: channel.id }, 180_000).then(() => showToast('✔')).catch(error => showToast(String(error.message), 'warn'))) }, t('chan.claim')),
        rpc !== null && h(Btn, { small: true, active: showModels, onClick: () => { const next = !showModels; setShowModels(next); if (next && models === null) loadModels() } },
          `${t('chan.modelsToggle')}${modelCount !== null ? ` · ${modelCount}` : ''}`))

      const rows = accounts === null ? h('div', { className: 'ch-muted ch-pad' }, t('common.loading'))
        : accounts.length === 0 ? h('div', { className: 'ch-muted ch-pad' }, t('chan.empty'))
          : h('div', { className: 'ch-rows' }, accounts.map(account => h('div', { className: 'ch-rowline', key: account.id },
            h('div', { className: 'ch-rowline-main' },
              h(Dot, { state: account.enabled === false ? 'off' : 'ok' }),
              h('b', null, account.nickname ?? account.id),
              typeof account.expiresAt === 'number' && account.expiresAt > 0 ? h(Muted, null, new Date(account.expiresAt).toLocaleDateString()) : null,
              account.disabled === true ? h(StateBadge, { state: 'dead', text: t('state.disabled') }) : null),
              h('div', { className: 'ch-rowline-actions' },
                h(Btn, { small: true, busy: busy === `r-${account.id}`, onClick: () => act(`r-${account.id}`, () => rpc('account.refresh', { accountId: account.id }, 90_000)) }, t('chan.refreshAcct')),
                h(Btn, { small: true, onClick: () => act(`e-${account.id}`, () => rpc('account.update', { accountId: account.id, patch: { enabled: account.enabled === false } })) }, account.enabled === false ? t('chan.enable') : t('chan.disable')),
                h(Btn, { small: true, kind: 'danger', onClick: () => { if (!window.confirm(t('common.confirmRemove'))) return; act(`d-${account.id}`, () => rpc('account.delete', { accountId: account.id })) } }, t('chan.remove'))))))

      const modelsPanel = showModels ? h('div', { className: 'ch-uppanel' },
        h('div', { className: 'ch-row', style: { marginBottom: '8px' } },
          h(Muted, null, t('ov.chips.hint')),
          h(Btn, { small: true, busy: modelBusy === 'all', onClick: () => setAllModels(false) }, t('chan.model.enableAll')),
          h(Btn, { small: true, busy: modelBusy === 'all', onClick: () => setAllModels(true) }, t('chan.model.disableAll'))),
        models === null ? h('div', { className: 'ch-muted' }, t('common.loading'))
          : models.length === 0 ? h('div', { className: 'ch-muted' }, t('chan.empty'))
            : h('div', { className: 'ch-rows' }, models.map(model => h('div', { className: 'ch-rowline', key: model.id },
              h('div', { className: 'ch-rowline-main' },
                h('b', null, model.name ?? model.id),
                model.name && model.name !== model.id ? h(Muted, null, model.id) : null,
                model.isFree === true ? h(StateBadge, { state: 'ok', text: t('chan.model.free') }) : null,
                model.dead === true ? h(StateBadge, { state: 'dead', text: t('chan.model.dead') }) : null,
                model.disabled === true ? h(StateBadge, { text: t('chan.model.hidden') }) : null),
              h('div', { className: 'ch-rowline-actions' },
                h(Btn, {
                  small: true, kind: model.disabled === true || model.dead === true ? 'primary' : undefined,
                  busy: modelBusy === model.id,
                  onClick: () => toggleModel(model),
                }, model.dead === true ? t('chan.model.restore') : model.disabled === true ? t('chan.model.on') : t('chan.model.off'))))))) : null

      return h(Card, {
        title: channel.name, accent: channel.accent,
        badge: h('span', { className: 'ch-org' }, `${channel.org}${modelCount !== null ? ` · ${modelCount} ${t('chan.models')}` : ''}`),
        actions: headActions,
      },
        notice ? h('div', { className: `ch-notice ch-notice-${notice.kind}` }, notice.text) : null,
        rows,
        modelsPanel,
        login ? h('div', { className: 'ch-waiting' },
          `${t('chan.wb.waiting')}（${Math.round((Date.now() - login.startedAt) / 1000)}s）`,
          pollInfo?.error ? h('span', { className: 'ch-error' }, ` · ${pollInfo.error}`) : null,
          h(Btn, { small: true, onClick: async () => {
            const raw = await pollOnce()
            showToast(raw ? JSON.stringify(raw).slice(0, 180) : 'poll: no answer', 'warn')
          } }, t('chan.checkNow'))) : null,
        packNote ? h('div', { className: 'ch-risk' }, `ℹ ${packNote}`) : null,
        h(Toast, { toast }))
    }

    function ChannelsPage({ ctx }) {
      const { available, rpc } = useChannelRpc(ctx)
      const [summary, setSummary] = useState(null)
      const [hubModels, setHubModels] = useState([])
      useEffect(() => {
        void api('/summary').then(setSummary).catch(() => {})
        void api('/models').then(payload => setHubModels(payload.models ?? [])).catch(() => {})
      }, [])
      const packReason = summary?.pack?.status?.reason
      const mounted = packReason === 'forced' || packReason === 'auto' || summary?.pack?.status?.mounted === true
      const packNote = mounted ? t('chan.pack.byMe')
        : packReason === 'ofm-installed' ? t('chan.pack.ofmBlock')
          : packReason === 'ofm-present' ? t('chan.pack.byOfm') : t('chan.pack.none')
      const dualWarn = mounted && summary?.pack?.ofmPresent === true ? t('chan.pack.dual') : null

      const packStatus = summary?.pack?.status
      const packOffline = mounted === false && packStatus !== undefined && packStatus !== null && packStatus.reason !== 'pending'
      const diag = async () => {
        try {
          const probe = await api('/pack/probe')
          showToast(`ofm标记:${probe.ofmPresent ? '存在' : '无'} · pack.js加载:${probe.importOk ? 'OK' : probe.importError ?? '失败'} · 挂载:${probe.mount?.reason ?? '?'}`, 'warn')
        } catch (error) { showToast(String(error.message), 'warn') }
      }

      return h('div', { className: 'ch-stack' },
        dualWarn ? h('div', { className: 'ch-notice ch-notice-warn' }, dualWarn) : null,
        packOffline ? h('div', { className: 'ch-notice ch-notice-warn' },
          `${t('chan.pack.offLine')}（${packStatus.reason}）${packStatus.error ? ` — ${packStatus.error}` : ''} `,
          h(Btn, { small: true, onClick: diag }, t('chan.pack.diag'))) : null,
        h(WorkBuddyCard),
        h('div', { className: 'ch-cards-grid' }, CHANNEL_PROVIDERS.map((channel, index) => h(PackChannelCard, {
          key: channel.id, channel: { ...channel, offset: (index % 5) * 3000 }, rpc: available ? rpc : null, packNote,
        }))),
        h(BridgeModelsCard, { hubModels }))
    }

    // ── 桥接渠道模型开关（宿主注册 provider：deepseek-account/tokenrhythm/…） ──
    function BridgeModelsCard({ hubModels }) {
      const [toast, showToast] = useToast()
      const grouped = {}
      for (const model of (hubModels ?? []).filter(row => row.id.startsWith('pk/'))) {
        ;(grouped[model.provider] ??= []).push(model)
      }
      const providers = Object.keys(grouped).sort()
      if (providers.length === 0) return null
      const toggle = async model => {
        try {
          await api('/models/toggle', { id: model.id, disabled: model.disabled !== true })
          showToast(model.disabled !== true ? `${model.id} 已隐藏` : `${model.id} 已恢复`)
        } catch (error) { showToast(String(error.message), 'warn') }
      }
      return h(Card, { title: t('bridge.title'), accent: '#7a6cf0', badge: h('span', { className: 'ch-org' }, t('bridge.hint')) },
        h('div', { className: 'ch-rows' }, providers.map(provider => h('div', { className: 'ch-uppanel', key: provider },
          h('div', { className: 'ch-row', style: { marginBottom: '8px' } }, h('b', null, provider)),
          h('div', { className: 'ch-rows' }, grouped[provider].models.map(model => h('div', { className: 'ch-rowline', key: model.id },
            h('div', { className: 'ch-rowline-main' },
              h('code', null, model.modelId ?? model.id),
              model.disabled === true ? h(StateBadge, { text: t('chan.model.hidden') }) : null),
            h('div', { className: 'ch-rowline-actions' },
              h(Btn, { small: true, kind: model.disabled === true ? 'primary' : undefined, onClick: () => toggle(model) },
                model.disabled === true ? t('chan.model.on') : t('chan.model.off'))))))))))
    }

    // ── API 中转 ───────────────────────────────────────────────────────────────
    function PresetCard({ preset, onSaved }) {
      const [key, setKey] = useState('')
      const [entry, setEntry] = useState(null)
      const [busy, setBusy] = useState(false)
      const [toast, showToast] = useToast()
      const load = useCallback(() => {
        void api('/upstreams').then(payload => {
          setEntry((payload.upstreams ?? []).find(row => row.id === `preset-${preset.id}`) ?? null)
        }).catch(() => {})
      }, [preset.id])
      usePoll(load, 20_000)

      const save = async () => {
        setBusy(true)
        try {
          await api('/upstreams/save', { id: `preset-${preset.id}`, name: preset.name, kind: preset.kind, baseURL: preset.baseURL, apiKey: key.trim(), enabled: true })
          setKey('')
          showToast(t('up.saved'))
          load(); onSaved?.()
        } catch (error) { showToast(String(error.message), 'warn') } finally { setBusy(false) }
      }
      const discover = async () => {
        setBusy(true)
        try {
          const payload = await api('/upstreams/discover', { id: `preset-${preset.id}` })
          showToast(fmt('up.discovered', { n: payload.models?.length ?? 0 }))
          load(); onSaved?.()
        } catch (error) { showToast(String(error.message), 'warn') } finally { setBusy(false) }
      }

      const connected = entry?.hasKey === true
      return h(Card, {
        title: preset.name, accent: connected ? '#31b573' : '#8a93a8',
        badge: h(StateBadge, { state: connected ? 'ok' : 'off', text: connected ? (entry?.keyFingerprint ?? '✔') : t('up.noKey') }),
      },
        h('div', { className: 'ch-muted', style: { marginBottom: '8px' } }, preset.baseURL),
        h('div', { className: 'ch-row' },
          h('input', { className: 'ch-input ch-grow', type: 'password', value: key, onChange: e => setKey(e.target.value), placeholder: t('up.keyPlaceholder') }),
          h(Btn, { kind: 'primary', small: true, busy, disabled: key.trim().length < 8, onClick: save }, t('up.save')),
          connected && h(Btn, { small: true, busy, onClick: discover }, t('up.discover'))),
        connected && h('div', { className: 'ch-muted', style: { marginTop: '6px' } }, `${entry?.modelCount ?? 0} ${t('up.models')}`),
        h(Toast, { toast }))
    }

    /** 每行：`id | 显示名 | 上下文窗口`，后两项可省。 */
    const parseModelLines = text => String(text ?? '').split(/\n+/).map(line => line.trim()).filter(Boolean).map(line => {
      const parts = line.split('|').map(part => part.trim())
      if (!parts[0]) return null
      const ctxNum = Number(parts[2])
      return {
        id: parts[0],
        ...(parts[1] ? { name: parts[1] } : {}),
        ...(parts[2] && Number.isFinite(ctxNum) ? { contextWindow: ctxNum } : {}),
      }
    }).filter(Boolean)

    function UpstreamRow({ row, gw, hubModels, onChanged, showToast }) {
      const [panel, setPanel] = useState(null) // 'edit' | 'local' | 'models' | null
      const [form, setForm] = useState(null)
      const [busy, setBusy] = useState(false)

      const openEdit = () => {
        if (panel === 'edit') { setPanel(null); return }
        setForm({
          name: row.name,
          baseURL: row.baseURL,
          kind: row.kind,
          apiKey: '',
          modelsText: (row.models ?? []).map(model => [
            model.id,
            model.name && model.name !== model.id ? model.name : '',
            model.contextWindow,
          ].filter(part => part !== undefined && part !== '').join(' | ')).join('\n'),
        })
        setPanel('edit')
      }

      const save = async () => {
        setBusy(true)
        try {
          await api('/upstreams/save', {
            id: row.id,
            name: form.name.trim() || row.name,
            baseURL: form.baseURL.trim(),
            kind: form.kind,
            ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
            models: parseModelLines(form.modelsText),
            enabled: true,
          })
          showToast(t('up.saved'))
          setPanel(null)
          onChanged?.()
        } catch (error) { showToast(String(error.message), 'warn') } finally { setBusy(false) }
      }

      const bind = gw?.bind ?? '127.0.0.1:8330'
      const key = gw?.key ?? ''
      const exampleModel = row.models?.[0]?.id ? `up/${row.id}/${row.models[0].id}` : `up/${row.id}/<模型id>`
      const curl = `curl http://${bind}/v1/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${exampleModel}","messages":[{"role":"user","content":"hi"}]}'`

      const editPanel = panel === 'edit' && form ? h('div', { className: 'ch-uppanel' },
        h('div', { className: 'ch-grid' },
          h(Field, { label: t('up.name'), value: form.name, onChange: value => setForm({ ...form, name: value }) }),
          h(Field, { label: t('up.baseURL'), value: form.baseURL, onChange: value => setForm({ ...form, baseURL: value }) }),
          h('label', { className: 'ch-field' },
            h('span', { className: 'ch-field-label' }, t('up.kind')),
            h('select', { className: 'ch-input ch-select', value: form.kind, onChange: e => setForm({ ...form, kind: e.target.value }) },
              h('option', { value: 'openai-chat' }, 'openai-chat'),
              h('option', { value: 'anthropic-messages' }, 'anthropic-messages'))),
          h(Field, { label: `${t('up.key')}（${t('up.keyKeep')}）`, value: form.apiKey, onChange: value => setForm({ ...form, apiKey: value }) })),
        h(Field, { area: true, rows: 3, label: t('up.modelsField'), value: form.modelsText, onChange: value => setForm({ ...form, modelsText: value }) }),
        h('div', { className: 'ch-row', style: { marginTop: '8px' } },
          h(Btn, { kind: 'primary', small: true, busy, disabled: !form.baseURL.trim(), onClick: save }, t('up.save')))) : null

      const localPanel = panel === 'local' ? h('div', { className: 'ch-uppanel' },
        h('pre', { className: 'ch-recipe' }, curl),
        h('div', { className: 'ch-muted' }, `model id 形如 up/${row.id}/<模型id> · Key 与网关页一致`),
        h('div', { className: 'ch-row', style: { marginTop: '6px' } }, h(CopyBtn, { text: curl }))) : null

      const rowModels = (hubModels ?? []).filter(model => model.upstreamId === row.id)
      const modelsPanel = panel === 'models' ? h('div', { className: 'ch-uppanel' },
        h('div', { className: 'ch-row', style: { marginBottom: '8px' } },
          h(Muted, null, t('ov.chips.hint')),
          rowModels.some(model => model.disabled === true) && h(Btn, { small: true, onClick: async () => {
            for (const model of rowModels.filter(row2 => row2.disabled === true)) await api('/models/toggle', { id: model.id, disabled: false }).catch(() => {})
            onChanged?.()
          } }, t('chan.model.enableAll'))),
        rowModels.length === 0 ? h('div', { className: 'ch-muted' }, t('chan.empty'))
          : h('div', { className: 'ch-rows' }, rowModels.map(model => h('div', { className: 'ch-rowline', key: model.id },
            h('div', { className: 'ch-rowline-main' },
              h('b', null, model.name),
              h(Muted, null, model.modelId),
              model.disabled === true ? h(StateBadge, { text: t('chan.model.hidden') }) : null),
            h('div', { className: 'ch-rowline-actions' },
              h(Btn, { small: true, kind: model.disabled === true ? 'primary' : undefined, onClick: () => {
                void api('/models/toggle', { id: model.id, disabled: model.disabled !== true }).then(onChanged).catch(error => showToast(String(error.message), 'warn'))
              } }, model.disabled === true ? t('chan.model.on') : t('chan.model.off'))))))) : null

      return h('div', { className: 'ch-uprow' },
        h('div', { className: 'ch-rowline' },
          h('div', { className: 'ch-rowline-main' },
            h(Dot, { state: row.enabled && row.hasKey ? 'ok' : 'off' }),
            h('b', null, row.name),
            h(Muted, null, row.kind),
            h(Muted, null, row.hasKey ? row.keyFingerprint ?? '✔' : t('up.noKey')),
            h(Muted, null, `${row.modelCount} ${t('up.models')}`)),
          h('div', { className: 'ch-rowline-actions' },
            h(Btn, { small: true, active: panel === 'models', onClick: () => setPanel(panel === 'models' ? null : 'models') },
              `${t('chan.modelsToggle')} · ${row.modelCount}`),
            h(Btn, { small: true, active: panel === 'local', onClick: () => setPanel(panel === 'local' ? null : 'local') }, t('up.local')),
            h(Btn, { small: true, active: panel === 'edit', onClick: openEdit }, t('up.edit')),
            h(Btn, { small: true, busy, onClick: async () => {
              setBusy(true)
              try { const payload = await api('/upstreams/discover', { id: row.id }); showToast(fmt('up.discovered', { n: payload.models?.length ?? 0 })); onChanged?.() } catch (error) { showToast(String(error.message), 'warn') } finally { setBusy(false) }
            } }, t('up.discover')),
            h(Btn, { small: true, onClick: async () => {
              try { await api('/upstreams/enable', { id: row.id, enabled: row.enabled === false }); onChanged?.() } catch (error) { showToast(String(error.message), 'warn') }
            } }, row.enabled === false ? t('up.enable') : t('up.disable')),
            h(Btn, { small: true, kind: 'danger', onClick: async () => {
              if (!window.confirm(t('common.confirmRemove'))) return
              try { await api('/upstreams/remove', { id: row.id }); onChanged?.() } catch (error) { showToast(String(error.message), 'warn') }
            } }, t('up.remove')))),
        editPanel,
        localPanel,
        modelsPanel)
    }

    function UpstreamsPage() {
      const [rows, setRows] = useState(null)
      const [presets, setPresets] = useState([])
      const [gw, setGw] = useState(null)
      const [hubModels, setHubModels] = useState([])
      const [custom, setCustom] = useState({ name: '', baseURL: '', kind: 'openai-chat', apiKey: '' })
      const [showCustom, setShowCustom] = useState(false)
      const [busy, setBusy] = useState(false)
      const [toast, showToast] = useToast()
      const load = useCallback(() => {
        void api('/upstreams').then(payload => setRows(payload.upstreams)).catch(() => {})
        void api('/gateway').then(setGw).catch(() => {})
        void api('/models').then(payload => setHubModels(payload.models ?? [])).catch(() => {})
      }, [])
      usePoll(load, 20_000)
      useEffect(() => { void api('/upstreams/presets').then(payload => setPresets(payload.presets ?? [])).catch(() => {}) }, [])

      const act = async (fn, okText) => {
        setBusy(true)
        try { await fn(); if (okText) showToast(okText); load() } catch (error) { showToast(String(error.message), 'warn') } finally { setBusy(false) }
      }

      const customCard = h(Card, { title: t('up.custom'), accent: '#9d5cff' },
        h('div', { className: 'ch-row' },
          h(Btn, { small: true, onClick: () => setShowCustom(!showCustom) }, showCustom ? '−' : '+')),
        showCustom ? h('div', null,
          h('div', { className: 'ch-grid' },
            h(Field, { label: t('up.name'), value: custom.name, onChange: value => setCustom({ ...custom, name: value }) }),
            h(Field, { label: t('up.baseURL'), value: custom.baseURL, onChange: value => setCustom({ ...custom, baseURL: value }), placeholder: 'https://…/v1' }),
            h('label', { className: 'ch-field' },
              h('span', { className: 'ch-field-label' }, t('up.kind')),
              h('select', { className: 'ch-input ch-select', value: custom.kind, onChange: e => setCustom({ ...custom, kind: e.target.value }) },
                h('option', { value: 'openai-chat' }, 'openai-chat'),
                h('option', { value: 'anthropic-messages' }, 'anthropic-messages'))),
            h(Field, { label: t('up.key'), value: custom.apiKey, onChange: value => setCustom({ ...custom, apiKey: value }) })),
          h(Btn, { kind: 'primary', small: true, busy, disabled: !custom.baseURL.trim(), onClick: () => act(async () => {
            await api('/upstreams/save', { ...custom, baseURL: custom.baseURL.trim() })
            setCustom({ name: '', baseURL: '', kind: 'openai-chat', apiKey: '' })
            setShowCustom(false)
          }, t('up.saved')) }, t('up.save'))) : null)

      const listCard = h(Card, { title: `${t('tab.upstreams')} · ${rows?.length ?? 0}` },
        rows === null ? h('div', { className: 'ch-muted ch-pad' }, t('common.loading'))
          : rows.length === 0 ? h('div', { className: 'ch-muted ch-pad' }, t('up.desc'))
            : h('div', { className: 'ch-rows' }, rows.map(row => h(UpstreamRow, { key: row.id, row, gw, hubModels, onChanged: load, showToast }))))

      return h('div', { className: 'ch-stack' },
        h('div', { className: 'ch-muted' }, t('up.desc')),
        h('div', { className: 'ch-cards-grid' }, presets.map(preset => h(PresetCard, { key: preset.id, preset, onSaved: load }))),
        customCard,
        listCard,
        h(Toast, { toast }))
    }

    // ── 降级链 ─────────────────────────────────────────────────────────────────
    function CombosPage() {
      const [rows, setRows] = useState(null)
      const [models, setModels] = useState([])
      const [draft, setDraft] = useState({ name: '', strategy: 'fallback', chain: [] })
      const [toast, showToast] = useToast()
      const load = useCallback(() => {
        void api('/combos').then(payload => setRows(payload.combos)).catch(() => {})
        void api('/models').then(payload => setModels(payload.models ?? [])).catch(() => {})
      }, [])
      usePoll(load, 15_000)

      const saveAll = async list => {
        try {
          const payload = await api('/combos/save', { combos: list })
          setRows(payload.combos)
          showToast(t('common.ok'))
        } catch (error) { showToast(`${t('common.failed')}: ${error.message}`, 'warn') }
      }

      const addModel = modelId => {
        if (!modelId || draft.chain.includes(modelId)) return
        setDraft({ ...draft, chain: [...draft.chain, modelId] })
      }
      const move = (index, delta) => {
        const chain = [...draft.chain]
        const target = index + delta
        if (target < 0 || target >= chain.length) return
        ;[chain[index], chain[target]] = [chain[target], chain[index]]
        setDraft({ ...draft, chain })
      }

      const builder = h(Card, { title: t('combo.add'), accent: '#9d5cff' },
        h('div', { className: 'ch-grid' },
          h(Field, { label: t('combo.name'), value: draft.name, onChange: value => setDraft({ ...draft, name: value }) }),
          h('label', { className: 'ch-field' },
            h('span', { className: 'ch-field-label' }, t('tab.combos')),
            h('select', { className: 'ch-input ch-select', value: draft.strategy, onChange: e => setDraft({ ...draft, strategy: e.target.value }) },
              h('option', { value: 'fallback' }, t('combo.strategy.fallback')),
              h('option', { value: 'round-robin' }, t('combo.strategy.round'))))),
        h('div', { className: 'ch-row', style: { marginBottom: '8px' } },
          h('select', {
            className: 'ch-input ch-select ch-grow', value: '',
            onChange: e => { addModel(e.target.value); e.target.value = '' },
          },
            h('option', { value: '' }, t('combo.pick')),
            models.filter(model => !draft.chain.includes(model.id)).map(model => h('option', { key: model.id, value: model.id }, model.id)))),
        draft.chain.length > 0 ? h('div', { className: 'ch-chainlist' }, draft.chain.map((modelId, index) => h('div', { className: 'ch-rowline', key: modelId },
          h('div', { className: 'ch-rowline-main' }, h('span', { className: 'ch-onb-num' }, index + 1), h('code', null, modelId)),
          h('div', { className: 'ch-rowline-actions' },
            h(Btn, { small: true, onClick: () => move(index, -1), disabled: index === 0 }, '↑'),
            h(Btn, { small: true, onClick: () => move(index, 1), disabled: index === draft.chain.length - 1 }, '↓'),
            h(Btn, { small: true, kind: 'danger', onClick: () => setDraft({ ...draft, chain: draft.chain.filter((_, at) => at !== index) }) }, '×'))))) : null,
        h('div', { className: 'ch-row', style: { marginTop: '10px' } },
          h(Btn, { kind: 'primary', small: true, disabled: !draft.name.trim() || draft.chain.length < 2, onClick: () => {
            void saveAll([...(rows ?? []), { name: draft.name.trim(), strategy: draft.strategy, chain: draft.chain }])
            setDraft({ name: '', strategy: 'fallback', chain: [] })
          } }, t('combo.save'))))

      const listCard = h(Card, { title: t('tab.combos') },
        rows === null ? h('div', { className: 'ch-muted ch-pad' }, t('common.loading'))
          : rows.length === 0 ? h('div', { className: 'ch-muted ch-pad' }, t('combo.empty'))
            : h('div', { className: 'ch-rows' }, rows.map((row, index) => h('div', { className: 'ch-rowline', key: `${row.name}-${index}` },
              h('div', { className: 'ch-rowline-main' },
                h('b', null, `combo/${row.name}`),
                h(Muted, null, row.strategy),
                h('span', { className: 'ch-chain' }, (row.chain ?? []).join(' → '))),
              h('div', { className: 'ch-rowline-actions' },
                h(Btn, { small: true, kind: 'danger', onClick: () => { if (!window.confirm(t('common.confirmRemove'))) return; void saveAll(rows.filter((_, at) => at !== index)) } }, t('chan.remove')))))))

      return h('div', { className: 'ch-stack' },
        h('div', { className: 'ch-muted' }, t('combo.hint')),
        h(Notice, { text: t('combo.scope') }),
        builder,
        listCard,
        h(Toast, { toast }))
    }

    // ── 网关 ───────────────────────────────────────────────────────────────────
    function GatewayPage({ settings, onSettings }) {
      const [info, setInfo] = useState(null)
      const [reveal, setReveal] = useState(false)
      const [newKey, setNewKey] = useState('')
      const [port, setPort] = useState(String(settings.gatewayPort ?? 8330))
      const [toast, showToast] = useToast()
      const load = useCallback(() => { void api('/gateway').then(setInfo).catch(() => {}) }, [])
      usePoll(load, 6000)

      const bind = info?.bind ?? `127.0.0.1:${settings.gatewayPort ?? 8330}`
      const key = info?.key ?? ''
      const openaiRecipe = `OPENAI_BASE_URL=http://${bind}/v1\nOPENAI_API_KEY=${key}`
      const claudeRecipe = `ANTHROPIC_BASE_URL=http://${bind}\nANTHROPIC_AUTH_TOKEN=${key}`
      const curlRecipe = `curl http://${bind}/v1/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"<模型id>","messages":[{"role":"user","content":"hi"}]}'`

      const restart = async () => {
        try { const payload = await api('/gateway/restart'); setInfo(payload); showToast(t('common.ok')) } catch (error) { showToast(String(error.message), 'warn') }
      }

      const running = info?.running === true
      const recipe = (title, text) => h(Card, { title, accent: '#4b7bff' },
        h('pre', { className: 'ch-recipe' }, text),
        h('div', { className: 'ch-row' }, h(CopyBtn, { text })))

      return h('div', { className: 'ch-stack' },
        h(Card, { title: t('tab.gateway'), accent: running ? '#31b573' : '#8a93a8', badge: h(StateBadge, { state: running ? 'ok' : 'off', text: running ? t('gw.running') : t('gw.stopped') }) },
          h('div', { className: 'ch-row' },
            h(Toggle, { label: t('ov.gatewayToggle'), checked: settings.gatewayEnabled !== false, onChange: value => onSettings({ gatewayEnabled: value }) }),
            h(Toggle, { label: t('gw.thinkingOff'), checked: settings.thinkingOffByDefault === true, onChange: value => onSettings({ thinkingOffByDefault: value }) }),
            h('span', { className: 'ch-field-label' }, t('gw.port')),
            h('input', { className: 'ch-input', style: { width: '90px' }, type: 'number', value: port, onChange: e => setPort(e.target.value) }),
            h(Btn, { small: true, onClick: () => {
              const value = Number(port)
              if (!Number.isInteger(value) || value < 1024 || value > 65535) { showToast(t('gw.portInvalid'), 'warn'); return }
              onSettings({ gatewayPort: value })
            } }, t('gw.apply')),
            h(Btn, { small: true, onClick: restart }, running ? '↻' : t('gw.start'))),
          h('div', { className: 'ch-kv' },
            h('span', { className: 'ch-kv-label' }, t('gw.key')),
            h('code', null, reveal ? key : `${key.slice(0, 6)}…${key.slice(-4)}`),
            h(Btn, { small: true, onClick: () => setReveal(!reveal) }, reveal ? t('gw.hide') : t('gw.show')),
            h(CopyBtn, { text: key })),
          h('div', { className: 'ch-kv' },
            h('span', { className: 'ch-kv-label' }, t('gw.setKey')),
            h('input', { className: 'ch-input', style: { width: '220px', fontFamily: 'ui-monospace,monospace' }, value: newKey, onChange: e => setNewKey(e.target.value), placeholder: 'sk-my-own-key-2026' }),
            h(Btn, { small: true, kind: 'primary', disabled: newKey.trim().length < 16, onClick: async () => {
              try { const payload = await api('/gateway/set-key', { key: newKey.trim() }); setInfo(current => ({ ...(current ?? {}), key: payload.key })); setNewKey(''); showToast(t('gw.keyApplied')) } catch (error) { showToast(String(error.message), 'warn') }
            } }, t('gw.apply'))),
          h('div', { className: 'ch-stats', style: { marginTop: '12px' } },
            h('div', { className: 'ch-stat' }, h('div', { className: 'ch-stat-value' }, info?.stats?.requests ?? 0), h('div', { className: 'ch-stat-label' }, t('gw.requests'))),
            h('div', { className: 'ch-stat' }, h('div', { className: 'ch-stat-value' }, info?.stats?.ok ?? 0), h('div', { className: 'ch-stat-label' }, t('gw.ok'))),
            h('div', { className: 'ch-stat' }, h('div', { className: 'ch-stat-value' }, info?.stats?.failed ?? 0), h('div', { className: 'ch-stat-label' }, t('gw.failed'))))),
        h('div', { className: 'ch-grid2' },
          recipe(t('ov.recipe.openai'), openaiRecipe),
          recipe(t('ov.recipe.claude'), claudeRecipe)),
        recipe('curl', curlRecipe),
        h(Toast, { toast }))
    }

    // ── 日志 ───────────────────────────────────────────────────────────────────
    function LogsPage() {
      const [rows, setRows] = useState(null)
      const load = useCallback(() => { void api('/logs').then(payload => setRows(payload.logs ?? [])).catch(() => {}) }, [])
      usePoll(load, 5000)
      return h(Card, { title: t('tab.logs'), actions: h(Btn, { small: true, onClick: () => void api('/logs/clear', {}).then(load) }, t('logs.clear')) },
        rows === null ? h('div', { className: 'ch-muted ch-pad' }, t('common.loading'))
          : rows.length === 0 ? h('div', { className: 'ch-muted ch-pad' }, t('logs.empty'))
            : h('div', { className: 'ch-logs' }, rows.slice().reverse().map((row, index) => h('div', { className: `ch-log ch-log-${row.level ?? 'info'}`, key: index },
              h('span', { className: 'ch-log-time' }, new Date(row.at).toLocaleTimeString()),
              h('span', null, row.message ?? row.scope ?? '')))))
    }

    // ── 页面壳 ─────────────────────────────────────────────────────────────────
    function SettingsPage(props) {
      const [tab, setTab] = useState('overview')
      const [settings, setSettings] = useState(null)
      const [toast, showToast] = useToast()
      const load = useCallback(() => { void api('/settings').then(payload => setSettings(payload.settings ?? {})).catch(() => {}) }, [])
      useEffect(load, [load])
      const patch = async change => {
        setSettings(current => ({ ...current, ...change }))
        try { const payload = await api('/settings', change); setSettings(payload.settings ?? {}) } catch (error) {
          showToast(`${t('common.failed')}: ${error.message}`, 'warn')
          load()
        }
      }
      const tabs = [
        ['overview', t('tab.overview')],
        ['channels', t('tab.channels')],
        ['upstreams', t('tab.upstreams')],
        ['combos', t('tab.combos')],
        ['gateway', t('tab.gateway')],
        ['logs', t('tab.logs')],
      ]
      const goTab = id => setTab(id)
      const page = settings === null ? h('div', { className: 'ch-muted ch-pad' }, t('common.loading'))
        : tab === 'overview' ? h(Overview, { settings, onSettings: patch, goTab })
          : tab === 'channels' ? h(ChannelsPage, { ctx: props?.ctx })
            : tab === 'upstreams' ? h(UpstreamsPage)
              : tab === 'combos' ? h(CombosPage)
                : tab === 'gateway' ? h(GatewayPage, { settings, onSettings: patch })
                  : h(LogsPage)
      return h('div', { className: 'ch-root' },
        h('style', null, STYLES),
        h('div', { className: 'ch-nav' }, tabs.map(([id, label]) => h('button', {
          key: id, className: `ch-navbtn${tab === id ? ' active' : ''}`, onClick: () => setTab(id),
        }, label))),
        page,
        h(Toast, { toast }))
    }

    const STYLES = `
.ch-root{font-size:13px;color:var(--ch-fg,#d8dee9);max-width:1020px}
.ch-nav{display:flex;gap:4px;margin-bottom:14px;flex-wrap:wrap;position:sticky;top:0;z-index:5;background:inherit;padding:4px 0}
.ch-navbtn{border:0;background:transparent;color:inherit;opacity:.6;padding:7px 15px;border-radius:9px;cursor:pointer;font-size:13px;transition:all .15s}
.ch-navbtn:hover{opacity:.9;background:rgba(120,140,255,.1)}
.ch-navbtn.active{background:linear-gradient(135deg,rgba(75,123,255,.25),rgba(157,92,255,.2));opacity:1}
.ch-stack{display:flex;flex-direction:column;gap:12px}
.ch-card{background:rgba(128,140,170,.07);border:1px solid rgba(128,140,170,.14);border-radius:14px;padding:14px 16px}
.ch-card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:10px;flex-wrap:wrap}
.ch-card-title{font-weight:600;font-size:13px;display:flex;align-items:center;gap:8px}
.ch-accent{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}
.ch-org{opacity:.55;font-size:12px}
.ch-pad{padding:6px 0}
.ch-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.ch-stat{background:rgba(128,140,170,.07);border:1px solid rgba(128,140,170,.1);border-radius:12px;padding:11px 13px}
.ch-stat-value{font-size:16px;font-weight:600;word-break:break-all}
.ch-stat-label{opacity:.55;font-size:12px;margin-top:3px}
.ch-stat-sub{opacity:.4;font-size:11px;margin-top:1px}
.ch-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px}
.ch-toggles{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.ch-toggle{display:inline-flex;gap:7px;align-items:center;cursor:pointer;user-select:none}
.ch-switch{width:32px;height:18px;border-radius:9px;background:rgba(128,140,170,.3);position:relative;transition:background .15s;flex:none}
.ch-switch.on{background:#4b7bff}
.ch-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s}
.ch-switch.on .ch-knob{left:16px}
.ch-toggle-label{font-size:12.5px}
.ch-btn{border:1px solid rgba(128,140,170,.25);background:rgba(120,140,255,.1);color:inherit;border-radius:9px;padding:7px 14px;cursor:pointer;font-size:13px;transition:background .15s}
.ch-btn:hover:not(:disabled){background:rgba(120,140,255,.2)}
.ch-btn:disabled{opacity:.45;cursor:default}
.ch-btn-sm{padding:3px 10px;font-size:12px}
.ch-btn-primary{background:linear-gradient(135deg,rgba(75,123,255,.35),rgba(157,92,255,.3));border-color:rgba(120,140,255,.4)}
.ch-btn-danger{background:rgba(255,100,100,.12);border-color:rgba(255,100,100,.25)}
.ch-btn-danger:hover:not(:disabled){background:rgba(255,100,100,.22)}
.ch-input{background:rgba(0,0,0,.25);border:1px solid rgba(128,140,170,.22);color:inherit;border-radius:9px;padding:7px 11px;font-size:13px;width:100%;box-sizing:border-box}
.ch-input:focus{outline:none;border-color:rgba(120,140,255,.5)}
.ch-select{width:auto;min-width:130px}
.ch-grow{flex:1;min-width:120px;width:auto}
.ch-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:10px}
.ch-field{display:flex;flex-direction:column;gap:4px}
.ch-field-label{opacity:.55;font-size:12px}
.ch-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ch-rows{display:flex;flex-direction:column;gap:6px}
.ch-uprow{display:flex;flex-direction:column;gap:6px}
.ch-uppanel{background:rgba(0,0,0,.14);border:1px dashed rgba(128,140,170,.25);border-radius:10px;padding:10px 12px}
.ch-rowline{display:flex;justify-content:space-between;gap:10px;align-items:center;background:rgba(0,0,0,.16);border-radius:10px;padding:8px 12px;flex-wrap:wrap}
.ch-rowline-main{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
.ch-rowline-actions{display:flex;gap:5px;flex-wrap:wrap}
.ch-chain{word-break:break-all;font-family:ui-monospace,monospace;font-size:12px;opacity:.7}
.ch-chainlist{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.ch-dot{width:8px;height:8px;border-radius:50%;background:#8a93a8;flex:none}
.ch-dot-ok{background:#31b573;box-shadow:0 0 6px rgba(49,181,115,.6)}
.ch-dot-dead{background:#ff6b6b}
.ch-dot-cooling,.ch-dot-warn{background:#ffb347}
.ch-badge{font-size:11px;border-radius:7px;padding:2px 8px;background:rgba(128,140,170,.18);font-family:ui-monospace,monospace}
.ch-badge-ok{background:rgba(49,181,115,.18)}
.ch-badge-dead,.ch-badge-off{background:rgba(255,107,107,.15)}
.ch-chips{display:flex;flex-wrap:wrap;gap:6px}
.ch-chip{background:rgba(128,140,170,.14);border-radius:7px;padding:3px 9px;font-size:12px;font-family:ui-monospace,monospace;transition:background .15s}
.ch-chip-btn{cursor:pointer}
.ch-chip-btn:hover{background:rgba(120,140,255,.3)}
.ch-chip-off{opacity:.38;text-decoration:line-through}
.ch-notice{border-radius:10px;padding:9px 12px;font-size:12.5px;background:rgba(120,140,255,.09);margin-bottom:8px}
.ch-notice-ok{background:rgba(49,181,115,.12)}
.ch-notice-warn{background:rgba(255,180,80,.12);border:1px solid rgba(255,180,80,.25)}
.ch-risk{margin-top:10px;font-size:11.5px;opacity:.5;line-height:1.5}
.ch-cards-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
.ch-onb{background:linear-gradient(135deg,rgba(75,123,255,.14),rgba(157,92,255,.1));border:1px solid rgba(120,140,255,.3);border-radius:14px;padding:14px 16px}
.ch-onb-title{font-weight:600;margin-bottom:8px}
.ch-onb-step{display:flex;gap:8px;align-items:baseline;margin:5px 0;font-size:12.5px}
.ch-onb-num{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;border-radius:50%;background:rgba(120,140,255,.3);font-size:11px;flex:none;text-align:center;padding:0 4px;box-sizing:border-box}
.ch-onb-actions{display:flex;gap:8px;margin-top:10px}
.ch-recipe{background:rgba(0,0,0,.3);border-radius:10px;padding:10px 12px;font-family:ui-monospace,monospace;font-size:12px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:0 0 8px}
.ch-kv{display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap}
.ch-kv-label{opacity:.55;font-size:12px;min-width:60px}
.ch-muted{opacity:.55;font-size:12px}
.ch-error{color:#ff8f8f}
.ch-credit{font-family:ui-monospace,monospace;font-size:12px;color:#7ee2a8}
.ch-link{border:0;background:transparent;color:#7aa3ff;cursor:pointer;font-size:12px;padding:0}
.ch-link:hover{text-decoration:underline}
.ch-import{margin:10px 0;border-top:1px dashed rgba(128,140,170,.2);padding-top:10px}
.ch-waiting{font-size:12px;opacity:.8;animation:ch-pulse 1.4s ease-in-out infinite}
@keyframes ch-pulse{50%{opacity:.35}}
.ch-toast{position:fixed;right:18px;bottom:18px;background:rgba(30,34,48,.95);border:1px solid rgba(120,140,255,.35);border-radius:10px;padding:9px 15px;font-size:12.5px;z-index:99;max-width:380px}
.ch-toast-warn{border-color:rgba(255,180,80,.4)}
.ch-logs{max-height:340px;overflow:auto;display:flex;flex-direction:column;gap:2px;font-family:ui-monospace,monospace;font-size:12px}
.ch-log{padding:3px 2px;display:flex;gap:10px}
.ch-log-warn{color:#ffcc80}
.ch-log-error{color:#ff8f8f}
.ch-log-time{opacity:.45;flex:none}
@media (prefers-reduced-motion: reduce){.ch-waiting{animation:none}}
`

    // ── slot 注册 ──────────────────────────────────────────────────────────────
    const apply = ctx => {
      window.__chApplyCount = (window.__chApplyCount ?? 0) + 1
      try {
        ctx.slots.inject('settings.section', () => {
          const reg = ctx.slots.register({
            name: 'settings.section',
            id: 'credit-hub',
            order: 36,
            label: () => t('nav'),
            locale: NS,
          }, () => h(SettingsPage, { ctx }))
          window.__chRegResult = String(reg).slice(0, 200)
          return reg
        })
      } catch (error) {
        window.__chApplyError = String(error?.stack ?? error).slice(0, 1200)
        throw error
      }
    }

    /** 测试钩子：渲染冒烟直接渲染各 tab 页面（不影响产品路径）。 */
    const testSettings = { enabled: true, gatewayEnabled: true, accountPack: 'on', autoCheckin: false, onboardingSeen: true, gatewayPort: 8330 }
    const __renderTest = {
      createElement: () => h(SettingsPage, {}),
      pages: {
        overview: () => h(Overview, { settings: testSettings, onSettings: () => {}, goTab: () => {} }),
        channels: () => h(ChannelsPage, {}),
        upstreams: () => h(UpstreamsPage),
        combos: () => h(CombosPage),
        gateway: () => h(GatewayPage, { settings: testSettings, onSettings: () => {} }),
        logs: () => h(LogsPage),
      },
    }

    return { apply, inject: ['slots', 'locale'], name: 'credit-hub', __renderTest }
  },
})
