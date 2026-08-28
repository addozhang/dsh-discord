/**
 * `/stop` control tests (9.6): stopping cancels only the calling thread's
 * OWNED active turn, preserves the session's queued inbox (the request shape
 * carries no purge semantics), collapses duplicates and late stops into local
 * refusals without another DSH call, and propagates DSH outcomes as values.
 */

import { describe, expect, it, vi } from 'vitest'

import { createTurnTracker } from '../src/features/turn-ownership.js'
import { planStop, type DshCancelPort } from '../src/features/stop-control.js'

const SESSION = 'sess-1'
const THREAD = 'thread-1'

function setup(cancel?: DshCancelPort['cancel']) {
  const tracker = createTurnTracker()
  const cancelFn = vi.fn((_request: { sessionId: string; requestId: string }): ReturnType<DshCancelPort['cancel']> =>
    cancel !== undefined ? cancel({ sessionId: _request.sessionId, requestId: _request.requestId }) : Promise.resolve({ outcome: 'accepted', pendingPreserved: true }))
  const port: DshCancelPort = { cancel: cancelFn }
  return { tracker, cancelFn, port }
}

describe('/stop', () => {
  it('cancels the owned active turn and preserves the queued inbox', async () => {
    const { tracker, cancelFn, port } = setup()
    tracker.register({ sessionId: SESSION, requestId: 'req-1', threadId: THREAD })

    const result = await planStop(port, tracker, { sessionId: SESSION, threadId: THREAD })
    expect(result).toEqual({ outcome: 'cancelled', pendingPreserved: true })
    expect(cancelFn.mock.calls[0]?.[0]).toEqual({ sessionId: SESSION, requestId: 'req-1' })
    // The turn is terminal: no further control.
    expect(tracker.authorizeControl({ sessionId: SESSION, threadId: THREAD }).allowed).toBe(false)
  })

  it('refuses a duplicate stop locally without another DSH call', async () => {
    const { tracker, cancelFn, port } = setup()
    tracker.register({ sessionId: SESSION, requestId: 'req-1', threadId: THREAD })
    await planStop(port, tracker, { sessionId: SESSION, threadId: THREAD })

    const duplicate = await planStop(port, tracker, { sessionId: SESSION, threadId: THREAD })
    expect(duplicate).toEqual({ outcome: 'refused', reason: 'no-active-turn' })
    expect(cancelFn).toHaveBeenCalledTimes(1)
  })

  it('refuses a late stop when the turn already finished', async () => {
    const { tracker, cancelFn, port } = setup()
    tracker.register({ sessionId: SESSION, requestId: 'req-1', threadId: THREAD })
    tracker.complete('req-1')

    const result = await planStop(port, tracker, { sessionId: SESSION, threadId: THREAD })
    expect(result).toEqual({ outcome: 'refused', reason: 'no-active-turn' })
    expect(cancelFn).not.toHaveBeenCalled()
  })

  it('refuses a thread that does not own the turn', async () => {
    const { tracker, cancelFn, port } = setup()
    tracker.register({ sessionId: SESSION, requestId: 'req-1', threadId: THREAD })

    const result = await planStop(port, tracker, { sessionId: SESSION, threadId: 'thread-other' })
    expect(result).toEqual({ outcome: 'refused', reason: 'not-authorized' })
    expect(cancelFn).not.toHaveBeenCalled()
  })

  it('propagates DSH rejection and unknown outcomes as values', async () => {
    const rejected = setup(() => Promise.resolve({ outcome: 'rejected', reason: 'not-cancellable' }))
    rejected.tracker.register({ sessionId: SESSION, requestId: 'req-1', threadId: THREAD })
    expect(await planStop(rejected.port, rejected.tracker, { sessionId: SESSION, threadId: THREAD }))
      .toEqual({ outcome: 'rejected' })

    const unknown = setup(() => Promise.resolve({ outcome: 'unknown' }))
    unknown.tracker.register({ sessionId: SESSION, requestId: 'req-2', threadId: THREAD })
    expect(await planStop(unknown.port, unknown.tracker, { sessionId: SESSION, threadId: THREAD }))
      .toEqual({ outcome: 'unknown' })
  })
})
