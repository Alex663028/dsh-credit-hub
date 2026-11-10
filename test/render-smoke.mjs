/**
 * 浏览器半身渲染冒烟：`node test/render-smoke.mjs`。
 *
 * 宿主里「槽位注册成功但组件渲染抛错 → 整个槽位条目变空白」是最难查的一类
 * 故障（控制台只有 `slot entry crashed in '<slot>'`，页面本身一片空白）。
 * 这里用最小 React 桩把 client.js 的每个页面组件真正执行一遍：
 *
 *  - 钩子返回初值（useState 返回 initial、useEffect 空转），足以暴露
 *    渲染期求值错误（undefined.length、缺 i18n key、错误 props 形状…）；
 *  - 递归执行函数组件，报告「哪个页面、哪个组件、什么错误」；
 *  - 同时校验 apply() 的槽位注册参数只含该槽位声明的合法键。
 *
 * 这是纯 Node、无浏览器的快速体检，不替代真实页面的视觉确认。
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')

let failures = 0
const fail = message => { failures += 1; console.log(`FAIL ${message}`) }
const ok = name => console.log(`ok   ${name}`)

// ── React 桩 ────────────────────────────────────────────────────────────────
// 可开关的真实 effect 桩：默认 realEffects=false 时 useEffect 空转，保持既有
// 渲染用例的行为；打开后真正执行 effect 并收集 cleanup，由下面的覆盖用例在
// 「卸载」时统一调用（否则 effect 里的 setInterval 会让进程无法退出）。
let realEffects = false
let effectRuns = 0
let cleanupRuns = 0
const pendingCleanups = []
const React = {
  createElement(type, props, ...children) {
    return { __el: true, type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect(fn) {
    if (!realEffects) return
    effectRuns += 1
    const cleanup = fn()
    if (typeof cleanup === 'function') pendingCleanups.push(cleanup)
  },
  useCallback(fn) { return fn },
  useRef(value) { return { current: value } },
}

// ── 宿主环境桩 ──────────────────────────────────────────────────────────────
let captured = null
globalThis.window = {
  __ModuleLoader__: { load: descriptor => { captured = descriptor } },
  addEventListener() {},
  removeEventListener() {},
  open() { return null },
  confirm() { return true },
  matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} } },
  location: { href: 'http://127.0.0.1:8330/' },
}
// Node 24 自带只读的 globalThis.navigator，必须用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { language: 'zh-CN', clipboard: { writeText: async () => {} } },
})
globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
  createElement() { return { style: {}, setAttribute() {}, appendChild() {} } },
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
}

const requireStub = name => {
  if (name === 'react') return React
  throw new Error(`unexpected require("${name}") in client factory`)
}

await import(pathToFileURL(clientPath).href)
assert(captured !== null, 'client.js 没有调用 window.__ModuleLoader__.load')
assert.equal(captured.id, 'dsh-credit-hub')
ok('client.js 向 ModuleLoader 注册了 factory')

const mod = captured.factory(requireStub)
ok('factory 执行成功')
assert.equal(typeof mod?.apply, 'function', 'factory 没有导出 apply')
assert.deepEqual(mod.inject, ['slots', 'locale'])
ok('导出 apply / inject')

// ── 递归渲染（执行函数组件，捕获渲染期异常） ─────────────────────────────────
function render(node, trail, depth = 0) {
  if (depth > 60) throw new Error(`递归过深（可能是无限自渲染）：${trail}`)
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) { for (const child of node) render(child, trail, depth + 1); return }
  if (typeof node !== 'object') return
  if (node.__el !== true) return
  const { type, props } = node
  if (typeof type === 'function') {
    const name = type.name || 'anonymous'
    let out
    try {
      out = type(props)
    } catch (error) {
      throw new Error(`组件 <${name}> 渲染抛错：${error?.message ?? error}\n      路径：${trail} > ${name}`)
    }
    render(out, `${trail} > ${name}`, depth + 1)
    return
  }
  if (typeof type === 'string') {
    render(props?.children, trail, depth + 1)
    return
  }
  // 片段/符号等：继续渲染 children
  render(props?.children, trail, depth + 1)
}

const testSettings = {
  enabled: true, gatewayEnabled: true, accountPack: 'on', autoCheckin: false,
  onboardingSeen: true, gatewayPort: 8330, packGateway: false, thinkingOffByDefault: false,
}

const pages = {
  settingsPage: () => React.createElement(mod.__renderTest.createElement ? React.Fragment : 'div'),
}

// __renderTest.pages 提供了每个 tab 的页面工厂
const renderTest = mod.__renderTest
assert(renderTest !== undefined, 'factory 未导出 __renderTest 渲染钩子')
ok('导出 __renderTest')

const cases = [
  ['SettingsPage（整页壳）', () => renderTest.createElement()],
  ['总览 Overview', () => renderTest.pages.overview()],
  ['账号渠道 Channels', () => renderTest.pages.channels()],
  ['API 中转 Upstreams', () => renderTest.pages.upstreams()],
  ['降级链 Combos', () => renderTest.pages.combos()],
  ['网关 Gateway', () => renderTest.pages.gateway()],
  ['日志 Logs', () => renderTest.pages.logs()],
]

for (const [label, make] of cases) {
  let tree
  try {
    tree = make()
  } catch (error) {
    fail(`${label}：构造元素就抛错 — ${error?.message ?? error}`)
    continue
  }
  try {
    render(tree, label)
    ok(`${label} 渲染通过`)
  } catch (error) {
    fail(`${label}：${error?.message ?? error}`)
  }
}

// ── 子组件「带数据」渲染：页面首帧空态会 early-return，真正的崩溃只在
//    数据加载后的第二次渲染才出现（渠道页 BridgeModelsCard 就是这种） ────────
const components = renderTest.components ?? {}
const hubModels = [
  { id: 'pk/tokenrhythm/deepseek-v4.1-flash-1017', provider: 'tokenrhythm', modelId: 'deepseek-v4.1-flash-1017', disabled: false, source: 'pack' },
  { id: 'pk/zcode/GLM-5.3', provider: 'zcode', modelId: 'GLM-5.3', disabled: true, source: 'pack' },
  { id: 'wb/cn/glm-5.3-flash', provider: 'workbuddy', modelId: 'glm-5.3-flash', disabled: false, source: 'workbuddy' },
]
const richCases = [
  ['桥接模型卡（有数据）', () => React.createElement(components.BridgeModelsCard ?? (() => null), { hubModels })],
  ['渠道卡（有 10 个渠道 + RPC）', () => React.createElement(
    components.PackChannelCard ?? (() => null),
    { channel: { id: 'qoder', name: 'Qoder', org: '阿里系', accent: '#615CED', offset: 0 }, rpc: async () => ({}), packNote: 'note' },
  )],
  ['渠道卡（RPC 不可用）', () => React.createElement(
    components.PackChannelCard ?? (() => null),
    { channel: { id: 'zcode', name: 'ZCode', org: '智谱', accent: '#3B6EF6' }, rpc: null, packNote: null },
  )],
]
for (const [label, make] of richCases) {
  try {
    render(make(), label)
    ok(`${label} 渲染通过`)
  } catch (error) {
    fail(`${label}：${error?.message ?? error}`)
  }
}

// ── 目录渲染：空态与有数据两种都必须过 ──────────────────────────────────────
for (const [label, hub] of [['空目录'], ['有 3 个模型的目录', hubModels]]) {
  try {
    render(React.createElement(components.BridgeModelsCard ?? (() => null), { hubModels: hub }), label)
    ok(`桥接卡 ${label} 渲染通过`)
  } catch (error) {
    fail(`桥接卡 ${label}：${error?.message ?? error}`)
  }
}

// ── apply() 的槽位注册参数校验 ──────────────────────────────────────────────
const ALLOWED = {
  'settings.section': ['id', 'order', 'label'],
  'plugins.item': ['id', 'order', 'label'],
  'plugins.bundle.config': ['key', 'label'],
}
const registrations = []
const fakeCtx = {
  slots: {
    inject(key, callback) {
      const effect = callback()
      return typeof effect === 'function' ? effect : () => {}
    },
    register(options, component) {
      registrations.push({ slot: options?.name, options, component })
      return () => {}
    },
  },
}

try {
  mod.apply(fakeCtx)
  ok('apply() 执行无异常')
} catch (error) {
  fail(`apply() 抛错：${error?.message ?? error}`)
}

assert(registrations.length > 0, 'apply() 没有注册任何槽位条目')

// apply() 幂等：重复调用不应重复注册槽位
try {
  const before = registrations.length
  mod.apply(fakeCtx)
  if (registrations.length !== before) fail(`重复 apply() 多注册了 ${registrations.length - before} 个槽位条目`)
  else ok('apply() 重复调用不重复注册')
} catch (error) {
  fail(`重复 apply() 抛错：${error?.message ?? error}`)
}

for (const { slot, options, component } of registrations) {
  assert.equal(typeof component, 'function', `${slot} 注册缺组件`)
  const allowed = ALLOWED[slot]
  if (allowed === undefined) { fail(`注册到未预期的槽位 "${slot}"`); continue }
  const extra = Object.keys(options).filter(key => key !== 'name' && !allowed.includes(key))
  if (extra.length > 0) fail(`${slot} 注册含非法选项：${extra.join(', ')}（合法：${allowed.join(', ')}）`)
  else ok(`${slot} 注册选项合法`)
  // 已注册的组件也要能渲染
  try {
    render(component({ view: 'page' }), `${slot} 组件`)
    ok(`${slot} 组件渲染通过`)
  } catch (error) {
    fail(`${slot} 组件：${error?.message ?? error}`)
  }
}

// ── 每个渲染出的组件都必须能被 render 覆盖到的 i18n key 都有定义 ─────────────
const src = fs.readFileSync(clientPath, 'utf8')
const usedKeys = new Set()
for (const match of src.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)) usedKeys.add(match[1])
const missing = []
for (const key of usedKeys) {
  // DICT 里的键有两种写法：`'tab.overview':` 和裸标识符 `nav:`
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const declared = new RegExp(`(?:'${escaped}'|\\b${escaped})\\s*:`).test(src)
  if (!declared) missing.push(key)
}
if (missing.length > 0) fail(`以下 i18n key 在 DICT 中不存在：${missing.join(', ')}`)
else ok(`${usedKeys.size} 个 t() key 全部有定义`)

// ── 连续注入幂等性：宿主重复注入 client.js 不应产生 NS 冲突或重复注册 ──────
// 用 runInThisContext 在「同一个全局词法环境」里真正执行两次源码：修复前
// 顶层 `const NS` 会因重复声明抛 `Identifier 'NS' has already been declared`；
// 修复后 IIFE 隔离作用域 + __DSH_CREDIT_HUB_CLIENT_V1__ 守卫让第二次直接
// return，ModuleLoader.load 只调用一次，宿主因而只执行 factory 一次。
{
  const { runInThisContext } = await import('node:vm')
  const code = fs.readFileSync(clientPath, 'utf8')
  const savedWindow = globalThis.window
  let loadCount = 0
  let factoryCalls = 0
  const errors = []
  const sandboxWindow = {
    __ModuleLoader__: {
      load(descriptor) {
        loadCount += 1
        // 模拟宿主：注册即执行 factory（requireStub 提供 react 桩）
        descriptor.factory(requireStub)
        factoryCalls += 1
      },
    },
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.window = sandboxWindow
  try {
    for (let i = 0; i < 2; i += 1) {
      try { runInThisContext(code, { filename: `client.js#inject${i + 1}` }) }
      catch (error) { errors.push(`第 ${i + 1} 次注入抛错：${error?.message ?? error}`) }
    }
  } finally {
    globalThis.window = savedWindow
  }
  if (errors.length > 0) {
    for (const message of errors) fail(`连续加载两次：${message}`)
  } else {
    ok('连续加载两次 client.js 未抛错（无 NS 重复声明冲突）')
  }
  if (loadCount !== 1) fail(`连续加载两次应只注册 1 次，实际 ${loadCount} 次`)
  else ok('连续加载两次 ModuleLoader.load 只调用 1 次（幂等守卫生效）')
  if (factoryCalls !== 1) fail(`连续加载两次 factory 应只执行 1 次，实际 ${factoryCalls} 次`)
  else ok('连续加载两次 factory 只执行 1 次')
}

// ── 可开关的真实 useEffect：真正执行 effect 并在「卸载」时调用 cleanup ─────
// 默认 realEffects=false 时上面的渲染用例行为不变；这里打开开关，验证组件
// 在 effect 真实执行（会创建定时器 / 发起 REST）后仍不抛错，且所有 cleanup
// 都能被调用（否则 effect 里的 setInterval 会让进程无法退出）。
{
  const savedFetch = globalThis.fetch
  // 让 effect 里的 api() 挂起，避免真实 REST 副作用；setState 由桩空转吞掉
  globalThis.fetch = () => new Promise(() => {})
  const effectErrors = []
  realEffects = true
  try {
    for (const [label, make] of [...cases, ...richCases]) {
      try { render(make(), `${label} / 真实 useEffect`) }
      catch (error) { effectErrors.push(`${label}：${error?.message ?? error}`) }
    }
  } finally {
    // 卸载：逐个执行 effect 返回的 cleanup（clearInterval / clearTimeout…）
    for (const cleanup of pendingCleanups.splice(0)) {
      try { cleanup(); cleanupRuns += 1 } catch (error) { effectErrors.push(`cleanup：${error?.message ?? error}`) }
    }
    realEffects = false
    globalThis.fetch = savedFetch
  }
  for (const message of effectErrors) fail(`真实 useEffect：${message}`)
  if (effectErrors.length === 0 && effectRuns > 0 && cleanupRuns > 0) {
    ok(`真实 useEffect：${effectRuns} 个 effect 执行、${cleanupRuns} 个 cleanup 在卸载时调用，渲染无异常`)
  }
  if (effectRuns === 0) fail('真实 useEffect：打开开关后没有任何 effect 被执行')
  if (cleanupRuns === 0) fail('真实 useEffect：打开开关后没有任何 cleanup 被调用')
}

console.log(failures === 0 ? '\nRENDER SMOKE PASS' : `\n${failures} FAILURES`)
process.exitCode = failures === 0 ? 0 : 1
