/**
 * Turn ownership tests (9.4). Discord owns a Turn only when its durable user
 * message carries the adapter's submitted request ID, registered in the
 * tracker with the owning thread. A session that is merely `running` —
 * started from DSH Web or anywhere else — grants NO steer/stop authority,
 * and ownership never crosses threads. Finished turns stop being controllable.
 */

import { describe, expect, it } from 'vitest'

import { createTurnTracker } from '../src/features/turn-ownership.js'

const SESSION = 'sess-1'
const THREAD = 'thread-1'

describe('turn ownership tracker', () => {
  it('allows control for the owning thread after an adapter submission', () => {
    const tracker = createTurnTracker()
    tracker.register({ sessionId: SESSION, requestId: 'req-1', threadId: THREAD })

    const decision = tracker.authorizeControl({ sessionId: SESSION, threadId: THREAD })
    expect(decision).toEqual({ allowed: true, requestId: 'req-1' })
  })

  it('rejects control based only on running status without an adapter request', () => {
    const tracker = createTurnTracker()
    const decision = tracker.authorizeControl({ sessionId: SESSION, threadId: THREAD, sessionRunning: true })
    expect(decision).toEqual({ allowed: false, reason: 'not-adapter-owned' })
  })

  it('never lets another thread control someone else’s turn', () => {
    const tracker = createTurnTracker()
    tracker.register({ sessionId: SESSION, requestId: 'req-1', threadId: THREAD })

    const decision = tracker.authorizeControl({ sessionId: SESSION, threadId: 'thread-other' })
    expect(decision).toEqual({ allowed: false, reason: 'not-adapter-owned' })
  })

  it('stops granting control once the turn completes', () => {
    const tracker = createTurnTracker()
    tracker.register({ sessionId: SESSION, requestId: 'req-1', threadId: THREAD })
    tracker.complete('req-1')

    expect(tracker.authorizeControl({ sessionId: SESSION, threadId: THREAD }))
      .toEqual({ allowed: false, reason: 'no-active-turn' })
  })

  it('tracks one active turn per session; later submissions queue without taking ownership', () => {
    const tracker = createTurnTracker()
    tracker.register({ sessionId: SESSION, requestId: 'req-1', threadId: THREAD })
    const second = tracker.register({ sessionId: SESSION, requestId: 'req-2', threadId: THREAD })

    expect(second).toEqual({ ok: false, error: 'turn-already-active' })
    // The FIRST turn keeps ownership.
    expect(tracker.authorizeControl({ sessionId: SESSION, threadId: THREAD }))
      .toEqual({ allowed: true, requestId: 'req-1' })

    tracker.complete('req-1')
    tracker.register({ sessionId: SESSION, requestId: 'req-2', threadId: THREAD })
    expect(tracker.authorizeControl({ sessionId: SESSION, threadId: THREAD }))
      .toEqual({ allowed: true, requestId: 'req-2' })
  })

  it('fails a turn with the reason preserved', () => {
    const tracker = createTurnTracker()
    tracker.register({ sessionId: SESSION, requestId: 'req-1', threadId: THREAD })
    tracker.complete('req-1')
    expect(tracker.authorizeControl({ sessionId: SESSION, threadId: THREAD }).allowed).toBe(false)
  })
})
