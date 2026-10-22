/**
 * The answer finalizer (design.md §8, task 11.10). The final answer lands as
 * ONE edited head message; overflow continues as ordered follow-up messages.
 * Every piece is sent exactly once: the finalizer records progress as it
 * goes, duplicate finalize calls skip without touching Discord, a failed
 * continuation halts at that index (recovery belongs to reconciliation, not
 * blind resend), and a rate-limited head edit is retried in place — bounded,
 * so a port that keeps reporting rate-limit cannot spin forever.
 */

import { splitMarkdownAware } from './markdown.js'
import { buildOutboundMessage } from './outbound.js'
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

/** Head-edit retry budget when the port reports rate-limit backoff. */
const MAX_HEAD_EDIT_RETRIES = 10

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
      // The outbound transforms (GFM table wrapping, mention suppression)
      // can grow a piece past the wire limit AFTER the split, so the final
      // payload is built here and the rare overflow is hard re-split —
      // nothing handed to the port can ever 400 on length.
      const chunks = splitMarkdownAware(fullText, DISCORD_MESSAGE_LIMIT)
      if (chunks.length === 0) {
        finalized = true
        return { outcome: 'finalized', editedHead: false, continuations: 0 }
      }
      const pieces: string[] = []
      for (const chunk of chunks) {
        const built = buildOutboundMessage({ kind: 'assistant', content: chunk }).content
        // Fence-aware fallback (PR review): the plain splitter could cut
        // an outbound-wrapped table mid-fence; re-split the BUILT payload
        // with the fence balancer so every piece still renders whole.
        pieces.push(...(built.length > DISCORD_MESSAGE_LIMIT
          ? splitMarkdownAware(built, DISCORD_MESSAGE_LIMIT)
          : [built]))
      }

      // Head: edit until the port completes; a rate-limited port backs off
      // here, within a bounded budget so the loop cannot spin forever.
      let editedHead = false
      let rateLimitedAttempts = 0
      for (;;) {
        const edited = await deps.delivery.editHead({ messageId: deps.headMessageId, content: pieces[0] ?? '' })
        if (edited.outcome === 'completed') {
          editedHead = true
          break
        }
        if (edited.outcome === 'rate-limited') {
          rateLimitedAttempts += 1
          if (rateLimitedAttempts > MAX_HEAD_EDIT_RETRIES) {
            finalized = true
            return { outcome: 'partial', editedHead: false, continuations: 0 }
          }
          await new Promise(resolve => { setTimeout(resolve, edited.retryAfterMs) })
          continue
        }
        // Hard failure: nothing was mutated on Discord.
        finalized = true
        return { outcome: 'partial', editedHead: false, continuations: 0 }
      }

      // Continuations: ordered, exactly once, halting at the first failure.
      let sent = 0
      for (let index = 1; index < pieces.length; index += 1) {
        const content = pieces[index]
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
