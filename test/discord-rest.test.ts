/**
 * Typed Discord REST adapter tests. Every request resolves to exactly one of
 * three outcomes: `completed` (Discord applied it), `rejected` (Discord
 * refused it — definitive), or `unknown` (the wire outcome could not be
 * observed, e.g. network failure or abort). The adapter never invents a
 * fourth "probably fine" state and never retries past its bound.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRestClient, type FetchLike, type FetchRequest } from '../src/discord/rest.js'

type ScriptedResponse =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | 'network-error'

interface Harness {
  calls: FetchRequest[]
  script: (...responses: ScriptedResponse[]) => void
  client: ReturnType<typeof createRestClient>
}

function createHarness(overrides: Parameters<typeof createRestClient>[1] = {}): Harness {
  const calls: FetchRequest[] = []
  const queue: ScriptedResponse[] = []
  const fetchLike: FetchLike = (request) => {
    calls.push(request)
    const scripted = queue.shift()
    if (scripted === undefined) return Promise.reject(new Error('test bug: no scripted response left'))
    if (scripted === 'network-error') return Promise.reject(new TypeError('network down'))
    const { body, ...init } = scripted
    return Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), init))
  }
  const script = (...responses: ScriptedResponse[]) => { queue.push(...responses) }
  const client = createRestClient({ token: 'rest-token' }, overrides, fetchLike)
  return { calls, script, client }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('discord rest client', () => {
  it('completes a JSON request with auth and parsed body', async () => {
    const h = createHarness()
    h.script({ status: 200, body: { id: '1' } })
    const result = await h.client.request('GET', '/users/@me')
    expect(result).toEqual({ outcome: 'completed', status: 200, body: { id: '1' } })
    expect(h.calls[0]?.headers['authorization']).toBe('Bot rest-token')
    expect(h.calls[0]?.path).toBe('/users/@me')
  })

  it('maps definitive 4xx failures to a structured rejection without retry', async () => {
    const h = createHarness()
    h.script({ status: 403, body: { code: 50013, message: 'Missing Permissions' } })
    const result = await h.client.request('POST', '/channels/1/messages', { content: 'x' })
    expect(result).toEqual({
      outcome: 'rejected',
      status: 403,
      error: { code: 50013, message: 'Missing Permissions' },
    })
    expect(h.calls).toHaveLength(1)
  })

  it('honors Retry-After on 429 and succeeds on retry', async () => {
    const h = createHarness()
    h.script(
      { status: 429, headers: { 'retry-after': '1.5' }, body: { code: 0, message: 'rate limited' } },
      { status: 200, body: { id: '2' } },
    )
    let settled = false
    const pending = h.client.request('POST', '/channels/1/messages', { content: 'x' })
    void pending.then(() => { settled = true })

    await vi.advanceTimersByTimeAsync(1_499)
    expect(h.calls).toHaveLength(1)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    const result = await pending
    expect(result).toEqual({ outcome: 'completed', status: 200, body: { id: '2' } })
    expect(h.calls).toHaveLength(2)
  })

  it('treats exhausted rate-limit retries as a definitive rejection', async () => {
    const h = createHarness({ maxRetries: 2 })
    h.script(
      { status: 429, headers: { 'retry-after': '0.1' }, body: { code: 0, message: 'rate limited' } },
      { status: 429, headers: { 'retry-after': '0.1' }, body: { code: 0, message: 'rate limited' } },
      { status: 429, headers: { 'retry-after': '0.1' }, body: { code: 0, message: 'rate limited' } },
    )
    const pending = h.client.request('POST', '/channels/1/messages', {})
    const result = await vi.runAllTimersAsync().then(() => pending)
    expect(result).toMatchObject({ outcome: 'rejected', error: { code: 'rate-limited' } })
    expect(h.calls).toHaveLength(3)
  })

  it('retries transient 5xx failures with backoff and completes', async () => {
    const h = createHarness()
    h.script({ status: 502, body: { code: 0, message: 'bad gateway' } }, { status: 200, body: { id: '3' } })
    const pending = h.client.request('GET', '/users/@me')
    const result = await vi.runAllTimersAsync().then(() => pending)
    expect(result).toEqual({ outcome: 'completed', status: 200, body: { id: '3' } })
    expect(h.calls).toHaveLength(2)
  })

  it('reports unknown outcome when 5xx retries are exhausted', async () => {
    const h = createHarness({ maxRetries: 1 })
    h.script(
      { status: 500, body: { code: 0, message: 'oops' } },
      { status: 500, body: { code: 0, message: 'oops' } },
    )
    const pending = h.client.request('POST', '/channels/1/messages', {})
    const result = await vi.runAllTimersAsync().then(() => pending)
    expect(result).toEqual({ outcome: 'unknown', reason: 'network-unreachable' })
    expect(h.calls).toHaveLength(2)
  })

  it('reports unknown outcome on network failure', async () => {
    const h = createHarness({ maxRetries: 1 })
    h.script('network-error', 'network-error')
    const pending = h.client.request('POST', '/channels/1/messages', {})
    const result = await vi.runAllTimersAsync().then(() => pending)
    expect(result).toEqual({ outcome: 'unknown', reason: 'network-unreachable' })
    expect(h.calls).toHaveLength(2)
  })

  it('reports aborted as an unknown outcome and stops retrying', async () => {
    const h = createHarness()
    const controller = new AbortController()
    h.script({ status: 429, headers: { 'retry-after': '5' }, body: { code: 0, message: 'rate limited' } })
    const pending = h.client.request('POST', '/channels/1/messages', {}, { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    const result = await vi.runAllTimersAsync().then(() => pending)
    expect(result).toEqual({ outcome: 'unknown', reason: 'aborted' })
    expect(h.calls).toHaveLength(1)
  })
})
