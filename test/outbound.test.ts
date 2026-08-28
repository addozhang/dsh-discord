/**
 * Outbound suppression tests (11.7): every message the adapter sends —
 * assistant answers, tool views, titles, and errors — carries the
 * SUPPRESS_MENTIONS flag AND mention-neutralized content, so a hostile or
 * accidental ping is impossible even if a surface ignores the flag.
 */

import { describe, expect, it } from 'vitest'

import {
  OUTBOUND_MESSAGE_FLAGS,
  buildOutboundMessage,
} from '../src/stream/outbound.js'
import { suppressMentionSyntax } from '../src/policy/suppress.js'

describe('outbound message builder', () => {
  it('always sets SUPPRESS_MENTIONS on the payload flags', () => {
    const payload = buildOutboundMessage({ kind: 'assistant', content: 'plain text' })
    expect(payload.flags).toBe(OUTBOUND_MESSAGE_FLAGS)
    expect(OUTBOUND_MESSAGE_FLAGS & (1 << 12)).toBe(1 << 12)
  })

  it('neutralizes mention syntax in every content kind', () => {
    for (const kind of ['assistant', 'tool', 'title', 'error'] as const) {
      const payload = buildOutboundMessage({
        kind,
        content: '@everyone <@111111111111111111> <#222222222222222222>',
      })
      expect(payload.content).toBe(suppressMentionSyntax('@everyone <@111111111111111111> <#222222222222222222>'))
      expect(payload.content).not.toContain('@everyone')
      expect(payload.content).not.toContain('<@111111111111111111>')
    }
  })

  it('keeps non-mention text byte-identical', () => {
    const payload = buildOutboundMessage({ kind: 'assistant', content: 'plain text 123' })
    expect(payload.content).toBe('plain text 123')
  })
})
