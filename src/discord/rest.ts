/**
 * The typed Discord REST adapter. Every request resolves to exactly one of
 * three outcomes — `completed`, `rejected`, or `unknown` — because cross-system
 * delivery is never provably once: a refused request (4xx, exhausted 429) is
 * definitive, while an unobservable outcome (network failure, abort,
 * exhausted 5xx) may or may not have been applied and must be reconciled,
 * never blindly retried by callers.
 */

export type RestMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

/** The untyped wire face injected for testability (fetch-shaped). */
export interface FetchRequest {
  readonly method: RestMethod
  readonly url: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body?: string
  readonly signal?: AbortSignal
}

export type FetchLike = (request: FetchRequest) => Promise<Response>

/** Discord's structured error body (subset the adapter reasons about). */
export interface DiscordError {
  code: number | string
  message: string
}

export type RestResult<T> =
  | { outcome: 'completed'; status: number; body: T }
  | { outcome: 'rejected'; status: number; error: DiscordError }
  | { outcome: 'unknown'; reason: 'network-unreachable' | 'aborted' }

export interface RestClientConfig {
  token: string
  /** REST base; production points at https://discord.com/api/v10. */
  apiBase?: string
}

export interface RestClientOptions {
  /** Extra attempts after the first; each 429/5xx retry consumes one. */
  maxRetries?: number
  /** Base delay for 5xx backoff (doubles per attempt). */
  backoffBaseMs?: number
  /** Cap for any single wait, so a hostile Retry-After cannot stall the adapter. */
  maxDelayMs?: number
}

const DEFAULT_API_BASE = 'https://discord.com/api/v10'
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BACKOFF_BASE_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 30_000

const sleep = (ms: number): Promise<void> => {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

function parseDelayMs(response: Response, fallbackMs: number, capMs: number): number {
  const header = response.headers.get('retry-after')
  const seconds = header === null ? Number.NaN : Number.parseFloat(header)
  if (!Number.isFinite(seconds) || seconds < 0) return fallbackMs
  return Math.min(seconds * 1_000, capMs)
}

function readError(body: unknown): DiscordError {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>
    const code = record['code']
    const message = record['message']
    if ((typeof code === 'number' || typeof code === 'string') && typeof message === 'string') {
      return { code, message }
    }
  }
  return { code: 'unknown-discord-error', message: 'unparseable error body' }
}

export function createRestClient(
  config: RestClientConfig,
  options: RestClientOptions = {},
  fetchLike?: FetchLike,
): {
  request<T>(method: RestMethod, path: string, body?: unknown, init?: { signal?: AbortSignal }): Promise<RestResult<T>>
} {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const doFetch: FetchLike = fetchLike ?? (async (request) => {
    const init: RequestInit = { method: request.method, headers: request.headers }
    if (request.body !== undefined) init.body = request.body
    if (request.signal !== undefined) init.signal = request.signal
    return fetch(request.url, init)
  })

  type AttemptOutcome<T> =
    | RestResult<T>
    | { retry: '429'; delayMs: number }
    | { retry: '5xx' }
    | { retry: 'network' }

  async function attempt<T>(request: FetchRequest): Promise<AttemptOutcome<T>> {
    try {
      const response = await doFetch(request)
      const text = await response.text()
      let body: unknown
      try {
        body = text === '' ? undefined : JSON.parse(text)
      } catch {
        body = text
      }
      if (response.ok) {
        return { outcome: 'completed', status: response.status, body: body as T }
      }
      const error = readError(body)
      if (response.status === 429) {
        // Discord did not apply the request; honor its Retry-After (bounded).
        return { retry: '429', delayMs: parseDelayMs(response, backoffBaseMs, maxDelayMs) }
      }
      if (response.status >= 500) {
        return { retry: '5xx' }
      }
      return { outcome: 'rejected', status: response.status, error }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { outcome: 'unknown', reason: 'aborted' }
      }
      return { retry: 'network' }
    }
  }

  async function request<T>(
    method: RestMethod,
    path: string,
    body?: unknown,
    init?: { signal?: AbortSignal },
  ): Promise<RestResult<T>> {
    for (let attemptNo = 0; attemptNo <= maxRetries; attemptNo += 1) {
      if (init?.signal?.aborted === true) {
        return { outcome: 'unknown', reason: 'aborted' }
      }
      const fetchRequest: FetchRequest = {
        method,
        url: `${apiBase}${path}`,
        path,
        headers: {
          'authorization': `Bot ${config.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(init?.signal === undefined ? {} : { signal: init.signal }),
      }
      const outcome = await attempt<T>(fetchRequest)
      if ('retry' in outcome) {
        const isFinalAttempt = attemptNo === maxRetries
        if (outcome.retry === '429') {
          // A 429 on the last attempt is a definitive rejection, not unknown:
          // Discord answered and refused, so the request was never applied.
          if (isFinalAttempt) {
            return { outcome: 'rejected', status: 429, error: { code: 'rate-limited', message: 'rate limit retries exhausted' } }
          }
          await sleep(outcome.delayMs)
          continue
        }
        if (isFinalAttempt) {
          return { outcome: 'unknown', reason: 'network-unreachable' }
        }
        await sleep(Math.min(backoffBaseMs * 2 ** attemptNo, maxDelayMs))
        continue
      }
      return outcome
    }
    return { outcome: 'unknown', reason: 'network-unreachable' }
  }

  return { request }
}
