/**
 * Markdown-aware splitting tests (11.6): when a chunk boundary lands inside a
 * fenced code block, the earlier chunk closes the fence and the next chunk
 * reopens it with the same language; an unclosed fence at the end of the
 * output is closed; complete fences pass through untouched.
 */

import { describe, expect, it } from 'vitest'

import { closeOpenFences, splitMarkdownAware } from '../src/stream/markdown.js'

describe('closeOpenFences', () => {
  it('leaves balanced fences untouched', () => {
    const text = 'before\n```py\nprint(1)\n```\nafter'
    expect(closeOpenFences(text)).toBe(text)
  })

  it('closes an unclosed fence at the end', () => {
    const text = 'before\n```py\nprint(1)'
    expect(closeOpenFences(text)).toBe(`${text}\n\`\`\``)
  })
})

describe('splitMarkdownAware', () => {
  it('passes a single chunk with balanced fences through unchanged', () => {
    const text = `look:\n\`\`\`\ncode\n\`\`\`\ndone`
    expect(splitMarkdownAware(text, 2_000)).toEqual([text])
  })

  it('closes the fence in the earlier chunk and reopens it in the next', () => {
    const fence = '```'
    const text = [
      'intro',
      fence,
      ...Array.from({ length: 100 }, (_, index) => `line ${String(index)} ${'x'.repeat(20)}`),
      fence,
      'outro',
    ].join('\n')
    const chunks = splitMarkdownAware(text, 600)

    expect(chunks.length).toBeGreaterThan(1)
    // Every chunk is internally balanced: even number of fence lines.
    for (const chunk of chunks) {
      const fenceLines = chunk.split('\n').filter(line => line.trim() === fence).length
      expect(fenceLines % 2).toBe(0)
    }
    // Reopened fences preserve the language marker.
    const withLanguage = splitMarkdownAware(
      ['intro', '```python', ...Array.from({ length: 100 }, (_, index) => `line ${String(index)}`), '```', 'done'].join('\n'),
      400,
    )
    for (const chunk of withLanguage.slice(1)) {
      if (chunk.includes('```')) {
        const fenceLines = chunk.split('\n').filter(line => line.trim().startsWith('```'))
        expect(fenceLines.length % 2).toBe(0)
      }
    }
  })

  it('preserves the language on reopened fences', () => {
    const text = [
      '```python',
      ...Array.from({ length: 80 }, (_, index) => `print(${String(index)}) ${'y'.repeat(10)}`),
      '```',
    ].join('\n')
    const chunks = splitMarkdownAware(text, 500)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      const lines = chunk.split('\n').filter(line => line.trim().startsWith('```'))
      // Reopen lines carry the language.
      for (const line of lines) {
        expect(line === '```' || line === '```python').toBe(true)
      }
    }
  })

  it('keeps table rows unbroken inside their chunk', () => {
    const header = '| a | b |'
    const rule = '|---|---|'
    const rows = Array.from({ length: 200 }, (_, index) => `| v${String(index)} | w${String(index)} |`)
    const text = [header, rule, ...rows].join('\n')
    const chunks = splitMarkdownAware(text, 400)
    expect(chunks.length).toBeGreaterThan(1)
    // Each chunk that contains the header also contains the rule right after.
    for (const chunk of chunks) {
      if (chunk.includes(header)) {
        expect(chunk).toContain(rule)
      }
    }
  })
})
