/**
 * 网关路由表（优先级一：模块化收尾）。
 *
 * 把原先 forward.js 里的一串 if 判断收敛成声明式表：
 *   - GET  `/healthz`          健康探针（鉴权之前）
 *   - GET  `/v1/models`        模型清单
 *   - POST 三条 wire 路由       Responses / Chat Completions / Messages
 *
 * 每条 wire 路由声明自己的路径别名与请求体形态；具体的 build / stream /
 * complete 处理器由 forward.js 按 id 注册（它们依赖闭包里的 hub 与统计）。
 * 新增协议线只需在此加一行 + 注册三个处理器，不必改分发逻辑。
 *
 * @module src/routes.js
 */

/** 无需请求体的简单路由。 */
export const SIMPLE_ROUTES = Object.freeze([
  { id: 'healthz', method: 'GET', paths: Object.freeze(['/healthz']) },
  { id: 'models', method: 'GET', paths: Object.freeze(['/v1/models']) },
])

/**
 * Wire 路由：需要 JSON 请求体、要建 AbortController、结果要记日志与统计。
 * paths 里同时列出带版本前缀与裸路径（Codex/部分代理会省略 /v1）。
 */
export const WIRE_ROUTES = Object.freeze([
  {
    id: 'responses',
    method: 'POST',
    paths: Object.freeze(['/v1/responses', '/responses']),
  },
  {
    id: 'chat',
    method: 'POST',
    paths: Object.freeze(['/v1/chat/completions', '/chat/completions']),
  },
  {
    id: 'messages',
    method: 'POST',
    paths: Object.freeze(['/v1/messages', '/messages']),
  },
])

const ALL = [...SIMPLE_ROUTES, ...WIRE_ROUTES]

/** 精确匹配（不做前缀匹配，避免 /v1/models-x 被误命中）。未命中返回 undefined。 */
export function matchRoute(method, routePath) {
  const wanted = String(method ?? 'GET').toUpperCase()
  for (const route of ALL) {
    if (route.method !== wanted) continue
    if (route.paths.includes(routePath)) return route
  }
  return undefined
}

/** 所有已注册路径（诊断/文档用）。 */
export function routeList() {
  return ALL.map(route => ({ id: route.id, method: route.method, paths: [...route.paths] }))
}