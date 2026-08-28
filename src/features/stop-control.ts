/**
 * `/stop` (design.md §5, task 9.6). Stopping cancels only the calling
 * thread's OWNED active turn — the same request-ID ownership as steering.
 * The cancel request carries no purge semantics: DSH preserves the session's
 * pending inbox, so queued prompts survive a stop. After any cancel attempt
 * the turn is terminal for the adapter (duplicates and late stops refuse
 * locally), and DSH outcomes surface as plain values.
 */

import type { TurnTracker } from './turn-ownership.js'

export interface DshCancelPort {
  cancel(request: { sessionId: string; requestId: string }): Promise<
    | { outcome: 'accepted'; pendingPreserved: boolean }
    | { outcome: 'rejected'; reason: string }
    | { outcome: 'unknown' }
  >
}

export type StopResult =
  | { outcome: 'cancelled'; pendingPreserved: boolean }
  | { outcome: 'rejected' }
  | { outcome: 'unknown' }
  | { outcome: 'refused'; reason: 'no-active-turn' | 'not-authorized' }

export async function planStop(
  port: DshCancelPort,
  tracker: TurnTracker,
  request: { sessionId: string; threadId: string },
): Promise<StopResult> {
  const control = tracker.authorizeControl({ sessionId: request.sessionId, threadId: request.threadId })
  if (!control.allowed) {
    return {
      outcome: 'refused',
      reason: control.reason === 'no-active-turn' ? 'no-active-turn' : 'not-authorized',
    }
  }

  const cancelled = await port.cancel({
    sessionId: request.sessionId,
    requestId: control.requestId,
  })

  // The turn is terminal for this thread regardless of the wire outcome:
  // after an accepted, rejected, or unknown cancel there is no controllable
  // active turn left, so a duplicate or late stop refuses locally.
  tracker.complete(control.requestId)

  if (cancelled.outcome === 'accepted') {
    return { outcome: 'cancelled', pendingPreserved: cancelled.pendingPreserved }
  }
  if (cancelled.outcome === 'unknown') return { outcome: 'unknown' }
  return { outcome: 'rejected' }
}
