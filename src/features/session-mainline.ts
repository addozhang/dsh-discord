/**
 * The session mainline (Phase 1 composition): the one orchestrator both
 * Discord ingress paths share. `admitMention` walks a bound-channel mention
 * through intent claim → thread creation → session creation → at-most-once
 * prompt → adapter-owned turn registration; `continueInThread` queues every
 * later Thread message through the same idempotent prompt flow. Each step's
 * outcome surfaces as a value so the Discord layer can answer honestly —
 * nothing here retries or invents a fourth state.
 */

import type { createThreadCreationFlow, ThreadCreationResult } from './thread-creation.js'
import type { createSessionCreationFlow, SessionCreationResult } from './session-creation.js'
import type { createPromptSubmissionFlow, PromptSubmissionResult } from './prompt-submission.js'
import type { TurnTracker } from './turn-ownership.js'
import type { DiscordAttachment } from '../gateway/inbound.js'
import { hashPayload } from '../state/intents.js'
import { safeTitle } from '../policy/disclosure.js'

export interface SessionMainlineDeps {
  threads: ReturnType<typeof createThreadCreationFlow>
  sessions: ReturnType<typeof createSessionCreationFlow>
  prompts: ReturnType<typeof createPromptSubmissionFlow>
  turns: TurnTracker
}

export type MentionMainlineResult =
  | { outcome: 'admitted'; threadId: string; sessionId: string }
  | { outcome: 'thread-conflict' }
  | { outcome: 'thread-failed' }
  | { outcome: 'session-rejected' }
  | { outcome: 'session-unknown' }
  | { outcome: 'prompt-rejected' }
  | { outcome: 'prompt-unknown' }

export interface MentionMainlineRequest {
  applicationId: string
  guildId: string
  /** The bound project channel the mention arrived in. */
  channelId: string
  messageId: string
  authorId: string
  workspaceId: string
  prompt: string
  images?: DiscordAttachment[]
}

export type ContinuationMainlineResult =
  | { outcome: 'queued' }
  | { outcome: 'already-submitted' }
  | { outcome: 'conflict' }
  | { outcome: 'rejected' }
  | { outcome: 'unknown' }

export interface ContinuationMainlineRequest {
  applicationId: string
  guildId: string
  threadId: string
  sessionId: string
  messageId: string
  prompt: string
  images?: DiscordAttachment[]
}

/**
 * The stable, adapter-owned request id for a submitted prompt: derived from
 * the Discord message id, recorded on the intent before the DSH call, and
 * echoed by the Host onto the durable `user/message` (`source.rpcId`).
 */
export function requestIdFor(messageId: string): string {
  return `discord:${messageId}`
}

/** Register the turn after an accepted submission; a second claim is a no-op. */
function ownTurn(deps: SessionMainlineDeps, turn: { sessionId: string; requestId: string; threadId: string }): void {
  deps.turns.register(turn)
}

function mapSubmission(result: PromptSubmissionResult): ContinuationMainlineResult {
  if (result.outcome === 'accepted') return { outcome: 'queued' }
  if (result.outcome === 'already-submitted') return { outcome: 'already-submitted' }
  if (result.outcome === 'conflict') return { outcome: 'conflict' }
  return result.outcome === 'rejected' ? { outcome: 'rejected' } : { outcome: 'unknown' }
}

export function createSessionMainline(deps: SessionMainlineDeps): {
  admitMention(request: MentionMainlineRequest): Promise<MentionMainlineResult>
  continueInThread(request: ContinuationMainlineRequest): Promise<ContinuationMainlineResult>
} {
  return {
    async admitMention(request) {
      // The source message id is the durable intent: one thread per message,
      // deterministic recovery on redelivery (design.md §4, §10).
      const thread: ThreadCreationResult = await deps.threads.ensureThread({
        sourceMessageId: request.messageId,
        contentHash: await hashPayload({ prompt: request.prompt }),
        guildId: request.guildId,
        parentChannelId: request.channelId,
        threadName: safeTitle(request.prompt),
        creatorUserId: request.authorId,
      })
      if (thread.outcome === 'conflict') return { outcome: 'thread-conflict' }
      if (thread.outcome !== 'created' && thread.outcome !== 'recovered') {
        return { outcome: 'thread-failed' }
      }
      const threadId = thread.threadId

      const scope = { applicationId: request.applicationId, guildId: request.guildId, threadId }
      const session: SessionCreationResult = await deps.sessions.ensureSession({
        scope,
        workspaceId: request.workspaceId,
        createdBy: request.authorId,
        nowMs: Date.now(),
      })
      if (session.outcome === 'rejected') return { outcome: 'session-rejected' }
      if (session.outcome === 'unknown') return { outcome: 'session-unknown' }
      const sessionId = session.sessionId

      const requestId = requestIdFor(request.messageId)
      const submitted = await deps.prompts.submitOnce({
        requestId,
        sessionId,
        prompt: request.prompt,
        ...(request.images !== undefined ? { images: request.images } : {}),
      })
      if (submitted.outcome === 'accepted') {
        ownTurn(deps, { sessionId, requestId, threadId })
        return { outcome: 'admitted', threadId, sessionId }
      }
      // A replay lands here with `already-submitted`: the binding and thread
      // still exist, so the visible state is identical to the first admit.
      if (submitted.outcome === 'already-submitted') {
        return { outcome: 'admitted', threadId, sessionId }
      }
      if (submitted.outcome === 'conflict') return { outcome: 'thread-conflict' }
      return submitted.outcome === 'rejected' ? { outcome: 'prompt-rejected' } : { outcome: 'prompt-unknown' }
    },

    async continueInThread(request) {
      const requestId = requestIdFor(request.messageId)
      const submitted = await deps.prompts.submitOnce({
        requestId,
        sessionId: request.sessionId,
        prompt: request.prompt,
        ...(request.images !== undefined ? { images: request.images } : {}),
      })
      if (submitted.outcome === 'accepted') {
        ownTurn(deps, { sessionId: request.sessionId, requestId, threadId: request.threadId })
      }
      return mapSubmission(submitted)
    },
  }
}
