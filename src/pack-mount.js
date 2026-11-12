/**
 * Vendored account-pack 挂载。
 *
 * `vendor/channel-pack/` 是上游 MIT 渠道实现（Jet/iJetLi，见 NOTICE）的再分发，
 * 提供 Raccoon(商汤小浣熊)、Qoder、Qoder CN、ZCode、MiniMax、TRAE、Cline、
 * Loomy、LobsterAI、Gemini 十个账号渠道的登录、账号池与积分领取。
 *
 * 双挂载防护（settings.accountPack + 进程内标记）：`off` 不挂；`auto` 检测到
 * ofm 已挂载同源渠道包时避让；`on` 强制挂，但仍受进程内标记约束 —— 同一
 * 进程重复 apply（热重载 / remove→install）绝不能挂第二份。
 *
 * ⚠️ 状态目录：pack 内部把 `DSH_CHANNEL_PACK_STATE_DIR` 当 home，再自己拼
 * `channel-pack/state.json`，所以 env 指向 `{dataDir}/channel-pack` 时实际文件在
 * `{dataDir}/channel-pack/channel-pack/state.json`。这里不迁移既有数据，改为
 * **读写都同时兼容两层路径**（见 packStateFiles / packStateFile）。
 *
 * @module src/pack-mount.js
 */

import fs from 'node:fs'
import path from 'node:path'

/** 跨 HMR / 重复 apply 的进程级标记（模块被重新求值也仍然有效）。 */
const MOUNT_FLAG = Symbol.for('dsh.channel-pack.mounted')

export const OFM_MARKER = home => path.join(home, 'our-free-model', 'catalog.json')

export const ofmPresent = home => {
  try { return fs.existsSync(OFM_MARKER(home)) } catch { return false }
}

/** 进程内是否已有渠道包（本插件或 ofm 挂载）。 */
export const packMountedInProcess = () => globalThis[MOUNT_FLAG] === true
const markMounted = () => { globalThis[MOUNT_FLAG] = true }
const unmarkMounted = () => { delete globalThis[MOUNT_FLAG] }

/** pack 状态文件的两个可能位置：新版 / 旧版（双层嵌套）。 */
export const packStateFiles = stores => [
  path.join(stores.dir, 'channel-pack', 'state.json'),
  path.join(stores.dir, 'channel-pack', 'channel-pack', 'state.json'),
]

/** 第一个真实存在的状态文件；都不存在时返回首选路径供诊断展示。 */
export function packStateFile(stores) {
  const files = packStateFiles(stores)
  for (const file of files) {
    try { if (fs.existsSync(file)) return file } catch {}
  }
  return files[0]
}

/**
 * 挂载模式（settings.accountPack）：
 *  - `off`：不挂。
 *  - `auto`（默认）：ofm 已挂载时避让——两个渠道包在同一进程双挂载会撞
 *    路由/RPC/网关端口（8326 的 EADDRINUSE 是异步 error 事件，未处理会带崩 host）。
 *  - `on`：强制挂，但进程内已有渠道包时仍然跳过（保命闸不再只依赖磁盘标记）。
 */
export function shouldMountAccountPack(settings, home) {
  const mode = settings().accountPack ?? 'auto'
  if (mode === 'off') return { mount: false, reason: 'off' }
  if (packMountedInProcess()) return { mount: false, reason: 'already-mounted-in-process' }
  if (ofmPresent(home)) return { mount: false, reason: mode === 'on' ? 'ofm-installed' : 'ofm-present' }
  if (mode === 'on') return { mount: true, reason: 'forced' }
  return { mount: true, reason: 'auto' }
}

/**
 * 挂载渠道包，返回 `{ mounted, reason, dispose }`。
 * `dispose` **始终是可调用函数**：无论 pack.apply 是否返回 disposer，都要能
 * 撤掉进程内标记；调用方（index.js 的 ctx.effect 清理）必须调用它。
 */
export async function mountAccountPack(ctx, { settings, stores, logger, warn }) {
  const verdict = shouldMountAccountPack(settings ?? (() => stores.settings.load()), stores.home)
  if (verdict.mount === false) {
    logger?.info?.(`credit-hub: account pack 未挂载（${verdict.reason}）`)
    return { mounted: false, reason: verdict.reason, dispose: () => {} }
  }
  // 状态目录对整个进程固定（pack 可能懒读 env）；路径形状保持旧版，避免既有
  // 账号/积分数据因升级而"消失"。读取统一走 packStateFile。
  process.env.DSH_CHANNEL_PACK_STATE_DIR = path.join(stores.dir, 'channel-pack')
  let pack
  let disposer = null
  try {
    pack = await import('../vendor/channel-pack/pack.js')
    // 必须 await：pack.apply 内部若是 async，未 await 的 rejection 会逃逸成
    // unhandledRejection，直接带崩 DSH host（11-08 十次 exited with 1 的形态）。
    // OpenCode 是匿名免费车道（apiKey 字面量 public）：默认开启；settings.opencode
    // 显式为 false 时禁用——那样 pack 不注册 opencode LLM 适配器，也不开放其账号 RPC。
    const readSettings = settings ?? (() => stores.settings.load())
    const result = await pack.apply(ctx, { disableOpencode: readSettings().opencode === false })
    if (typeof result === 'function') disposer = result
    else if (result && typeof result.dispose === 'function') disposer = () => result.dispose()
    markMounted()
    logger?.info?.('credit-hub: account pack 已挂载（Raccoon/Qoder/ZCode/MiniMax/TRAE/…）')
    return {
      mounted: true,
      reason: verdict.reason,
      dispose: () => {
        try { disposer?.() } catch {}
        try { pack?.unapply?.(ctx) } catch {}
        unmarkMounted()
      },
    }
  } catch (error) {
    warn?.(`credit-hub: account pack 挂载失败（${error?.message ?? error}）`)
    unmarkMounted()
    return { mounted: false, reason: 'failed', error: String(error?.message ?? error), dispose: () => {} }
  }
}

/** Read-only view of the mounted pack's state file, for the dashboard. */
export function packStateView(stores) {
  const file = packStateFile(stores)
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    const accounts = state?.accounts ?? {}
    return Object.entries(accounts).slice(0, 50).map(([id, row]) => ({
      id,
      provider: row?.provider ?? String(id).split(':')[0] ?? 'unknown',
      label: row?.label ?? row?.nickname ?? id,
      credits: row?.credits,
      disabled: row?.disabled === true,
    }))
  } catch {
    return []
  }
}
