/**
 * `/steer <prompt>` (design.md §5, task 9.5). Steering submits
 * `mode: 'steer'` against the calling thread's OWNED active turn — the
 * ownership comes from the turn tracker's request-ID registration, never
 * from a session's running status. Late steers and foreign threads are
 * refused locally without a DSH call.
 */

import type { TurnTracker } from './turn-ownership.js'

export interface DshSteerPort {
  steer(request: { sessionId: string; requestId: string; prompt: string }): Promise<
    | { outcome: 'accepted' }
    | { outcome: 'rejected'; reason: string }
    | { outcome: 'unknown' }
  >
}

export type SteerResult =
  | { outcome: 'accepted' }
  | { outcome: 'rejected' }
  | { outcome: 'unknown' }
  | { outcome: 'refused'; reason: 'no-active-turn' | 'not-authorized' }

export async function planSteer(
  port: DshSteerPort,
  tracker: TurnTracker,
  request: { sessionId: string; threadId: string; prompt: string },
): Promise<SteerResult> {
  const control = tracker.authorizeControl({ sessionId: request.sessionId, threadId: request.threadId })
  if (!control.allowed) {
    // Map the tracker's ownership facts onto caller-facing refusals: a
    // foreign-owned turn is simply not authorized for this thread.
    return {
      outcome: 'refused',
      reason: control.reason === 'no-active-turn' ? 'no-active-turn' : 'not-authorized',
    }
  }

  const steered = await port.steer({
    sessionId: request.sessionId,
    requestId: control.requestId,
    prompt: request.prompt,
  })
  if (steered.outcome === 'accepted') return { outcome: 'accepted' }
  if (steered.outcome === 'unknown') return { outcome: 'unknown' }
  return { outcome: 'rejected' }
}
