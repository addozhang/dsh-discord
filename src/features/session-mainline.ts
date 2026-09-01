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
import type { createPromptSubmissionFlow, PromptRequestImage, PromptSubmissionResult } from './prompt-submission.js'
import type { TurnTracker } from './turn-ownership.js'
import { hashPayload } from '../state/intents.js'
import { safeTitle } from '../policy/disclosure.js'

/** Declared image metadata as carried on the normalized wire message. */
export interface MainlineWireImage {
  url: string
  filename: string
  declaredSize: number
  contentType: string
}

/** One collected image, ready for submission. */
export type MainlineImage = PromptRequestImage

/**
 * The bounded collection boundary (design.md §12, 16.50): declared wire
 * metadata goes in, base64-encoded images come out. The composition root
 * implements it over the safe-download boundary — this layer never touches
 * the network itself.
 */
export interface MainlineImageCollector {
  collect(request: {
    attachments: ReadonlyArray<{ url: string; declaredSize: number; contentType: string }>
  }): Promise<
    | { outcome: 'collected'; images: ReadonlyArray<MainlineImage> }
    | { outcome: 'failed'; reason: string }
  >
}

export interface SessionMainlineDeps {
  threads: ReturnType<typeof createThreadCreationFlow>
  sessions: ReturnType<typeof createSessionCreationFlow>
  prompts: ReturnType<typeof createPromptSubmissionFlow>
  turns: TurnTracker
  images: MainlineImageCollector
}

export type MentionMainlineResult =
  | { outcome: 'admitted'; threadId: string; sessionId: string }
  | { outcome: 'thread-conflict' }
  | { outcome: 'thread-failed' }
  | { outcome: 'session-rejected' }
  | { outcome: 'session-unknown' }
  | { outcome: 'prompt-rejected' }
  | { outcome: 'prompt-unknown' }
  | { outcome: 'image-failed'; reason: string }

export interface MentionMainlineRequest {
  applicationId: string
  guildId: string
  /** The bound project channel the mention arrived in. */
  channelId: string
  messageId: string
  authorId: string
  workspaceId: string
  prompt: string
  /** Declared image attachments (16.50); omitted for text-only mentions. */
  images?: ReadonlyArray<MainlineWireImage>
}

export type ContinuationMainlineResult =
  | { outcome: 'queued' }
  | { outcome: 'already-submitted' }
  | { outcome: 'conflict' }
  | { outcome: 'rejected' }
  | { outcome: 'unknown' }
  | { outcome: 'image-failed'; reason: string }

export interface ContinuationMainlineRequest {
  applicationId: string
  guildId: string
  threadId: string
  sessionId: string
  messageId: string
  prompt: string
  /** Declared image attachments (16.50); omitted for text-only messages. */
  images?: ReadonlyArray<MainlineWireImage>
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

/**
 * Collect the request's declared images through the bounded boundary. A
 * text-only request never touches the collector; a failed collection is a
 * first-class outcome so no degraded text-only submission is sent silently.
 */
async function collectRequestImages(
  deps: SessionMainlineDeps,
  images: ReadonlyArray<MainlineWireImage>,
): Promise<{ outcome: 'collected'; images: ReadonlyArray<MainlineImage> } | { outcome: 'image-failed'; reason: string }> {
  if (images.length === 0) return { outcome: 'collected', images: [] }
  const collected = await deps.images.collect({
    attachments: images.map(({ url, declaredSize, contentType }) => ({ url, declaredSize, contentType })),
  })
  if (collected.outcome !== 'collected') return { outcome: 'image-failed', reason: collected.reason }
  return collected
}

export function createSessionMainline(deps: SessionMainlineDeps): {
  admitMention(request: MentionMainlineRequest): Promise<MentionMainlineResult>
  continueInThread(request: ContinuationMainlineRequest): Promise<ContinuationMainlineResult>
} {
  return {
    async admitMention(request) {
      const declaredImages = request.images ?? []
      const images = await collectRequestImages(deps, declaredImages)
      if (images.outcome !== 'collected') return images

      // The source message id is the durable intent: one thread per message,
      // deterministic recovery on redelivery (design.md §4, §10). An
      // image-only mention names the thread after its first image's filename.
      const title = request.prompt !== '' ? request.prompt : (declaredImages[0]?.filename ?? '')
      const thread: ThreadCreationResult = await deps.threads.ensureThread({
        sourceMessageId: request.messageId,
        contentHash: await hashPayload({ prompt: request.prompt, images: declaredImages }),
        guildId: request.guildId,
        parentChannelId: request.channelId,
        threadName: safeTitle(title),
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
        ...(images.images.length > 0 ? { images: images.images } : {}),
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
      const images = await collectRequestImages(deps, request.images ?? [])
      if (images.outcome !== 'collected') return images

      const requestId = requestIdFor(request.messageId)
      const submitted = await deps.prompts.submitOnce({
        requestId,
        sessionId: request.sessionId,
        prompt: request.prompt,
        ...(images.images.length > 0 ? { images: images.images } : {}),
      })
      if (submitted.outcome === 'accepted') {
        ownTurn(deps, { sessionId: request.sessionId, requestId, threadId: request.threadId })
      }
      return mapSubmission(submitted)
    },
  }
}
