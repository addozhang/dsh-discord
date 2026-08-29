/**
 * Iconography table tests (stream-renderer "Fixed adapter-owned iconography").
 * Tool rows carry exactly one category icon (never a run-state mark), and
 * notice kinds map to fixed prefixes. This module is the ONLY source of icons.
 */

import { describe, expect, it } from 'vitest'

import { noticeIcon, toolCategoryIcon } from '../src/stream/icons.js'



describe('tool category icons', () => {
  it('rides the label allowlist by first word', () => {
    expect(toolCategoryIcon('Shell')).toBe('💻')
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
