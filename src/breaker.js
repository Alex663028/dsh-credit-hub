/**
 * 降级链成员健康度（清单 #6：冷却与熔断）。
 *
 * 内存态，不落盘 —— 进程重启即复位（保守起点），避免把「一次抖动」永久
 * 写进配置。熔断语义：
 *   - 连续失败 ≥ breaker.threshold → 该成员进入冷却（Open），链路遍历时跳过；
 *   - 冷却期满 → 半开（Half-Open）：放行一次真实请求试探；
 *   - 试探成功 → 关闭（Closed）并清零计数；失败 → 冷却时间翻倍重新 Open。
 *
 * 「成功」的判定权在调用方：commit（开始给客户端吐内容）即视为成功，
 * 因为 commit 之前的失败全部会走 advance 换跳。
 *
 * @module src/breaker.js
 */

export function createBreaker({
  threshold = 3,        // 连续失败多少次后熔断
  baseCooldownMs = 30_000,   // 首次冷却时长
  maxCooldownMs = 10 * 60_000, // 冷却上限（指数退避封顶）
} = {}) {
  /** modelId → { fails, openUntil, lastError, halfOpen } */
  const state = new Map()

  const rowOf = id => {
    let row = state.get(id)
    if (!row) {
      row = { fails: 0, openUntil: 0, lastError: undefined, halfOpen: false, lastSkippedAt: 0 }
      state.set(id, row)
    }
    return row
  }

  /**
   * 链路选成员时调用。返回 null = 可用；返回数字 = 该成员还在冷却（剩余 ms）。
   * 半开期放行一次（halfOpen=true），同一次冷却期内只放一个请求试探。
   */
  function canTry(id) {
    const row = rowOf(id)
    const remaining = row.openUntil - Date.now()
    if (remaining <= 0) return null
    if (row.halfOpen) return remaining
    row.halfOpen = true
    return null
  }

  /** 候选被跳过（commit 前失败）时记录；返回该成员本次的冷却时长（0 = 未熔断）。 */
  function recordFailure(id, message) {
    const row = rowOf(id)
    row.fails += 1
    row.lastError = String(message ?? '').slice(0, 200)
    row.lastSkippedAt = Date.now()
    if (row.fails < threshold) return 0
    // 熔断：冷却 = base × 2^(已熔断次数-1)，封顶 maxCooldown
    const opened = row.openUntil > 0
    const level = opened ? Math.min(row.openLevel + 1, 6) : 0
    row.openLevel = level
    const cooldown = Math.min(baseCooldownMs * 2 ** level, maxCooldownMs)
    row.openUntil = Date.now() + cooldown
    row.halfOpen = false
    return cooldown
  }

  /** commit（真实吐内容）或请求正常结算 → 视为恢复，清零。 */
  function recordSuccess(id) {
    const row = rowOf(id)
    row.fails = 0
    row.openUntil = 0
    row.halfOpen = false
    row.openLevel = 0
    row.lastError = undefined
  }

  /** 管理面 / 调试视图。 */
  function snapshot() {
    const out = {}
    for (const [id, row] of state.entries()) {
      const remaining = row.openUntil - Date.now()
      out[id] = {
        fails: row.fails,
        state: remaining > 0 ? (row.halfOpen ? 'half-open' : 'open') : 'closed',
        ...(remaining > 0 ? { cooldownRemainingMs: remaining } : {}),
        ...(row.openLevel > 0 ? { cooldownLevel: row.openLevel } : {}),
        ...(row.lastError ? { lastError: row.lastError } : {}),
      }
    }
    return out
  }

  return { canTry, recordFailure, recordSuccess, snapshot }
}
