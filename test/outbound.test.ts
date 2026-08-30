/**
 * Outbound suppression tests (11.7): every message the adapter sends —
 * assistant answers, tool views, titles, and errors — carries the
 * `allowed_mentions: {parse: []}` AND mention-neutralized content, so a hostile or
 * accidental ping is impossible even if a surface ignores the flag.
 */

import { describe, expect, it } from 'vitest'

import {
  OUTBOUND_MESSAGE_FLAGS,
  buildOutboundMessage,
} from '../src/stream/outbound.js'
import { suppressMentionSyntax } from '../src/policy/suppress.js'

describe('outbound message builder', () => {
  it('always allows no mention parse category and stays silent', () => {
    const payload = buildOutboundMessage({ kind: 'assistant', content: 'plain text' })
    expect(payload.flags).toBe(OUTBOUND_MESSAGE_FLAGS)
    expect(OUTBOUND_MESSAGE_FLAGS & (1 << 12)).toBe(1 << 12)
    expect(payload.allowed_mentions).toEqual({ parse: [] })
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

  it('wraps GFM tables in fences on the assistant surface', () => {
    const payload = buildOutboundMessage({
      kind: 'assistant',
      content: '结果如下：\n| 命令 | 耗时 |\n| --- | --- |\n| ls | 3ms |\n| du | 12ms |',
    })
    expect(payload.content).toBe(
      '结果如下：\n```\n| 命令 | 耗时 |\n| --- | --- |\n| ls | 3ms |\n| du | 12ms |\n```',
    )
  })

  it('leaves pipe text alone when there is no delimiter row or it sits in a fence', () => {
    const noTable = buildOutboundMessage({ kind: 'assistant', content: '| 只是 | 一行 |\n普通文本' })
    expect(noTable.content).toBe('| 只是 | 一行 |\n普通文本')

    const fenced = buildOutboundMessage({
      kind: 'assistant',
      content: '```\n| a | b |\n| - | - |\n```\n后文',
    })
    expect(fenced.content).toBe('```\n| a | b |\n| - | - |\n```\n后文')
  })

  it('does not wrap tables on non-assistant surfaces', () => {
    const payload = buildOutboundMessage({ kind: 'tool', content: '| a | b |\n| - | - |' })
    expect(payload.content).toBe('| a | b |\n| - | - |')
  })
})
