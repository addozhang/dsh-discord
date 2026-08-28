/**
 * Message splitter tests (11.5): every chunk respects Discord's 2,000-char
 * limit, breaks prefer at line then word boundaries, unbreakable text is cut
 * hard without splitting surrogate pairs, and empty output yields no chunks.
 */

import { describe, expect, it } from 'vitest'

import { DISCORD_MESSAGE_LIMIT, splitMessage } from '../src/stream/splitter.js'

describe('splitMessage', () => {
  it('returns no chunks for empty output', () => {
    expect(splitMessage('')).toEqual([])
    expect(splitMessage('   \n  ')).toEqual([])
  })

  it('keeps short text as one chunk', () => {
    expect(splitMessage('hello world')).toEqual(['hello world'])
  })

  it('keeps text at exactly the limit in one chunk', () => {
    const text = 'a'.repeat(DISCORD_MESSAGE_LIMIT)
    expect(splitMessage(text)).toEqual([text])
  })

  it('breaks at line boundaries when possible', () => {
    const text = `${'a'.repeat(1200)}\n${'b'.repeat(1200)}`
    const chunks = splitMessage(text)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe('a'.repeat(1200))
    expect(chunks[1]).toBe('b'.repeat(1200))
  })

  it('breaks at word boundaries within a long paragraph', () => {
    const words = Array.from({ length: 700 }, (_, index) => `word${String(index)}`)
    const text = words.join(' ')
    const chunks = splitMessage(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT)
    }
    expect(chunks.join(' ')).toBe(text)
  })

  it('hard-cuts unbreakable text without splitting surrogate pairs', () => {
    const rocket = '\u{1F680}'
    const text = rocket.repeat(3_000)
    const chunks = splitMessage(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT)
      // No chunk ends mid-surrogate-pair.
      expect(() => Array.from(chunk)).not.toThrow()
      for (const char of chunk) {
        expect(char).toBe(rocket)
      }
    }
  })

  it('keeps every chunk within the limit across varied inputs', () => {
    const samples = [
      'x'.repeat(1_999) + ' y',
      'word '.repeat(900),
      '\u{1F600}'.repeat(1_500),
      `line\n`.repeat(900),
      'a'.repeat(DISCORD_MESSAGE_LIMIT) + 'b'.repeat(DISCORD_MESSAGE_LIMIT),
    ]
    for (const sample of samples) {
      for (const chunk of splitMessage(sample)) {
        expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT)
        expect(chunk.trim().length).toBeGreaterThan(0)
      }
    }
  })
})
