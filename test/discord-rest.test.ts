/**
 * Typed Discord REST adapter tests. Every request resolves to exactly one of
 * three outcomes: `completed` (Discord applied it), `rejected` (Discord
 * refused it — definitive), or `unknown` (the wire outcome could not be
 * observed, e.g. network failure or abort). The adapter never invents a
 * fourth "probably fine" state and never retries past its bound.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRestClient, createSharedRestClient, type FetchLike, type FetchRequest } from '../src/discord/rest.js'

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

describe('per-route serialized rest', () => {
  interface Deferred {
    resolve: (response: Response) => void
    reject: (cause: unknown) => void
  }

  function createGatedHarness(options: { maxRetries?: number } = {}) {
    const calls: FetchRequest[] = []
    const gates: Deferred[] = []
    const fetchLike: FetchLike = (request) => {
      calls.push(request)
      return new Promise<Response>((resolve, reject) => { gates.push({ resolve, reject }) })
    }
    const client = createSharedRestClient({ token: 'rest-token' }, { maxRetries: 0, ...options }, fetchLike)
    const gate = (index: number): Deferred => {
      const pending = gates[index]
      if (pending === undefined) throw new Error(`test bug: gate ${String(index)} not open`)
      return pending
    }
    return {
      calls,
      gates,
      client,
      resolveGate: (index: number, response: Response) => { gate(index).resolve(response) },
      rejectGate: (index: number, cause: unknown) => { gate(index).reject(cause) },
    }
  }

  /** One macrotask: lets the bucket chain invoke the next gated fetch. */
  const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

  it('serializes writes to the same route bucket', async () => {
    vi.useRealTimers()
    const h = createGatedHarness()

    const first = h.client.request('POST', '/channels/42/messages', { content: 'a' })
    const second = h.client.request('POST', '/channels/42/messages', { content: 'b' })
    await Promise.resolve()
    expect(h.calls).toHaveLength(1)

    h.resolveGate(0, new Response(JSON.stringify({ id: 'm1' }), { status: 200 }))
    const firstResult = await first
    expect(firstResult).toMatchObject({ outcome: 'completed' })

    // The second write only reaches the wire after the first settles.
    await Promise.resolve()
    expect(h.calls).toHaveLength(2)
    h.resolveGate(1, new Response(JSON.stringify({ id: 'm2' }), { status: 200 }))
    expect(await second).toMatchObject({ outcome: 'completed' })
  })

  it('lets different route buckets proceed concurrently', async () => {
    vi.useRealTimers()
    const h = createGatedHarness()

    const channels = h.client.request('POST', '/channels/42/messages', {})
    const guilds = h.client.request('GET', '/guilds/77/channels')
    await Promise.resolve()
    expect(h.calls).toHaveLength(2)

    h.resolveGate(1, new Response('[]', { status: 200 }))
    h.resolveGate(0, new Response(JSON.stringify({ id: 'm1' }), { status: 200 }))
    expect(await guilds).toMatchObject({ outcome: 'completed' })
    expect(await channels).toMatchObject({ outcome: 'completed' })
  })

  it('buckets by major parameter, not full path', async () => {
    vi.useRealTimers()
    const h = createGatedHarness()

    const send = h.client.request('POST', '/channels/42/messages', {})
    const edit = h.client.request('PATCH', '/channels/42/messages/99', {})
    const typing = h.client.request('POST', '/channels/42/typing', {})
    await Promise.resolve()
    expect(h.calls).toHaveLength(1)

    h.resolveGate(0, new Response(JSON.stringify({}), { status: 200 }))
    await send
    await tick()
    h.resolveGate(1, new Response(JSON.stringify({}), { status: 200 }))
    await edit
    await tick()
    h.resolveGate(2, new Response(JSON.stringify({}), { status: 200 }))
    await typing
    expect(h.calls).toHaveLength(3)
  })

  it('keeps draining the bucket after a failed request', async () => {
    vi.useRealTimers()
    const h = createGatedHarness()

    const failing = h.client.request('POST', '/channels/42/messages', {})
    const following = h.client.request('POST', '/channels/42/messages', {})
    await tick()
    h.rejectGate(0, new TypeError('network down'))
    await expect(failing).resolves.toMatchObject({ outcome: 'unknown' })

    await tick()
    expect(h.calls).toHaveLength(2)
    h.resolveGate(1, new Response(JSON.stringify({ id: 'm2' }), { status: 200 }))
    await expect(following).resolves.toMatchObject({ outcome: 'completed' })
  })
})
