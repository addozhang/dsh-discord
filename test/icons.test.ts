/**
 * Iconography table tests (stream-renderer "Fixed adapter-owned iconography").
 * The table is exception-only (running 🟡, failed ❌, succeeded quiet),
 * category icons ride the tool-label allowlist's first word, and notice
 * kinds map to fixed prefixes. This module is the ONLY source of icons.
 */

import { describe, expect, it } from 'vitest'

import { noticeIcon, toolCategoryIcon, toolStateIcon } from '../src/stream/icons.js'

describe('tool state icons', () => {
  it('marks only the exceptions: running amber, failed red', () => {
    expect(toolStateIcon('running')).toBe('🟡')
    expect(toolStateIcon('failed')).toBe('❌')
  })

  it('leaves succeeded rows quiet — the disappearing amber is the signal', () => {
    expect(toolStateIcon('succeeded')).toBe('')
  })

  it('treats an interrupted row as an exception', () => {
    expect(toolStateIcon('interrupted')).toBe('❌')
  })
})

describe('tool category icons', () => {
  it('rides the label allowlist by first word', () => {
    expect(toolCategoryIcon('Shell')).toBe('⌨️')
    expect(toolCategoryIcon('Read file')).toBe('📖')
    expect(toolCategoryIcon('Write file')).toBe('✍️')
    expect(toolCategoryIcon('Edit file')).toBe('✏️')
    expect(toolCategoryIcon('Search')).toBe('🔍')
    expect(toolCategoryIcon('Find files')).toBe('🗂️')
    expect(toolCategoryIcon('Web')).toBe('🌐')
  })

  it('falls back to the generic icon for the generic label', () => {
    expect(toolCategoryIcon('Tool')).toBe('🧩')
    expect(toolCategoryIcon('unheard-of label')).toBe('🧩')
  })
})

describe('notice icons', () => {
  it('maps the five kinds to fixed prefixes', () => {
    expect(noticeIcon('failure')).toBe('⚠️')
    expect(noticeIcon('guidance')).toBe('💡')
    expect(noticeIcon('stop')).toBe('🛑')
    expect(noticeIcon('steer')).toBe('↪️')
    expect(noticeIcon('queued')).toBe('⏳')
  })
})
