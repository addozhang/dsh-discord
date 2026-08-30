/**
 * Gateway state machine tests over a fake socket factory and fake clocks:
 * heartbeat acknowledgement, resumable reconnect, terminal close codes,
 * bounded backoff, generation replacement, and disposal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TERMINAL_CLOSE_CODES,
  type GatewayDispatch,
  type GatewayOptions,
  type GatewaySocket,
} from '../src/gateway/gateway.js'

interface TrackedSocket extends GatewaySocket {
  sent: unknown[]
  closed: number[]
  terminated: boolean
}

interface FakeSocketRecord {
  socket: TrackedSocket
  sent: unknown[]
}

function createHarness(overrides: Partial<GatewayOptions> = {}) {
  const sockets: FakeSocketRecord[] = []
  const dispatches: GatewayDispatch[] = []
  const terminal: number[] = []
  const backoffs: { attempt: number; delayMs: number }[] = []
  const tokenProvider = vi.fn(() => Promise.resolve('bot-token'))

  const options: GatewayOptions = {
    url: 'wss://gateway.example/?v=10&encoding=json',
    tokenProvider,
    intents: 33280,
    socketFactory: (url) => {
      const socket: TrackedSocket = {
        url,
        sent: [],
        closed: [],
        terminated: false,
        send: (data) => { socket.sent.push(JSON.parse(data) as unknown) },
        close: (code) => { socket.closed.push(code ?? 1000) },
        terminate: () => { socket.terminated = true },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      }
      sockets.push({ socket, sent: socket.sent })
      return socket
    },
    onDispatch: (event) => { dispatches.push(event) },
    onTerminalClose: (code) => { terminal.push(code) },
    onBackoffScheduled: (attempt, delayMs) => { backoffs.push({ attempt, delayMs }) },
    ...overrides,
  }

  function currentSocket(): TrackedSocket {
    const record = sockets.at(-1)
    if (record === undefined) throw new Error('no socket created')
    return record.socket
  }

  /** Flush the token promise's microtask chain so connect() finishes. */
  const flush = (): Promise<void> => Promise.resolve()

  function openAndHello(heartbeatIntervalMs = 41_250): void {
    currentSocket().onopen?.()
    currentSocket().onmessage?.(JSON.stringify({
      op: 10,
      d: { heartbeat_interval: heartbeatIntervalMs },
    }))
  }

  function ready(sessionId = 'session-1'): void {
    currentSocket().onmessage?.(JSON.stringify({
      t: 'READY', s: 7, op: 0, d: { session_id: sessionId },
    }))
  }

  return { options, sockets, dispatches, terminal, backoffs, tokenProvider, currentSocket, openAndHello, ready, flush }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('gateway state machine', () => {
  it('identifies after HELLO, then heartbeats with the last seen sequence', async () => {
    const h = createHarness()
    const { startGateway } = await import('../src/gateway/gateway.js')
    const gateway = startGateway(h.options)
    await h.flush()

    h.currentSocket().onopen?.()
    h.currentSocket().onmessage?.(JSON.stringify({ op: 10, d: { heartbeat_interval: 41_250 } }))
    expect(h.currentSocket().sent.at(-1)).toMatchObject({ op: 2, d: { token: 'bot-token', intents: 33280 } })

    h.currentSocket().onmessage?.(JSON.stringify({ t: 'MESSAGE_CREATE', s: 5, op: 0, d: { id: 'x' } }))
    await vi.advanceTimersByTimeAsync(41_250)
    await h.flush()
    expect(h.currentSocket().sent.at(-1)).toEqual({ op: 1, d: 5 })
    gateway.dispose()
  })

  it('reconnects with resume after a recoverable close and bounded backoff', async () => {
    const h = createHarness()
    const { startGateway } = await import('../src/gateway/gateway.js')
    const gateway = startGateway(h.options)
    await h.flush()

    h.openAndHello()
    h.ready('session-1')
    h.currentSocket().onmessage?.(JSON.stringify({ t: 'MESSAGE_CREATE', s: 9, op: 0, d: {} }))
    h.currentSocket().onclose?.(4000)

    await vi.advanceTimersByTimeAsync(1_000)
    await h.flush()
    expect(h.sockets).toHaveLength(2)
    h.openAndHello()
    expect(h.currentSocket().sent.at(-1)).toMatchObject({
      op: 6,
      d: { token: 'bot-token', session_id: 'session-1', seq: 9 },
    })
    gateway.dispose()
  })

  it('escalates backoff exponentially and resets it after READY', async () => {
    const h = createHarness()
    const { startGateway } = await import('../src/gateway/gateway.js')
    const gateway = startGateway(h.options)
    await h.flush()

    h.openAndHello()
    h.ready()
    h.currentSocket().onclose?.(4000)
    expect(h.backoffs[0]).toEqual({ attempt: 1, delayMs: 1_000 })

    await vi.advanceTimersByTimeAsync(1_000)
    await h.flush()
    h.openAndHello()
    h.currentSocket().onclose?.(4000)
    expect(h.backoffs[1]).toEqual({ attempt: 2, delayMs: 2_000 })

    await vi.advanceTimersByTimeAsync(2_000)
    await h.flush()
    h.openAndHello()
    h.currentSocket().onclose?.(4000)
    expect(h.backoffs[2]).toEqual({ attempt: 3, delayMs: 4_000 })

    await vi.advanceTimersByTimeAsync(4_000)
    await h.flush()
    h.openAndHello()
    h.ready()
    h.currentSocket().onclose?.(4000)
    expect(h.backoffs.at(-1)).toEqual({ attempt: 1, delayMs: 1_000 })
    expect(h.sockets.length).toBeGreaterThanOrEqual(4)
    gateway.dispose()
  })

  it('caps backoff at the configured bound', async () => {
    const h = createHarness({ backoffCapMs: 4_000 })
    const { startGateway } = await import('../src/gateway/gateway.js')
    const gateway = startGateway(h.options)
    await h.flush()

    h.openAndHello()
    h.ready()
    for (let round = 0; round < 4; round += 1) {
      h.currentSocket().onclose?.(4000)
      await vi.advanceTimersByTimeAsync(60_000)
      await h.flush()
      h.openAndHello()
    }
    h.currentSocket().onclose?.(4000)
    expect(h.backoffs.at(-1)?.delayMs).toBe(4_000)
    gateway.dispose()
  })

  it('terminates the connection when a heartbeat acknowledgement is missed', async () => {
    const h = createHarness()
    const { startGateway } = await import('../src/gateway/gateway.js')
    const gateway = startGateway(h.options)
    await h.flush()

    h.openAndHello()
    await vi.advanceTimersByTimeAsync(41_250)
    await h.flush()
    h.currentSocket().onmessage?.(JSON.stringify({ op: 11 }))
    await vi.advanceTimersByTimeAsync(41_250)
    await h.flush()
    expect(h.currentSocket().sent.at(-1)).toEqual({ op: 1, d: null })
    await vi.advanceTimersByTimeAsync(41_250)
    await h.flush()
    expect(h.currentSocket().terminated).toBe(true)
    gateway.dispose()
  })

  it('reconnects when the terminated socket never fires onclose (fallback)', async () => {
    const h = createHarness()
    const { startGateway } = await import('../src/gateway/gateway.js')
    const gateway = startGateway(h.options)
    await h.flush()

    h.openAndHello()
    h.ready('session-1')
    // Two heartbeat intervals without an op-11 ack: the miss path terminates.
    await vi.advanceTimersByTimeAsync(41_250)
    await vi.advanceTimersByTimeAsync(41_250)
    expect(h.currentSocket().terminated).toBe(true)

    // The production adapter terminates via a graceful close, which a
    // partitioned peer never answers: onclose never arrives. The fallback
    // must drive the reconnect machinery within its grace period.
    await vi.advanceTimersByTimeAsync(5_000)
    await h.flush()
    await vi.advanceTimersByTimeAsync(1_000)
    await h.flush()
    expect(h.sockets).toHaveLength(2)
    expect(h.backoffs).toEqual([{ attempt: 1, delayMs: 1_000 }])
    gateway.dispose()
  })

  it('never reconnects after a terminal close code and reports it once', async () => {
    const h = createHarness()
    const { startGateway } = await import('../src/gateway/gateway.js')
    const gateway = startGateway(h.options)
    await h.flush()

    expect(TERMINAL_CLOSE_CODES).toContain(4004)
    h.openAndHello()
    h.ready()
    h.currentSocket().onclose?.(4004)
    await vi.advanceTimersByTimeAsync(120_000)
    await h.flush()
    expect(h.terminal).toEqual([4004])
    expect(h.sockets).toHaveLength(1)
    gateway.dispose()
  })

  it('reconnects fresh when Discord invalidates the session', async () => {
    const h = createHarness()
    const { startGateway } = await import('../src/gateway/gateway.js')
    const gateway = startGateway(h.options)
    await h.flush()

    h.openAndHello()
    h.ready('session-1')
    h.currentSocket().onclose?.(4000)
    await vi.advanceTimersByTimeAsync(1_000)
    await h.flush()
    h.currentSocket().onmessage?.(JSON.stringify({ op: 9, d: false }))
    h.currentSocket().onclose?.(4000)
    await vi.advanceTimersByTimeAsync(2_000)
    await h.flush()
    h.openAndHello()
    const identify = h.currentSocket().sent.at(-1) as { op: number } | undefined
    expect(identify?.op).toBe(2)
    gateway.dispose()
  })

  it('reconnects when Discord requests it and ignores stale generation events', async () => {
    const h = createHarness()
    const { startGateway } = await import('../src/gateway/gateway.js')
    const gateway = startGateway(h.options)
    await h.flush()

    h.openAndHello()
    h.ready('session-1')
    h.currentSocket().onmessage?.(JSON.stringify({ op: 7 }))
    h.currentSocket().onclose?.(4000)
    expect(h.backoffs).toEqual([{ attempt: 1, delayMs: 1_000 }])

    await vi.advanceTimersByTimeAsync(1_000)
    await h.flush()
    const staleSocket = h.sockets[0]?.socket
    h.openAndHello()
    h.ready('session-1')

    staleSocket?.onclose?.(4000)
    // A short window proves the stale close scheduled nothing (any
    // late-scheduled reconnect fires within the 1s backoff bound). A long
    // advance would hit the live socket's heartbeat-miss fallback — which
    // legitimately reconnects a socket whose acks never arrive.
    await vi.advanceTimersByTimeAsync(1_000)
    await h.flush()
    expect(h.sockets).toHaveLength(2)
    expect(h.backoffs).toHaveLength(1)
    gateway.dispose()
  })

  it('resolves the token again on every connection attempt', async () => {
    const h = createHarness()
    const { startGateway } = await import('../src/gateway/gateway.js')
    const gateway = startGateway(h.options)
    await h.flush()

    h.openAndHello()
    h.ready()
    h.currentSocket().onclose?.(4000)
    await vi.advanceTimersByTimeAsync(1_000)
    await h.flush()
    h.openAndHello()
    expect(h.tokenProvider).toHaveBeenCalledTimes(2)
    gateway.dispose()
  })

  it('drops malformed frames without throwing or leaving the dispatch loop', async () => {
    const h = createHarness()
    const { startGateway } = await import('../src/gateway/gateway.js')
    const gateway = startGateway(h.options)
    await h.flush()

    h.openAndHello()
    h.ready()
    for (const frame of ['not-json', JSON.stringify({ op: 'x' }), JSON.stringify(null), '{}']) {
      expect(() => h.currentSocket().onmessage?.(frame)).not.toThrow()
    }
    h.currentSocket().onmessage?.(JSON.stringify({ t: 'MESSAGE_CREATE', s: 3, op: 0, d: {} }))
    expect(h.dispatches).toHaveLength(2)
    expect(h.dispatches.at(-1)).toEqual({ t: 'MESSAGE_CREATE', s: 3, op: 0, d: {} })
    gateway.dispose()
  })

  it('dispose cancels timers, closes the socket, and accepts nothing further', async () => {
    const h = createHarness()
    const { startGateway } = await import('../src/gateway/gateway.js')
    const gateway = startGateway(h.options)
    await h.flush()

    h.openAndHello()
    h.ready()
    const dispatchCount = h.dispatches.length
    gateway.dispose()
    expect(h.currentSocket().closed.length).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(120_000)
    await h.flush()
    expect(h.sockets).toHaveLength(1)

    h.currentSocket().onmessage?.(JSON.stringify({ t: 'MESSAGE_CREATE', s: 3, op: 0, d: {} }))
    expect(h.dispatches).toHaveLength(dispatchCount)
    h.currentSocket().onclose?.(4000)
    await vi.advanceTimersByTimeAsync(120_000)
    await h.flush()
    expect(h.sockets).toHaveLength(1)
  })
})
