/**
 * DSH session creation for a new thread (design.md §10, task 8.3). The
 * adapter preallocates the session id and hands it to `session.create`, so
 * DSH can adopt the same id idempotently after an uncertain response. Success
 * binds the thread durably (single writable owner); a bound thread replays
 * its existing session without any DSH call; rejection and unknown outcomes
 * leave the thread unbound — reconciliation, never blind retry, decides what
 * actually happened.
 */

import { threadBindingKey, type ThreadBindingScope } from '../state/domain.js'
import type { BindingStore } from '../state/bindings.js'
import type { ThreadBinding } from '../state/records.js'

/** The DSH session-creation surface the flow needs. */
export interface DshSessionPort {
  createSession(request: { sessionId: string; workspaceId: string }): Promise<
    | { outcome: 'completed'; sessionId: string }
    | { outcome: 'rejected'; reason: string }
    | { outcome: 'unknown' }
  >
}

export interface SessionCreationDeps {
  sessions: DshSessionPort
  threadBindings: BindingStore<ThreadBinding>
  /** Preallocation source for session ids (design.md §10). */
  newSessionId: () => string
}

export type SessionCreationResult =
  | { outcome: 'created'; sessionId: string }
  | { outcome: 'rejected' }
  | { outcome: 'unknown' }

export function createSessionCreationFlow(deps: SessionCreationDeps): {
  ensureSession(request: {
    scope: ThreadBindingScope
    workspaceId: string
    createdBy: string
    nowMs: number
  }): Promise<SessionCreationResult>
} {
  return {
    async ensureSession(request) {
      const key = threadBindingKey(request.scope)

      // Replay or crash-recovery: an existing binding IS the answer.
      const existing = deps.threadBindings.get(key)
      if (existing !== undefined) {
        return { outcome: 'created', sessionId: existing.sessionId }
      }

      const preallocatedId = deps.newSessionId()
      const created = await deps.sessions.createSession({
        sessionId: preallocatedId,
        workspaceId: request.workspaceId,
      })

      if (created.outcome === 'completed') {
        const bound = await deps.threadBindings.bind(key, {
          sessionId: created.sessionId,
          workspaceId: request.workspaceId,
          createdBy: request.createdBy,
          createdAtMs: request.nowMs,
        })
        if (!bound.ok) {
          // Lost a bind race to a concurrent creator: its session wins.
          const winner = deps.threadBindings.get(key)
          return { outcome: 'created', sessionId: winner?.sessionId ?? created.sessionId }
        }
        return { outcome: 'created', sessionId: created.sessionId }
      }

      // Rejection and unknown: stay unbound, report the outcome as a value.
      return created.outcome === 'rejected' ? { outcome: 'rejected' } : { outcome: 'unknown' }
    },
  }
}
