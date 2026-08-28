/**
 * Cold session adoption (design.md §13, task 9.2). Resuming a
 * not-currently-bound session adopts it into ONE new writable Discord
 * thread: ownership is claimed, thread→session is bound durably, and a
 * bounded slice of recent history is shown — the model is never prompted by
 * adoption itself. Subagent sessions are not adoptable; a session that
 * cannot be inspected refuses before anything is created.
 */

import type { BindingStore } from '../state/bindings.js'
import type { ThreadBinding } from '../state/records.js'
import { threadBindingKey } from '../state/domain.js'
import type { SessionOwnerStore } from '../state/session-owners.js'

export interface InspectedSession {
  sessionId: string
  workspaceId: string
  archived: boolean
  isSubagent: boolean
  history: ReadonlyArray<{ index: number; role: string }>
}

export interface DshSessionInspectPort {
  inspect(request: { sessionId: string }): Promise<
    | { outcome: 'found'; session: InspectedSession }
    | { outcome: 'not-found' }
    | { outcome: 'failed' }
    | { outcome: 'unknown' }
  >
}

export interface DiscordThreadPort {
  createThread(request: { parentChannelId: string; name: string }): Promise<
    | { outcome: 'completed'; threadId: string }
    | { outcome: 'failed' }
    | { outcome: 'unknown' }
  >
  findThreadBySource(sourceMessageId: string): Promise<{ outcome: 'found'; threadId: string } | { outcome: 'not-found' }>
}

/** Bounded recent history shown on adoption (design.md §13: bounded display). */
export const ADOPTION_HISTORY_LIMIT = 10

export interface SessionAdoptionDeps {
  sessions: DshSessionInspectPort
  discord: DiscordThreadPort
  threadBindings: BindingStore<ThreadBinding>
  owners: SessionOwnerStore
  nowMs: () => number
}

export type SessionAdoptionResult =
  | {
      outcome: 'adopted'
      threadId: string
      sessionId: string
      workspaceId: string
      /** Recent history, oldest → newest, capped at the display limit. */
      history: InspectedSession['history']
    }
  | { outcome: 'refused'; reason: 'subagent-not-adoptable' | 'session-disappeared' }
  | { outcome: 'conflict'; ownedByThreadId: string }
  | { outcome: 'failed' }
  | { outcome: 'unknown' }

export function createSessionAdoptionFlow(deps: SessionAdoptionDeps): {
  adopt(request: { sessionId: string; guildId: string; parentChannelId: string; createdBy: string }): Promise<SessionAdoptionResult>
} {
  return {
    async adopt(request) {
      const inspected = await deps.sessions.inspect({ sessionId: request.sessionId })
      if (inspected.outcome === 'not-found') {
        return { outcome: 'refused', reason: 'session-disappeared' }
      }
      if (inspected.outcome === 'failed') return { outcome: 'failed' }
      if (inspected.outcome === 'unknown') return { outcome: 'unknown' }

      if (inspected.session.isSubagent) {
        return { outcome: 'refused', reason: 'subagent-not-adoptable' }
      }

      // Claim ownership BEFORE creating the thread: a session already owned
      // by another thread conflicts explicitly — never an implicit takeover.
      const ownership = await deps.owners.claim({
        sessionId: request.sessionId,
        threadId: `pending:${request.sessionId}`,
        guildId: request.guildId,
        claimedAtMs: deps.nowMs(),
      })
      if (ownership.outcome === 'conflict') {
        return { outcome: 'conflict', ownedByThreadId: ownership.record.threadId }
      }
      const owningThread = ownership.outcome === 'claimed'
        ? ownership.record.threadId
        : ownership.record.threadId

      const created = await deps.discord.createThread({
        parentChannelId: request.parentChannelId,
        name: `Resume: ${request.sessionId}`,
      })
      if (created.outcome !== 'completed') {
        // Release the pending ownership so a retry can claim cleanly.
        await deps.owners.release({ sessionId: request.sessionId, threadId: owningThread })
        return created.outcome === 'failed' ? { outcome: 'failed' } : { outcome: 'unknown' }
      }

      // Re-key ownership from the pending marker to the real thread id.
      await deps.owners.release({ sessionId: request.sessionId, threadId: owningThread })
      const owned = await deps.owners.claim({
        sessionId: request.sessionId,
        threadId: created.threadId,
        guildId: request.guildId,
        claimedAtMs: deps.nowMs(),
      })
      if (owned.outcome === 'conflict') {
        return { outcome: 'failed' }
      }

      const bound = await deps.threadBindings.bind(
        threadBindingKey({ applicationId: 'app', guildId: request.guildId, threadId: created.threadId }),
        {
          sessionId: request.sessionId,
          workspaceId: inspected.session.workspaceId,
          createdBy: request.createdBy,
          createdAtMs: deps.nowMs(),
        },
      )
      if (!bound.ok) return { outcome: 'failed' }

      return {
        outcome: 'adopted',
        threadId: created.threadId,
        sessionId: request.sessionId,
        workspaceId: inspected.session.workspaceId,
        history: inspected.session.history.slice(-ADOPTION_HISTORY_LIMIT),
      }
    },
  }
}
