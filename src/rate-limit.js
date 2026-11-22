/**
 * 网关限流与异常调用告警（优先级六）。
 *
 * - TokenBucket：按客户端标识（回环 IP / 端口对）限速。网关只绑回环，正常
 *   场景不会触发；防的是失控 agent 死循环重试把上游积分打爆，以及本机
 *   其它用户的进程狂打。容量 refills 时按时间线性恢复。
 * - FailureCounter：鉴权连续失败计数（10/50 次时告警日志），成功后清零。
 *
 * 两者都是内存态，进程重启复位——限流是运行时保护，不是持久策略。
 *
 * @module src/rate-limit.js
 */

/** 令牌桶：capacity 个初始令牌，每 msPerToken 毫秒回填 1 个。 */
export function createTokenBucket({ capacity = 120, msPerToken = 500, now = Date.now } = {}) {
  /** key → { tokens, lastRefillAt } */
  const buckets = new Map()

  function take(key) {
    const t = now()
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = { tokens: capacity, lastRefillAt: t }
      buckets.set(key, bucket)
    }
    // 按流逝时间回填
    const elapsed = t - bucket.lastRefillAt
    if (elapsed > 0 && msPerToken > 0) {
      const refill = Math.floor(elapsed / msPerToken)
      if (refill > 0) {
        bucket.tokens = Math.min(capacity, bucket.tokens + refill)
        bucket.lastRefillAt = bucket.lastRefillAt + refill * msPerToken
      }
    }
    if (bucket.tokens <= 0) {
      const deficitMs = Math.ceil((1 - bucket.tokens) * msPerToken)
      return { ok: false, retryAfterMs: Math.max(250, deficitMs) }
    }
    bucket.tokens -= 1
    return { ok: true }
  }

  /** 管理面/诊断视图：当前各 key 的余量。 */
  function snapshot() {
    const t = now()
    const out = {}
    for (const [key, bucket] of buckets.entries()) {
      const elapsed = Math.max(0, t - bucket.lastRefillAt)
      out[key] = {
        tokens: Math.min(capacity, bucket.tokens + (msPerToken > 0 ? Math.floor(elapsed / msPerToken) : 0)),
        capacity,
      }
    }
    return out
  }

  return { take, snapshot }
}

/** 鉴权连续失败计数：成功后清零；达到告警阈值时由调用方读 count 决定日志。 */
export function createFailureCounter({ maxTracked = 256, now = Date.now } = {}) {
  /** key → { count, firstAt, lastAt } */
  const counters = new Map()

  function record(key) {
    const t = now()
    let row = counters.get(key)
    if (row === undefined) {
      // 防膨胀：超过 maxTracked 个 key 时清掉最旧的
      if (counters.size >= maxTracked) {
        const oldest = [...counters.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0]
        if (oldest) counters.delete(oldest[0])
      }
      row = { count: 0, firstAt: t, lastAt: t }
      counters.set(key, row)
    }
    row.count += 1
    row.lastAt = t
    return row.count
  }

  function count(key) {
    return counters.get(key)?.count ?? 0
  }

  function clear(key) {
    counters.delete(key)
  }

  return { record, count, clear }
}
