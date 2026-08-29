/**
 * The single outbound message builder (design.md §8, task 11.7). Every
 * message path — assistant answers, tool views, titles, errors — constructs
 * its payload here, where the SUPPRESS_MENTIONS flag is applied and content
 * is additionally neutralized byte-wise: a renderer that ignored the flag
 * still could not resolve a ping.
 */

import { DISCORD_SUPPRESS_MENTIONS_FLAG, safeTitle } from '../policy/disclosure.js'
import { wrapGfmTables } from './markdown.js'
import { suppressMentionSyntax } from '../policy/suppress.js'

/** Discord message flags the adapter always sets (SUPPRESS_MENTIONS). */
export const OUTBOUND_MESSAGE_FLAGS = DISCORD_SUPPRESS_MENTIONS_FLAG

export type OutboundContentKind = 'assistant' | 'tool' | 'title' | 'error'

export interface OutboundMessage {
  content: string
  flags: number
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
  return { content, flags: OUTBOUND_MESSAGE_FLAGS }
}
