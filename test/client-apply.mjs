/**
 * 客户端半身 apply() 注册契约测试。
 *
 * 背景：client.js 的 mount() 用 try/catch 吞掉槽位注册失败——好处是一个槽位
 * 挂不上不连累其它，坏处是「设置里找不到积分汇通」在现场完全无声。本测试
 * 用真实 API 形状的 mock ctx 调用 apply()，把失败暴露在 CI 里。
 *
 * 官方基准（dsh-client-ui-plugin-market 的 client.js）：
 *   ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id, label }, Component))
 *
 * @module test/client-apply.mjs
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')
const source = fs.readFileSync(clientPath, 'utf8')

let failures = 0
const test = (name, fn) => {
  try { fn(); console.log(`ok   ${name}`) } catch (error) { failures += 1; console.log(`FAIL ${name}: ${error.message}`) }
}

/** 从 IIFE 里取出 factory：真实浏览器里由 ModuleLoader 执行 factory(require)。 */
function factoryOf() {
  // client.js 形如；(function registerCreditHubClient(){ ... window.__ModuleLoader__.load({ id, factory }) })()
  // 在 Node 里复刻最小 require：react 用桩替代，其余抛错（我们的模块只依赖 react）。
  const captured = {}
  const window = {
    __ModuleLoader__: { load: descriptor => { captured.descriptor = descriptor } },
  }
  const doc = {
    createElement: () => ({ style: {} }),
    head: { appendChild: () => {} },
    querySelector: () => null,
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const sandboxConsole = { warn: () => {}, error: () => {}, log: () => {} }
  const stubReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
    useRef: value => ({ current: value }),
    useMemo: fn => fn(),
    Fragment: 'Fragment',
  }
  const requireStub = id => {
    if (id === 'react') return stubReact
    throw new Error(`unexpected require: ${id}`)
  }
  // 用 Function 构造隔离作用域：注入 window/document/require/console
  const runner = new Function('window', 'document', 'require', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', source)
  runner(window, doc, requireStub, sandboxConsole, setTimeout, clearTimeout, setInterval, clearInterval)
  return captured.descriptor
}

test('client.js registers a descriptor with id and factory', () => {
  const descriptor = factoryOf()
  assert.ok(descriptor, 'window.__ModuleLoader__.load 被调用（bundle 自注册）')
  assert.equal(descriptor.id, 'dsh-credit-hub', 'descriptor.id 必须是包名')
  assert.equal(typeof descriptor.factory, 'function', 'descriptor.factory 必须是函数')
})

test('factory exposes apply + inject (official contract shape)', () => {
  const descriptor = factoryOf()
  const mod = descriptor.factory(id => {
    if (id === 'react') {
      return {
        createElement: (t, p, ...c) => ({ t, p, c }),
        useState: v => [typeof v === 'function' ? v() : v, () => {}],
        useEffect: () => {}, useCallback: f => f, useRef: v => ({ current: v }), useMemo: f => f(),
        Fragment: 'Fragment',
      }
    }
    throw new Error(`unexpected require: ${id}`)
  })
  assert.equal(typeof mod.apply, 'function', 'exports.apply')
  assert.ok(Array.isArray(mod.inject), 'exports.inject 是数组')
  assert.ok(mod.inject.includes('slots'), 'inject 必须含 slots')
  assert.ok(mod.inject.includes('locale'), 'inject 必须含 locale')
})

test('apply() registers settings.section without throwing (the "missing from Settings" guard)', () => {
  const descriptor = factoryOf()
  const mod = descriptor.factory(id => {
    if (id === 'react') {
      return {
        createElement: (t, p, ...c) => ({ t, p, c }),
        useState: v => [typeof v === 'function' ? v() : v, () => {}],
        useEffect: () => {}, useCallback: f => f, useRef: v => ({ current: v }), useMemo: f => f(),
        Fragment: 'Fragment',
      }
    }
    throw new Error(`unexpected require: ${id}`)
  })

  const registrations = []
  const warnings = []
  const slots = {
    inject(slot, factory) {
      // 官方语义：inject 立即执行 factory 完成注册
      const dispose = factory()
      registrations.push({ slot, dispose })
      return dispose
    },
    register(spec, component) {
      if (typeof spec?.name !== 'string') throw new Error('register: name required')
      if (typeof component !== 'function') throw new Error(`register(${spec.name}): component must be a function`)
      return () => {}
    },
  }
  const ctx = {
    slots,
    effect: () => {},
    on: () => {},
    locale: {
      register: () => {},
      resolveText: text => (typeof text === 'string' ? text : (text?.zh ?? text?.en ?? '')),
      bind: () => key => key,
    },
    get: () => undefined,
    inject: () => {},
  }
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  try {
    mod.apply(ctx)
  } finally {
    console.warn = originalWarn
  }

  // 关键断言：不能有槽位挂载警告（有即说明「设置里看不到」）
  const mountFailures = warnings.filter(line => line.includes('槽位') && line.includes('挂载失败'))
  assert.equal(mountFailures.length, 0, `槽位挂载警告: ${mountFailures.join(' | ')}`)
  assert.ok(registrations.length >= 1, 'apply() 至少注册一个槽位')
  assert.ok(
    registrations.some(row => row.slot === 'settings.section'),
    `必须注册 settings.section（实际: ${registrations.map(r => r.slot).join(', ')}）`,
  )
})

test('apply() is idempotent — second call does not re-register', () => {
  const descriptor = factoryOf()
  const mod = descriptor.factory(id => {
    if (id === 'react') {
      return {
        createElement: (t, p, ...c) => ({ t, p, c }),
        useState: v => [typeof v === 'function' ? v() : v, () => {}],
        useEffect: () => {}, useCallback: f => f, useRef: v => ({ current: v }), useMemo: f => f(),
        Fragment: 'Fragment',
      }
    }
    throw new Error(`unexpected require: ${id}`)
  })
  let count = 0
  const ctx = {
    slots: {
      inject: (slot) => { count += 1; return () => {} },
      register: () => () => {},
    },
    effect: () => {}, on: () => {},
    locale: { register: () => {}, resolveText: t => t, bind: () => k => k },
  }
  mod.apply(ctx)
  const afterFirst = count
  mod.apply(ctx)
  assert.equal(count, afterFirst, 'repeat apply() must not register again')
})

console.log(failures === 0 ? '\nCLIENT APPLY PASS' : `\n${failures} CLIENT APPLY FAILURES`)
process.exit(failures === 0 ? 0 : 1)