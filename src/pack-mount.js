/**
 * Vendored account-pack 挂载。
 *
 * `vendor/channel-pack/` 是上游 MIT 渠道实现（Jet/iJetLi，见 NOTICE）的再分发，
 * 提供 Raccoon(商汤小浣熊)、Qoder、Qoder CN、ZCode、MiniMax、TRAE、Cline、
 * Loomy、LobsterAI、Gemini 十个账号渠道的登录、账号池与积分领取。
 *
 * 挂载策略（settings.accountPack）：`on` 强制挂、`off` 不挂、`auto`（默认）
 * 在检测到本机已安装 dsh-our-free-model（其自身挂载同源渠道包）时跳过，
 * 避免双份渠道重复注册与双重签到。状态目录隔离到本插件数据目录，
 * 与 ofm 的 channel-pack 状态互不覆盖。
 *
 * @module src/pack-mount.js
 */

import fs from 'node:fs'
import path from 'node:path'

export const OFM_MARKER = home => path.join(home, 'our-free-model', 'catalog.json')

export const ofmPresent = home => {
  try { return fs.existsSync(OFM_MARKER(home)) } catch { return false }
}

/**
 * 挂载模式（settings.accountPack）：
 *  - `auto`（默认）：检测到 ofm 已挂载同源渠道包时避让——两个渠道包在同一进程
 *    双挂载会撞路由/RPC/网关端口（8326 的 EADDRINUSE 是异步 error 事件，
 *    ofm 的 .catch 接不住，未处理异常直接带崩 host），绝不能共存。
 *  - `on`：独立反代。**前提是 ofm 已停用**——设置页提供模式选择与迁移指引。
 *  - `off`：不挂载。
 */
export function shouldMountAccountPack(settings, home) {
  const mode = settings().accountPack ?? 'auto'
  if (mode === 'off') return { mount: false, reason: 'off' }
  // 保命闸：只要 ofm 还在（数据标记存在），任何模式都不允许第二个渠道包
  // 挂载——双挂载 = 网关端口/路由/RPC 冲突 = host 崩溃。
  if (ofmPresent(home)) return { mount: false, reason: mode === 'on' ? 'ofm-installed' : 'ofm-present' }
  if (mode === 'on') return { mount: true, reason: 'forced' }
  return { mount: true, reason: 'auto' }
}

export async function mountAccountPack(ctx, { settings, stores, logger, warn }) {
  const verdict = shouldMountAccountPack(settings ?? (() => stores.settings.load()), stores.home)
  if (verdict.mount === false) {
    logger?.info?.(`credit-hub: account pack 未挂载（${verdict.reason}）`)
    return { mounted: false, reason: verdict.reason }
  }
  // 状态目录对整个进程固定（不再恢复旧值）：pack 内部可能懒读取该变量，
  // 进程里只有本插件挂载渠道包，固定指向本插件数据目录没有副作用。
  process.env.DSH_CHANNEL_PACK_STATE_DIR = path.join(stores.dir, 'channel-pack')
  try {
    const pack = await import('../vendor/channel-pack/pack.js')
    pack.apply(ctx, { disableOpencode: true })
    logger?.info?.('credit-hub: account pack 已挂载（Raccoon/Qoder/ZCode/MiniMax/TRAE/…）')
    return { mounted: true, reason: verdict.reason }
  } catch (error) {
    warn?.(`credit-hub: account pack 挂载失败（${error?.message ?? error}）`)
    return { mounted: false, reason: 'failed', error: String(error?.message ?? error) }
  }
}

/** Read-only view of the mounted pack's state file, for the dashboard. */
export function packStateView(stores) {
  const file = path.join(stores.dir, 'channel-pack', 'state.json')
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
