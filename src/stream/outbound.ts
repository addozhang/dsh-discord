/**
 * The single outbound message builder (design.md §8, task 11.7). Every
 * message path — assistant answers, tool views, titles, errors — constructs
 * its payload here, where mention prevention is layered three ways: the
 * `allowed_mentions: { parse: [] }` request field (the API-level guarantee),
 * silent-delivery flags, and byte-wise syntax neutralization, so a renderer
 * that bypassed one layer still could not resolve a ping.
 */

import { ALLOWED_MENTIONS_NONE, DISCORD_SUPPRESS_NOTIFICATIONS_FLAG, safeTitle } from '../policy/disclosure.js'
import { wrapGfmTables } from './markdown.js'
import { suppressMentionSyntax } from '../policy/suppress.js'

/** Discord message flags the adapter always sets (silent delivery). */
export const OUTBOUND_MESSAGE_FLAGS = DISCORD_SUPPRESS_NOTIFICATIONS_FLAG

export type OutboundContentKind = 'assistant' | 'tool' | 'title' | 'error'

export interface OutboundMessage {
  content: string
  flags: number
  /** No parse category allowed: nothing in the content can ping. */
  allowed_mentions: { parse: string[] }
}

/**
 * Build one outbound payload. Titles are additionally length-capped (they
 * render into headers and badges); all content is mention-neutralized.
 */
export function buildOutboundMessage(input: { kind: OutboundContentKind; content: string }): OutboundMessage {
  const content = input.kind === 'title'
    ? safeTitle(input.content)
    : input.kind === 'assistant'
      ? suppressMentionSyntax(wrapGfmTables(input.content))
      : suppressMentionSyntax(input.content)
  return { content, flags: OUTBOUND_MESSAGE_FLAGS, allowed_mentions: ALLOWED_MENTIONS_NONE }
}
