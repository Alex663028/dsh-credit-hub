/**
 * Small shared helpers.
 *
 * @module src/util.js
 */

import crypto from 'node:crypto'

/** Prefixed random id, e.g. `toolu_x1I9…` — shape-compatible with both wires. */
export function mintId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`
}

/** Normalized `now` for records: integer epoch ms. */
export const now = () => Date.now()

/** Clamp helper for budgets and timeouts. */
export function clamp(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return min
  return Math.min(Math.max(Math.trunc(value), min), max)
}

/** Ring buffer for logs, bounded in memory. */
export function createRing(limit = 500) {
  const rows = []
  return {
    push(row) {
      rows.push(row)
      if (rows.length > limit) rows.splice(0, rows.length - limit)
    },
    list() { return [...rows] },
    clear() { rows.length = 0 },
  }
}

/**
 * 宿主对 reasoning 元数据校验极严（一档重复/非法 → 整条 provider 拒载），
 * 所有渠道上来的档位表都必须过这道闸：白名单 + 去重 + default 必须在集合内。
 * 消毒后为空 → 返回 undefined（调用方整个不发 reasoning 元数据）。
 */
export const VALID_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function sanitizeEfforts(raw, defaultRaw) {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set()
  const efforts = []
  for (const item of raw) {
    const value = typeof item === 'string' ? item.trim().toLowerCase() : ''
    if (!VALID_EFFORTS.includes(value) || seen.has(value)) continue
    seen.add(value)
    efforts.push(value)
  }
  if (efforts.length === 0) return undefined
  const fallback = typeof defaultRaw === 'string' ? defaultRaw.trim().toLowerCase() : ''
  const defaultEffort = seen.has(fallback) ? fallback : efforts[efforts.length - 1]
  return { efforts, defaultEffort }
}

/** 有限正整数兜底（上下文窗口 / 输出上限这类元数据字段）。 */
export function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
