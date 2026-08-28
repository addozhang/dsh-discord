/**
 * Interaction response lifecycle: Discord grants one callback within the ack
 * deadline (3s) and a webhook token with a bounded lifetime. The lifecycle is
 * a small state machine over that budget — fresh → responded, or fresh →
 * deferred → follow-ups — and every violation is a value, never a throw:
 * double responses, past-deadline callbacks, and expired tokens all refuse
 * locally without touching the wire.
 */

import { describe, expect, it, vi } from 'vitest'

import { createInteractionSession, type InteractionWire } from '../src/discord/interaction-lifecycle.js'

function wireStub() {
  const calls: { kind: 'callback' | 'followUp'; body: unknown }[] = []
  const wire: InteractionWire = {
    callback: (body) => {
      calls.push({ kind: 'callback', body })
      return Promise.resolve({ outcome: 'completed', status: 204, body: undefined })
    },
    followUp: (body) => {
      calls.push({ kind: 'followUp', body })
      return Promise.resolve({ outcome: 'completed', status: 200, body: { id: 'msg' } })
    },
  }
  return { wire, calls }
}

function fixedClock(startMs = 1_000_000) {
  let now = startMs
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

const ACK_DEADLINE_MS = 3_000
const TOKEN_LIFETIME_MS = 15 * 60_000

function createSession(wire: InteractionWire, clock = fixedClock()) {
  return createInteractionSession(
    wire,
    { ackDeadlineMs: ACK_DEADLINE_MS, tokenLifetimeMs: TOKEN_LIFETIME_MS, now: clock.now },
  )
}

describe('interaction lifecycle', () => {
  it('responds once with an ephemeral callback and refuses a second response', async () => {
    const { wire, calls } = wireStub()
    const session = createSession(wire)

    const first = await session.respond({ content: 'hi' })
    expect(first.ok).toBe(true)
    expect(calls).toEqual([{
      kind: 'callback',
      body: { type: 4, data: { content: 'hi', flags: 64 } },
    }])

    const second = await session.respond({ content: 'again' })
    expect(second).toEqual({ ok: false, error: 'already-acknowledged' })
    expect(calls).toHaveLength(1)
  })

  it('defers with an ephemeral callback and then allows follow-ups', async () => {
    const { wire, calls } = wireStub()
    const session = createSession(wire)

    const deferred = await session.defer()
    expect(deferred.ok).toBe(true)
    expect(calls).toEqual([{
      kind: 'callback',
      body: { type: 5, data: { flags: 64 } },
    }])

    const followUp = await session.followUp({ content: 'done later' })
    expect(followUp.ok).toBe(true)
    expect(calls[1]).toEqual({
      kind: 'followUp',
      body: { content: 'done later', flags: 64 },
    })
  })

  it('refuses a callback after the ack deadline without touching the wire', async () => {
    const { wire, calls } = wireStub()
    const clock = fixedClock()
    const session = createSession(wire, clock)

    clock.advance(ACK_DEADLINE_MS + 1)
    const result = await session.respond({ content: 'too late' })
    expect(result).toEqual({ ok: false, error: 'past-ack-deadline' })
    expect(calls).toHaveLength(0)

    const deferredLate = await session.defer()
    expect(deferredLate).toEqual({ ok: false, error: 'past-ack-deadline' })
    expect(calls).toHaveLength(0)
  })

  it('refuses follow-ups after the webhook token expires', async () => {
    const { wire, calls } = wireStub()
    const clock = fixedClock()
    const session = createSession(wire, clock)

    await session.defer()
    clock.advance(TOKEN_LIFETIME_MS + 1)
    const result = await session.followUp({ content: 'stale' })
    expect(result).toEqual({ ok: false, error: 'token-expired' })
    expect(calls).toHaveLength(1)
  })

  it('maps a wire-side unknown-interaction rejection to token-expired', async () => {
    const respondingWire: InteractionWire = {
      callback: () => Promise.resolve({
        outcome: 'rejected',
        status: 404,
        error: { code: 10062, message: 'Unknown interaction' },
      }),
      followUp: () => Promise.resolve({ outcome: 'completed', status: 200, body: {} }),
    }
    const session = createSession(respondingWire)
    const responded = await session.respond({ content: 'hi' })
    expect(responded).toEqual({ ok: false, error: 'token-expired' })

    const followingWire: InteractionWire = {
      callback: () => Promise.resolve({ outcome: 'completed', status: 204, body: undefined }),
      followUp: () => Promise.resolve({
        outcome: 'rejected',
        status: 404,
        error: { code: 10062, message: 'Unknown interaction' },
      }),
    }
    const deferredSession = createSession(followingWire)
    await deferredSession.defer()
    const followUp = await deferredSession.followUp({ content: 'x' })
    expect(followUp).toEqual({ ok: false, error: 'token-expired' })
  })

  it('propagates wire unknown outcomes without inventing success', async () => {
    const respondingWire: InteractionWire = {
      callback: () => Promise.resolve({ outcome: 'unknown', reason: 'network-unreachable' }),
      followUp: () => Promise.resolve({ outcome: 'completed', status: 200, body: {} }),
    }
    const session = createSession(respondingWire)
    await expect(session.respond({ content: 'x' })).resolves.toEqual({
      ok: false,
      error: 'wire-unknown',
      detail: 'network-unreachable',
    })

    const followingWire: InteractionWire = {
      callback: () => Promise.resolve({ outcome: 'completed', status: 204, body: undefined }),
      followUp: () => Promise.resolve({ outcome: 'unknown', reason: 'aborted' }),
    }
    const deferredSession = createSession(followingWire)
    await deferredSession.defer()
    await expect(deferredSession.followUp({ content: 'x' })).resolves.toEqual({
      ok: false,
      error: 'wire-unknown',
      detail: 'aborted',
    })
  })

  it('refuses follow-up before any acknowledgement', async () => {
    const { wire, calls } = wireStub()
    const session = createSession(wire)
    const result = await session.followUp({ content: 'early' })
    expect(result).toEqual({ ok: false, error: 'not-acknowledged' })
    expect(calls).toHaveLength(0)
  })

  it('deadline defaults to 3s and the checks stay pure under vi fake time', async () => {
    const { wire, calls } = wireStub()
    vi.useFakeTimers()
    try {
      const base = Date.now()
      let now = base
      const session = createInteractionSession(
        wire,
        { now: () => now },
      )
      now = base + ACK_DEADLINE_MS
      const result = await session.respond({ content: 'x' })
      expect(result.ok).toBe(true)
      expect(calls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
