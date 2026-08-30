/**
 * Thread creation over the source-message intent (design.md §4, §10, anchored-thread
 * thread model). The source Discord message id is the stable claim: the
 * first creator creates a thread ANCHORED to that message (Discord moves it
 * into the thread as its first post — the user's task text opens the
 * thread) and records it on the intent; any redelivery of the same message
 * recovers that thread (from the record, or — across a crash window where
 * the intent exists but carries no thread id — from Discord's deterministic
 * source-message lookup). The author is joined to the thread so it appears
 * in their sidebar (live-tested: "add user to thread so it appears in their
 * sidebar"). Different content under the same message id conflicts, and
 * creation failures surface as values.
 */

import type { IntentStore } from '../state/intents.js'

/** The Discord thread surface the flow needs (REST in production, fakes here). */
export interface DiscordThreadPort {
  createThread(request: {
    parentChannelId: string
    name: string
    /** The source message anchors the thread (its durable first message). */
    sourceMessageId: string
  }): Promise<{ outcome: 'completed'; threadId: string } | { outcome: 'failed' } | { outcome: 'unknown' }>
  /** Deterministic recovery: find the thread created for this source message. */
  findThreadBySource(request: {
    guildId: string
    sourceMessageId: string
  }): Promise<{ outcome: 'found'; threadId: string } | { outcome: 'not-found' }>
  /**
   * Join the task author to the thread: Discord sidebars list only threads
   * the user has joined, so the anchored task thread stays invisible to its
   * author until this runs. Best-effort by contract; never fails the task.
   */
  joinThread(request: { threadId: string; userId: string }): Promise<
    | { outcome: 'completed' }
    | { outcome: 'failed' }
  >
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
  /** The task author to join into the thread (sidebar visibility). */
  creatorUserId?: string | undefined
}

export function createThreadCreationFlow(deps: ThreadCreationDeps): {
  ensureThread(request: EnsureThreadRequest): Promise<ThreadCreationResult>
} {
  /**
   * Best-effort author join on every path that yields a live thread. A join
   * failure never fails the task: the thread exists and reconciliation, not
   * this call, owns Discord-side recovery.
   */
  async function joinAuthor(request: EnsureThreadRequest, threadId: string): Promise<void> {
    if (request.creatorUserId === undefined || request.creatorUserId === '') return
    try {
      await deps.discord.joinThread({ threadId, userId: request.creatorUserId })
    } catch {
      return
    }
  }

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
          await joinAuthor(request, existing)
          return { outcome: 'recovered', threadId: existing }
        }
        // Intent exists without a thread id: a previous attempt crashed
        // mid-flow. Recover deterministically from Discord.
        const found = await deps.discord.findThreadBySource({
          guildId: request.guildId,
          sourceMessageId: request.sourceMessageId,
        })
        if (found.outcome === 'found') {
          await deps.intents.resolve(request.sourceMessageId, 'succeeded', deps.nowMs())
          // Persist the recovered id like the fresh-create path does, or
          // every redelivery re-enters the crash window and rescans.
          await deps.intents.annotate(request.sourceMessageId, { threadId: found.threadId })
          await joinAuthor(request, found.threadId)
          return { outcome: 'recovered', threadId: found.threadId }
        }
        return { outcome: 'failed' }
      }

      // Fresh claim: create the anchored thread and record it on the intent.
      const created = await deps.discord.createThread({
        parentChannelId: request.parentChannelId,
        name: request.threadName,
        sourceMessageId: request.sourceMessageId,
      })
      if (created.outcome !== 'completed') {
        await deps.intents.resolve(request.sourceMessageId, 'failed', deps.nowMs())
        return { outcome: 'failed' }
      }
      await joinAuthor(request, created.threadId)

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
