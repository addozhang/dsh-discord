/**
 * `/steer` control tests (9.5): steering is allowed only for the calling
 * thread's OWNED active turn — established by request-ID ownership, never by
 * running status. A late steer (turn already finished) and a foreign thread
 * are refused as values, and DSH outcomes propagate untouched.
 */

import { describe, expect, it, vi } from 'vitest'

import { createTurnTracker } from '../src/features/turn-ownership.js'
import { planSteer, type DshSteerPort } from '../src/features/steer-control.js'

const SESSION = 'sess-1'
const THREAD = 'thread-1'

function setup() {
  const tracker = createTurnTracker()
  const steer = vi.fn((_request: { sessionId: string; requestId: string; prompt: string }): ReturnType<DshSteerPort['steer']> =>
    Promise.resolve({ outcome: 'accepted' }))
  const port: DshSteerPort = { steer }
  return { tracker, steer, port }
}

describe('/steer', () => {
  it('steers the owned active turn with the submitted request id', async () => {
    const { tracker, steer, port } = setup()
    tracker.register({ sessionId: SESSION, requestId: 'req-1', threadId: THREAD })

    const result = await planSteer(port, tracker, {
      sessionId: SESSION,
      threadId: THREAD,
      prompt: 'focus on the parser',
    })
    expect(result).toEqual({ outcome: 'accepted' })
    expect(steer.mock.calls[0]?.[0]).toEqual({
      sessionId: SESSION,
      requestId: 'req-1',
      prompt: 'focus on the parser',
    })
  })

  it('refuses a late steer after the turn finished', async () => {
    const { tracker, steer, port } = setup()
    tracker.register({ sessionId: SESSION, requestId: 'req-1', threadId: THREAD })
    tracker.complete('req-1')

    const result = await planSteer(port, tracker, { sessionId: SESSION, threadId: THREAD, prompt: 'late' })
    expect(result).toEqual({ outcome: 'refused', reason: 'no-active-turn' })
    expect(steer).not.toHaveBeenCalled()
  })

  it('refuses a thread that does not own the turn', async () => {
    const { tracker, steer, port } = setup()
    tracker.register({ sessionId: SESSION, requestId: 'req-1', threadId: THREAD })

    const result = await planSteer(port, tracker, { sessionId: SESSION, threadId: 'thread-other', prompt: 'hi' })
    expect(result).toEqual({ outcome: 'refused', reason: 'not-authorized' })
    expect(steer).not.toHaveBeenCalled()
  })

  it('propagates DSH rejection and unknown outcomes as values', async () => {
    const rejecting = setup()
    rejecting.steer.mockReturnValue(Promise.resolve({ outcome: 'rejected', reason: 'not-steerable' }))
    rejecting.tracker.register({ sessionId: SESSION, requestId: 'req-1', threadId: THREAD })
    expect(await planSteer(rejecting.port, rejecting.tracker, { sessionId: SESSION, threadId: THREAD, prompt: 'x' }))
      .toEqual({ outcome: 'rejected' })

    const unknown = setup()
    unknown.steer.mockReturnValue(Promise.resolve({ outcome: 'unknown' }))
    unknown.tracker.register({ sessionId: SESSION, requestId: 'req-9', threadId: THREAD })
    expect(await planSteer(unknown.port, unknown.tracker, { sessionId: SESSION, threadId: THREAD, prompt: 'x' }))
      .toEqual({ outcome: 'unknown' })
  })
})
