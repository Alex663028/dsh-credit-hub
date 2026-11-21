/**
 * 结构化输入校验（清单 #3）。
 *
 * 零依赖的声明式校验器：每条规则是一个 `check(value) → 错误文本 | null` 的字段描述，
 * `validate(body, schema)` 汇总成 400（带逐字段 reason）。API 层把校验错误与
 * 413（body 超限）、401（adminKey）、502（上游错误）明确区分开，不再让
 * 「客户端传错」与「上游出错」共享一个 400。
 *
 * @module src/validate.js
 */

/** 单个字段校验规则。每个 check 返回错误文本或 null（通过）。 */
export const rules = {
  /** 非空字符串，可限长。 */
  string: (label, { max = 4096, optional = false } = {}) => value => {
    if (value === undefined || value === null || value === '') return optional ? null : `${label} 必填`
    if (typeof value !== 'string') return `${label} 必须是字符串`
    if (value.length > max) return `${label} 超过最大长度 ${max}`
    return null
  },
  /** http(s) URL，自动去掉尾部斜杠。 */
  httpUrl: (label, { optional = false } = {}) => value => {
    if (value === undefined || value === null || value === '') return optional ? null : `${label} 必填`
    if (typeof value !== 'string') return `${label} 必须是字符串`
    const trimmed = value.trim()
    if (!/^https?:\/\/.+/i.test(trimmed)) return `${label} 必须是 http(s) 地址`
    try {
      const url = new URL(trimmed)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${label} 必须是 http(s) 地址`
      if (url.username || url.password) return `${label} 不能包含凭据`
      if (url.href.includes('#')) return `${label} 不能包含 #fragment`
      return null
    } catch { return `${label} 不是合法 URL` }
  },
  /** 端口：1024-65535 整数。 */
  port: (label, { optional = true } = {}) => value => {
    if (value === undefined || value === null || value === '') return optional ? null : `${label} 必填`
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1024 || n > 65535) return `${label} 必须是 1024-65535 的整数`
    return null
  },
  /** 枚举。 */
  enum: (label, allowed, { optional = false } = {}) => value => {
    if (value === undefined || value === null || value === '') return optional ? null : `${label} 必填`
    if (!allowed.includes(value)) return `${label} 必须是 ${allowed.join(' / ')} 之一`
    return null
  },
  /** 布尔。 */
  bool: (label, { optional = true } = {}) => value => {
    if (value === undefined || value === null || value === '') return null
    if (typeof value !== 'boolean') return `${label} 必须是布尔值`
    return null
  },
  /** id：限定字符集，允许 / 分隔（模型 id 形如 up/<entry>/<model>），防止路径穿越与注入。 */
  id: (label, { optional = false, max = 120 } = {}) => value => {
    if (value === undefined || value === null || value === '') return optional ? null : `${label} 必填`
    if (typeof value !== 'string') return `${label} 必须是字符串`
    if (value.length > max) return `${label} 超过最大长度 ${max}`
    if (value.includes('..')) return `${label} 不允许 .. 路径段`
    if (!/^[A-Za-z0-9][A-Za-z0-9./_:@+-]*$/.test(value)) return `${label} 只允许字母数字与 . / _ : @ + -`
    return null
  },
  /** 模型 id 列表：每项过 id 规则。 */
  idList: (label, { optional = true, maxItems = 64 } = {}) => value => {
    if (value === undefined || value === null || value === '') return null
    if (!Array.isArray(value)) return `${label} 必须是数组`
    if (value.length > maxItems) return `${label} 最多 ${maxItems} 项`
    const idCheck = rules.id(label, { optional: false })
    for (const item of value) {
      const error = idCheck(item)
      if (error) return error
    }
    return null
  },
  /** 密钥：非空、可打印 ASCII、限长，不接受换行。 */
  secret: (label, { optional = true, max = 4096 } = {}) => value => {
    if (value === undefined || value === null || value === '') return null
    if (typeof value !== 'string') return `${label} 必须是字符串`
    if (value.length > max) return `${label} 超过最大长度 ${max}`
    if (/[\r\n\0]/.test(value)) return `${label} 不能包含换行或空字节`
    return null
  },
}

/**
 * 按 schema 校验 body。schema: { field: [check, ...] }。
 * 全部通过返回 null；否则返回 { statusCode: 400, fields: {field: reason}, message }。
 */
export function validate(body, schema) {
  const fields = {}
  for (const [field, checks] of Object.entries(schema)) {
    for (const check of checks) {
      const error = check(body?.[field])
      if (error) { fields[field] = error; break }
    }
  }
  if (Object.keys(fields).length === 0) return null
  return {
    statusCode: 400,
    message: `参数校验失败: ${Object.entries(fields).map(([k, v]) => `${k}（${v}）`).join('; ')}`,
    fields,
  }
}

/** 校验失败即抛出带 statusCode 的错误，供 api.js 的统一 catch 回 400。 */
export function assertValid(body, schema) {
  const problem = validate(body, schema)
  if (problem) throw Object.assign(new Error(problem.message), { statusCode: 400, fields: problem.fields })
}

/** 常用 schema 集合：与 API 路由一一对应。 */
export const schemas = {
  upstreamSave: {
    id: [rules.id('id', { optional: true })],
    name: [rules.string('name', { max: 80 })],
    kind: [rules.enum('kind', ['openai-chat', 'anthropic-messages'], { optional: true })],
    baseURL: [rules.httpUrl('baseURL')],
    apiKey: [rules.secret('apiKey')],
    enabled: [rules.bool('enabled')],
  },
  presetInstall: {
    presetId: [rules.id('presetId')],
  },
  upstreamAction: {
    id: [rules.id('id')],
  },
  modelToggle: {
    id: [rules.id('id')],
    disabled: [rules.bool('disabled')],
  },
  comboSave: {
    combos: [value => {
      if (value === undefined || value === null) return null
      if (!Array.isArray(value)) return 'combos 必须是数组'
      if (value.length > 32) return 'combos 最多 32 条'
      for (const [i, row] of value.entries()) {
        if (typeof row !== 'object' || row === null) return `combos[${i}] 必须是对象`
        if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 60) return `combos[${i}].name 必填且 ≤60 字符`
        if (row.strategy !== undefined && !['fallback', 'round-robin'].includes(row.strategy)) return `combos[${i}].strategy 必须是 fallback / round-robin`
        if (!Array.isArray(row.chain) || row.chain.length === 0) return `combos[${i}].chain 不能为空`
        if (row.chain.length > 16) return `combos[${i}].chain 最多 16 跳`
        const idCheck = rules.id(`combos[${i}].chain`, { optional: false, max: 160 })
        for (const item of row.chain) {
          const error = idCheck(item)
          if (error) return error
        }
      }
      return null
    }],
  },
  gatewaySetKey: {
    key: [rules.secret('key', { optional: false, max: 256 })],
  },
  workbuddyAction: {
    id: [rules.id('id')],
  },
  workbuddyRealm: {
    realm: [rules.enum('realm', ['cn', 'global'], { optional: true })],
  },
}
