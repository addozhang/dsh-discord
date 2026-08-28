/**
 * Thread creation over the source-message intent (design.md §4, §10). The
 * source Discord message id is the stable claim: the first creator creates
 * the thread and records it on the intent; any redelivery of the same
 * message recovers that thread (from the record, or — across a crash window
 * where the intent exists but carries no thread id — from Discord's
 * deterministic source-message lookup). Different content under the same
 * message id conflicts, and creation failures surface as values.
 */

import type { IntentStore } from '../state/intents.js'

/** The Discord thread surface the flow needs (REST in production, fakes here). */
export interface DiscordThreadPort {
  createThread(request: {
    parentChannelId: string
    name: string
  }): Promise<{ outcome: 'completed'; threadId: string } | { outcome: 'failed' } | { outcome: 'unknown' }>
  /** Deterministic recovery: find the thread created for this source message. */
  findThreadBySource(sourceMessageId: string): Promise<{ outcome: 'found'; threadId: string } | { outcome: 'not-found' }>
}

export interface ThreadCreationDeps {
  intents: IntentStore
  discord: DiscordThreadPort
  nowMs: () => number
}

export type ThreadCreationResult =
  | { outcome: 'created'; threadId: string }
  | { outcome: 'recovered'; threadId: string }
  | { outcome: 'conflict' }
  | { outcome: 'failed' }

export interface EnsureThreadRequest {
  sourceMessageId: string
  contentHash: string
  guildId: string
  parentChannelId: string
  threadName: string
}

export function createThreadCreationFlow(deps: ThreadCreationDeps): {
  ensureThread(request: EnsureThreadRequest): Promise<ThreadCreationResult>
} {
  return {
    async ensureThread(request): Promise<ThreadCreationResult> {
      const claim = await deps.intents.claim({
        messageId: request.sourceMessageId,
        contentHash: request.contentHash,
        claimedAtMs: deps.nowMs(),
      })

      if (claim.outcome === 'conflict') return { outcome: 'conflict' }

      if (claim.outcome === 'duplicate') {
        const existing = claim.record.threadId
        if (existing !== undefined && existing !== '') {
          return { outcome: 'recovered', threadId: existing }
        }
        // Intent exists without a thread id: a previous attempt crashed
        // mid-flow. Recover deterministically from Discord.
        const found = await deps.discord.findThreadBySource(request.sourceMessageId)
        if (found.outcome === 'found') {
          await deps.intents.resolve(request.sourceMessageId, 'succeeded', deps.nowMs())
          return { outcome: 'recovered', threadId: found.threadId }
        }
        return { outcome: 'failed' }
      }

      // Fresh claim: create the thread and record it on the intent.
      const created = await deps.discord.createThread({
        parentChannelId: request.parentChannelId,
        name: request.threadName,
      })
      if (created.outcome !== 'completed') {
        await deps.intents.resolve(request.sourceMessageId, 'failed', deps.nowMs())
        return { outcome: 'failed' }
      }

      const stored = deps.intents.get(request.sourceMessageId)
      if (stored !== undefined) {
        await deps.intents.resolve(request.sourceMessageId, 'succeeded', deps.nowMs())
        // Persist the thread id on the intent record for later replays.
        await deps.intents.annotate(request.sourceMessageId, { threadId: created.threadId })
      }
      return { outcome: 'created', threadId: created.threadId }
    },
  }
}
