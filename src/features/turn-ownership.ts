/**
 * Adapter-owned active Turn tracking (design.md §6, task 9.4). Discord owns a
 * Turn only through its durable submitted request ID — a session that is
 * merely running (DSH Web, an external submitter) grants no control. The
 * tracker keeps one active turn per session: later submissions queue without
 * taking ownership, and a completed turn stops being controllable until the
 * next adapter submission registers.
 */

export interface RegisteredTurn {
  sessionId: string
  requestId: string
  threadId: string
}

export type RegisterResult =
  | { ok: true }
  | { ok: false; error: 'turn-already-active' }

export type ControlDecision =
  | { allowed: true; requestId: string }
  | { allowed: false; reason: 'not-adapter-owned' | 'no-active-turn' }

export interface TurnTracker {
  register(turn: RegisteredTurn): RegisterResult
  complete(requestId: string): void
  authorizeControl(input: {
    sessionId: string
    threadId: string
    /** Whether DSH reports the session as running; running alone grants nothing. */
    sessionRunning?: boolean | undefined
  }): ControlDecision
  /** The active turn for a session, if the adapter owns one. */
  active(sessionId: string): RegisteredTurn | undefined
}

export function createTurnTracker(): TurnTracker {
  const activeTurns = new Map<string, RegisteredTurn>()

  return {
    register(turn) {
      const existing = activeTurns.get(turn.sessionId)
      if (existing !== undefined) return { ok: false, error: 'turn-already-active' }
      activeTurns.set(turn.sessionId, turn)
      return { ok: true }
    },
    complete(requestId) {
      for (const [sessionId, turn] of activeTurns) {
        if (turn.requestId === requestId) activeTurns.delete(sessionId)
      }
    },
    authorizeControl({ sessionId, threadId, sessionRunning }) {
      const turn = activeTurns.get(sessionId)
      if (turn === undefined) {
        // A running session the adapter never submitted belongs to someone
        // else (DSH Web); with no turn at all there is simply nothing to control.
        return sessionRunning === true
          ? { allowed: false, reason: 'not-adapter-owned' }
          : { allowed: false, reason: 'no-active-turn' }
      }
      if (turn.threadId !== threadId) return { allowed: false, reason: 'not-adapter-owned' }
      return { allowed: true, requestId: turn.requestId }
    },
    active: sessionId => activeTurns.get(sessionId),
  }
}
