/**
 * 降级链成员健康度（熔断器）——确定性可测。
 *
 * 语义（清单：可靠性闭环）：
 *   - 连续失败 ≥ threshold → 熔断（Open），链路遍历时跳过该成员；
 *   - 冷却期满 → 半开（Half-Open）：只放行一次真实请求试探（并发安全：
 *     canTry 是同步判断，第二个并发调用看到 halfOpen=true 只拿到剩余时间）；
 *   - 试探成功 → 关闭（Closed）并清零；试探失败 → 冷却翻倍重新 Open；
 *   - 429 的 Retry-After 覆盖冷却时长：取 max(baseCooldownMs, retryAfterMs)，
 *     只延长不缩短，封顶 maxCooldownMs；
 *   - 取消（CODE.aborted → retryable=false）由调用方过滤，不进入本模块。
 *
 * 时钟可注入（now 参数）：单元测试推进虚拟时间，零真实等待。
 * 状态为内存态，进程重启复位是特性——不把一次抖动永久写进配置。
 *
 * @module src/breaker.js
 */

export function createBreaker({
  threshold = 3,             // 连续失败多少次后熔断
  baseCooldownMs = 30_000,   // 首次冷却时长
  maxCooldownMs = 600_000,   // 指数退避封顶
  now = Date.now,            // 可注入时钟
} = {}) {
  /** key → 熔断行 */
  const state = new Map()

  const rowOf = id => {
    let row = state.get(id)
    if (!row) {
      row = {
        fails: 0,             // 连续失败计数（成功清零）
        successes: 0,         // 累计成功
        failures: 0,          // 累计失败
        probes: 0,            // 半开探测次数
        openUntil: 0,         // 冷却截止时刻
        openLevel: 0,         // 指数退避档位
        halfOpen: false,      // 是否已放行试探
        lastError: undefined,
        lastCategory: undefined, // 最近失败分类（统一错误模型）
        lastFailedAt: 0,
        lastRecoveredAt: 0,   // 最近恢复时刻
      }
      state.set(id, row)
    }
    return row
  }

  /**
   * 链路选成员时调用。返回 null = 可用；返回数字 = 冷却中（剩余 ms，调用方跳过）。
   * 冷却期内一律拒绝；冷却期满（remaining<=0 时不会走到这）——正确语义：
   * openUntil 过期后由「下一次调用」放行一个试探并立即锁住，防止并发多探。
   * 实现：把过期检测放在 remaining<=0 之外单独判断——过期瞬间 halfOpen=false
   * 时放行；已放行（halfOpen=true）且未收到探测结果时继续拒绝。
   */
  function canTry(id) {
    const row = rowOf(id)
    const t = now()
    if (row.openUntil <= 0) return null          // 从未熔断或已恢复
    const remaining = row.openUntil - t
    if (remaining > 0) return remaining          // 冷却中：跳过
    // 冷却期满 → 半开：只放行一个探测
    if (row.halfOpen) return 0                   // 已有探测在途：继续跳过
    row.halfOpen = true
    row.probes += 1
    return null
  }

  /**
   * 候选失败时记录。返回本次触发（或延续）的冷却时长，0 = 未熔断。
   * retryAfterMs（来自上游 Retry-After）存在时覆盖指数退避：max(base, retryAfter)。
   */
  function recordFailure(id, message, { category, retryAfterMs } = {}) {
    const row = rowOf(id)
    const t = now()
    row.fails += 1
    row.failures += 1
    row.lastError = String(message ?? '').slice(0, 200)
    if (typeof category === 'string') row.lastCategory = category
    row.lastFailedAt = t
    if (row.fails < threshold) return 0
    // 档位判定：冷却未过期（连续失败堆积）或半开探测失败（证明尚未恢复）
    // 都算「延续上一轮」→ 档位递增；全新一轮故障（恢复后再次熔断）从 base 开始。
    const stillOpen = row.openUntil > t || row.halfOpen === true
    const level = stillOpen ? Math.min(row.openLevel + 1, 6) : 0
    row.openLevel = level
    const cooldown = Math.min(
      Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.max(baseCooldownMs, retryAfterMs)
        : baseCooldownMs * 2 ** level,
      maxCooldownMs,
    )
    row.openUntil = t + cooldown
    row.halfOpen = false
    return cooldown
  }

  /** commit（真实吐内容）或请求正常结算 → 视为恢复，清零并记录恢复时刻。 */
  function recordSuccess(id) {
    const row = rowOf(id)
    row.fails = 0
    row.successes += 1
    row.openUntil = 0
    row.halfOpen = false
    row.openLevel = 0
    row.lastError = undefined
    row.lastRecoveredAt = now()
  }

  /** 手动重置（管理面单独暴露，避免误操作影响在线流量）。ids 省略 = 全部。 */
  function reset(ids) {
    const targets = Array.isArray(ids) && ids.length > 0 ? ids : [...state.keys()]
    for (const id of targets) {
      const row = state.get(id)
      if (!row) continue
      row.fails = 0
      row.openUntil = 0
      row.halfOpen = false
      row.openLevel = 0
      row.lastError = undefined
    }
  }

  /** 管理面 / 调试视图：全部字段来自注入时钟，确定性可断言。 */
  function snapshot() {
    const t = now()
    const out = {}
    for (const [id, row] of state.entries()) {
      const remaining = row.openUntil - t
      const cooling = row.openUntil > 0
      out[id] = {
        state: !cooling || remaining <= 0 ? (row.halfOpen ? 'half-open' : 'closed') : 'open',
        consecutiveFails: row.fails,
        successes: row.successes,
        failures: row.failures,
        probes: row.probes,
        ...(remaining > 0 ? { cooldownRemainingMs: remaining } : {}),
        ...(row.openLevel > 0 ? { cooldownLevel: row.openLevel } : {}),
        ...(row.lastCategory ? { lastCategory: row.lastCategory } : {}),
        ...(row.lastError ? { lastError: row.lastError } : {}),
        ...(row.lastFailedAt ? { lastFailedAt: row.lastFailedAt } : {}),
        ...(row.lastRecoveredAt ? { lastRecoveredAt: row.lastRecoveredAt } : {}),
      }
    }
    return out
  }

  return { canTry, recordFailure, recordSuccess, reset, snapshot }
}
