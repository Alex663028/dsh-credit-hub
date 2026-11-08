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
const React = {
  createElement(type, props, ...children) {
    return { __el: true, type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect() {},
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

console.log(failures === 0 ? '\nRENDER SMOKE PASS' : `\n${failures} FAILURES`)
process.exitCode = failures === 0 ? 0 : 1
