/**
 * The answer finalizer (design.md §8, task 11.10). The final answer lands as
 * ONE edited head message; overflow continues as ordered follow-up messages.
 * Every piece is sent exactly once: the finalizer records progress as it
 * goes, duplicate finalize calls skip without touching Discord, a failed
 * continuation halts at that index (recovery belongs to reconciliation, not
 * blind resend), and a rate-limited edit is retried by the delivery port
 * while the finalizer guarantees a single successful edit.
 */

import { splitMarkdownAware } from './markdown.js'
import { DISCORD_MESSAGE_LIMIT } from './splitter.js'

export interface AnswerDeliveryPort {
  editHead(request: { messageId: string; content: string }): Promise<
    | { outcome: 'completed' }
    | { outcome: 'rate-limited'; retryAfterMs: number }
    | { outcome: 'failed' }
  >
  sendContinuation(request: { index: number; content: string }): Promise<
    | { outcome: 'completed' }
    | { outcome: 'failed' }
  >
}

export type FinalizeResult =
  | { outcome: 'finalized'; editedHead: boolean; continuations: number }
  | { outcome: 'partial'; editedHead: boolean; continuations: number }
  | { outcome: 'skipped'; reason: 'already-finalized' }

export interface AnswerFinalizer {
  finalize(fullText: string): Promise<FinalizeResult>
}

export function createAnswerFinalizer(deps: {
  delivery: AnswerDeliveryPort
  headMessageId: string
}): AnswerFinalizer {
  let finalized = false

  return {
    async finalize(fullText) {
      if (finalized) return { outcome: 'skipped', reason: 'already-finalized' }

      // Fence-aware: a long answer never splits a ``` code block across
      // messages; each continuation renders as well-formed Markdown alone.
      const chunks = splitMarkdownAware(fullText, DISCORD_MESSAGE_LIMIT)
      if (chunks.length === 0) {
        finalized = true
        return { outcome: 'finalized', editedHead: false, continuations: 0 }
      }

      // Head: edit until the port completes (rate-limit backoff is the
      // port's job); the finalizer guarantees a single successful edit.
      let editedHead = false
      for (;;) {
        const edited = await deps.delivery.editHead({ messageId: deps.headMessageId, content: chunks[0] ?? '' })
        if (edited.outcome === 'completed') {
          editedHead = true
          break
        }
        if (edited.outcome === 'rate-limited') {
          await new Promise(resolve => { setTimeout(resolve, edited.retryAfterMs) })
          continue
        }
        // Hard failure: nothing was mutated on Discord.
        finalized = true
        return { outcome: 'partial', editedHead: false, continuations: 0 }
      }

      // Continuations: ordered, exactly once, halting at the first failure.
      let sent = 0
      for (let index = 1; index < chunks.length; index += 1) {
        const content = chunks[index]
        if (content === undefined) break
        const sentOutcome = await deps.delivery.sendContinuation({ index, content })
        if (sentOutcome.outcome !== 'completed') {
          finalized = true
          return { outcome: 'partial', editedHead, continuations: sent }
        }
        sent += 1
      }

      finalized = true
      return { outcome: 'finalized', editedHead, continuations: sent }
    },
  }
}
