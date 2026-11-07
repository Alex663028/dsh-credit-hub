/**
 * Upstream HTTP + SSE plumbing.
 *
 * Global fetch (Node ≥ 18, the harness runtime is 24) does the transport; this
 * module adds the two shapes every channel needs: one-shot JSON posts with
 * usable error objects, and an SSE line reader that yields `data:` payloads as
 * strings. Providers that answer an SSE request with a plain JSON error body
 * are surfaced as UpstreamError with the real status, not as a parse hang.
 *
 * @module src/http.js
 */

export const CODE = Object.freeze({
  aborted: 'ABORTED',
  timeout: 'TIMEOUT',
  transport: 'TRANSPORT',
  server: 'SERVER',
  client: 'CLIENT',
  auth: 'AUTH',
  rate: 'RATE_LIMIT',
  empty: 'EMPTY_RESPONSE',
  notFound: 'NOT_FOUND',
  region: 'REGION',
})

export class UpstreamError extends Error {
  constructor(message, code = CODE.transport, extra = undefined) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    if (extra && typeof extra === 'object') Object.assign(this, extra)
  }
}

export function bearerHeaders(token) {
  return { authorization: `Bearer ${token}` }
}

/** Error body → { text, envelope }：envelope 是解析出的业务信封（如 WorkBuddy {code,msg}），供错误分类用。 */
async function readErrorBody(response) {
  try {
    const text = await response.text()
    if (!text) return { text: '', envelope: undefined }
    try {
      const parsed = JSON.parse(text)
      const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error ?? text
      return { text: String(message), envelope: parsed }
    } catch { return { text, envelope: undefined } }
  } catch { return { text: '', envelope: undefined } }
}

function statusToCode(status) {
  return status === 401 || status === 403 ? CODE.auth
    : status === 404 ? CODE.notFound
    : status === 429 ? CODE.rate
    : status >= 500 ? CODE.server
    : CODE.client
}

/** POST JSON, expect JSON back. Non-2xx becomes a typed UpstreamError (envelope attached). */
export async function postJson(url, { headers = {}, body, signal, timeoutMs = 60_000 } = {}) {
  const controller = signal ? null : new AbortController()
  const timer = controller ? setTimeout(() => controller.abort(new UpstreamError('upstream timeout', CODE.timeout)), timeoutMs) : null
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
      signal: signal ?? controller?.signal,
    })
    if (!response.ok) {
      const { text, envelope } = await readErrorBody(response)
      throw new UpstreamError(
        `upstream ${response.status}${text ? `: ${String(text).slice(0, 400)}` : ''}`,
        statusToCode(response.status),
        { status: response.status, envelope },
      )
    }
    const text = await response.text()
    if (!text) return {}
    return JSON.parse(text)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function getJson(url, { headers = {}, signal, timeoutMs = 30_000 } = {}) {
  const controller = signal ? null : new AbortController()
  const timer = controller ? setTimeout(() => controller.abort(new UpstreamError('upstream timeout', CODE.timeout)), timeoutMs) : null
  try {
    const response = await fetch(url, { headers, signal: signal ?? controller?.signal })
    if (!response.ok) {
      const { text, envelope } = await readErrorBody(response)
      throw new UpstreamError(
        `upstream ${response.status}${text ? `: ${String(text).slice(0, 400)}` : ''}`,
        statusToCode(response.status),
        { status: response.status, envelope },
      )
    }
    return response.json()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * POST and stream the SSE body. Calls `onEvent(dataString, eventName)` per
 * `data:` frame; comment/keepalive lines and non-SSE bodies are the caller's
 * problem via the returned response (kept for body-shape sniffing).
 *
 * `idleTimeoutMs`（默认 120s）按"上次收到字节"起算兜底：静默挂死的上游不再
 * 无限期占用调用方。Errors before the first byte throw typed UpstreamErrors
 * with the parsed business envelope attached（供 {code,msg} 类信封做错误分类）。
 */
export async function postSse(url, { headers = {}, body, signal, onEvent, onResponse, idleTimeoutMs = 120_000 } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    signal,
  })
  onResponse?.(response)
  if (!response.ok) {
    const { text, envelope } = await readErrorBody(response)
    throw new UpstreamError(
      `upstream ${response.status}${text ? `: ${String(text).slice(0, 400)}` : ''}`,
      statusToCode(response.status),
      { status: response.status, envelope },
    )
  }
  const contentType = String(response.headers.get('content-type') ?? '')
  if (!contentType.includes('text/event-stream')) {
    // A gateway answering a streamed request with one JSON object: feed the
    // whole body through the same onEvent path so parsers see `data: {...}`.
    const text = await response.text()
    if (text.trim()) onEvent(text.trim(), 'message')
    return response
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = 'message'
  const readWithIdle = async () => {
    if (!idleTimeoutMs || idleTimeoutMs === Infinity) return reader.read()
    let timer
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            // 先 reject 再 cancel：cancel 会把挂起的 read() 以 {done:true} 结算，
            // 顺序反了 race 就被"正常结束"抢先，超时永远不抛
            reject(new UpstreamError(`SSE 空闲超过 ${Math.round(idleTimeoutMs / 1000)}s 无数据`, CODE.timeout))
            try { reader.cancel(new UpstreamError('SSE idle timeout', CODE.timeout)) } catch {}
          }, idleTimeoutMs)
        }),
      ])
    } finally { clearTimeout(timer) }
  }
  try {
    while (true) {
      const { done, value } = await readWithIdle()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let cut
      while ((cut = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, cut).replace(/\r$/, '')
        buffer = buffer.slice(cut + 1)
        if (line === '') { eventName = 'message'; continue }
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue }
        if (line.startsWith('data:')) {
          const data = line.slice(5).trimStart()
          if (data === '[DONE]') continue
          onEvent(data, eventName)
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
  return response
}
