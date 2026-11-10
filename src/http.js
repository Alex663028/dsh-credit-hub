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

/** Retry-After → 毫秒；支持 delta-seconds 与 HTTP-date，无法解析时返回 undefined。 */
function parseRetryAfter(value) {
  if (value == null) return undefined
  const raw = String(value).trim()
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw)
    return Number.isFinite(seconds) ? seconds * 1000 : undefined
  }
  const when = Date.parse(raw)
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now())
}

/** 非 2xx 的错误附加字段：status / envelope，并对 429 打上限流标记与退避时长。 */
function errorExtra(response, envelope) {
  const extra = { status: response.status, envelope }
  if (response.status === 429) {
    extra.rateLimited = true
    extra.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
  }
  return extra
}

/**
 * 把外部 signal 转发进内部控制（手动合并），返回注销函数。内部控制始终存在，
 * 因此即便调用方传了外部 signal，超时定时器也依然挂在同一个 controller 上生效。
 */
function linkExternalSignal(signal, controller) {
  if (!signal) return () => {}
  const forward = () => controller.abort(signal.reason)
  if (signal.aborted) forward()
  else signal.addEventListener('abort', forward, { once: true })
  return () => signal.removeEventListener('abort', forward)
}

/** POST JSON, expect JSON back. Non-2xx becomes a typed UpstreamError (envelope attached). */
export async function postJson(url, { headers = {}, body, signal, timeoutMs = 60_000 } = {}) {
  const controller = new AbortController()
  const unlink = linkExternalSignal(signal, controller)
  const timer = setTimeout(() => controller.abort(new UpstreamError('upstream timeout', CODE.timeout)), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
      signal: controller.signal,
    })
    if (!response.ok) {
      const { text, envelope } = await readErrorBody(response)
      throw new UpstreamError(
        `upstream ${response.status}${text ? `: ${String(text).slice(0, 400)}` : ''}`,
        statusToCode(response.status),
        errorExtra(response, envelope),
      )
    }
    const text = await response.text()
    if (!text) return {}
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
    unlink()
  }
}

export async function getJson(url, { headers = {}, signal, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController()
  const unlink = linkExternalSignal(signal, controller)
  const timer = setTimeout(() => controller.abort(new UpstreamError('upstream timeout', CODE.timeout)), timeoutMs)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) {
      const { text, envelope } = await readErrorBody(response)
      throw new UpstreamError(
        `upstream ${response.status}${text ? `: ${String(text).slice(0, 400)}` : ''}`,
        statusToCode(response.status),
        errorExtra(response, envelope),
      )
    }
    return response.json()
  } finally {
    clearTimeout(timer)
    unlink()
  }
}

/**
 * POST and stream the SSE body. Calls `onEvent(dataString, eventName)` once per
 * SSE frame (blank-line delimited); multiple `data:` lines inside one frame are
 * joined with '\n'. `event:` lines set the frame's event name (default
 * 'message'). Comment/keepalive lines and non-SSE bodies are handled as before
 * (a non-SSE JSON body is fed through `onEvent` verbatim). Existing callers only
 * consume the first argument — the second is additive/compatible.
 *
 * Timeouts — either one aborts; all timers/reader are released in a finally on
 * success, failure or cancellation:
 *  - `idleTimeoutMs` (default 120s): re-armed after every received chunk, aborts
 *    when the upstream stays silent for that long.
 *  - `totalTimeoutMs` (default 600s): wall-clock cap over the whole request.
 * An external `signal` is merged into the always-present internal controller
 * (manual forwarding), so cancellation aborts immediately AND idle/total
 * timeouts still apply even when a signal is supplied.
 *
 * 429 is surfaced (never retried here) with `status`, `rateLimited: true` and
 * `retryAfterMs` (parsed from Retry-After) on the thrown UpstreamError so the
 * caller can decide to back off.
 */
export async function postSse(url, {
  headers = {}, body, signal, onEvent, onResponse,
  idleTimeoutMs = 120_000, totalTimeoutMs = 600_000,
} = {}) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new UpstreamError('upstream aborted', CODE.aborted)
  }

  // Internal controller is always present and is the single abort source for
  // fetch. The external signal is forwarded into it; timers abort it too.
  const controller = new AbortController()

  let reader = null
  let idleTimer = null
  let totalTimer = null
  let settled = false
  let rejectFailure
  // Rejects (never resolves) on the first timeout / external abort. Racing the
  // fetch and each read against it gives a deterministic typed error, instead
  // of depending on how the runtime propagates an AbortSignal reason.
  const failure = new Promise((_, reject) => { rejectFailure = reject })
  failure.catch(() => {})

  const stopTimers = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    if (totalTimer) { clearTimeout(totalTimer); totalTimer = null }
  }

  // Reject first so the typed error wins the race, then abort to stop fetch /
  // reader promptly (abort errors the body stream, unlike a graceful cancel).
  const fail = error => {
    if (settled) return
    rejectFailure(error)
    controller.abort(error)
  }

  const onExternalAbort = () => {
    const reason = signal.reason
    fail(reason instanceof Error ? reason : new UpstreamError('upstream aborted', CODE.aborted))
  }
  if (signal) signal.addEventListener('abort', onExternalAbort, { once: true })

  // Total wall-clock cap: set once, never reset.
  if (Number.isFinite(totalTimeoutMs) && totalTimeoutMs > 0) {
    totalTimer = setTimeout(
      () => fail(new UpstreamError(`SSE 总耗时超过 ${Math.round(totalTimeoutMs / 1000)}s`, CODE.timeout)),
      totalTimeoutMs,
    )
  }

  // Idle guard: re-armed before each read so it measures the gap since the last
  // byte. Firing produces the `空闲` message the harness/tests key off.
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return
    idleTimer = setTimeout(
      () => fail(new UpstreamError(`SSE 空闲超过 ${Math.round(idleTimeoutMs / 1000)}s 无数据`, CODE.timeout)),
      idleTimeoutMs,
    )
  }

  const cleanup = () => {
    settled = true
    stopTimers()
    if (signal) signal.removeEventListener('abort', onExternalAbort)
    if (reader) {
      try { reader.cancel().catch(() => {}) } catch {}
      try { reader.releaseLock() } catch {}
    }
  }

  try {
    const response = await Promise.race([
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
        signal: controller.signal,
      }),
      failure,
    ])
    onResponse?.(response)
    if (!response.ok) {
      const { text, envelope } = await Promise.race([readErrorBody(response), failure])
      throw new UpstreamError(
        `upstream ${response.status}${text ? `: ${String(text).slice(0, 400)}` : ''}`,
        statusToCode(response.status),
        errorExtra(response, envelope),
      )
    }
    const contentType = String(response.headers.get('content-type') ?? '')
    if (!contentType.includes('text/event-stream')) {
      // A gateway answering a streamed request with one JSON object: feed the
      // whole body through the same onEvent path so parsers see `data: {...}`.
      const text = await Promise.race([response.text(), failure])
      if (text.trim()) onEvent(text.trim(), 'message')
      return response
    }

    reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let dataLines = []          // data: lines accumulated for the current frame
    let eventName = 'message'   // event: of the current frame

    const dispatch = () => {
      if (dataLines.length === 0) { eventName = 'message'; return }
      const data = dataLines.join('\n')
      const name = eventName
      dataLines = []
      eventName = 'message'
      if (data === '[DONE]') return
      onEvent(data, name)
    }

    while (true) {
      armIdle()
      const { done, value } = await Promise.race([reader.read(), failure])
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let cut
      while ((cut = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') { dispatch(); continue }
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue }
        if (line.startsWith('data:')) { dataLines.push(line.slice(5).trimStart()); continue }
        // id:, retry: 及未知字段按 SSE 规范忽略。
      }
    }
    dispatch() // flush a trailing frame not terminated by a blank line
    return response
  } finally {
    cleanup()
  }
}
