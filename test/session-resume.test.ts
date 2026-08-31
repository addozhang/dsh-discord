/**
 * `/session resume` candidate tests (9.1 + 16.44): the Host's rich
 * `sessions.list` rows become autocomplete candidates — blank sessions and
 * sessions this adapter already owns are excluded, rows sort newest-first,
 * untitled sessions fall back to a short id, and the query filters over
 * title/id case-insensitively.
 */

import { describe, expect, it } from 'vitest'

import { buildResumeCandidates, filterResumeCandidates, relativeTime, type SessionResumeRow } from '../src/features/session-resume.js'

const NOW = 1_800_000_000_000

function row(overrides: Partial<SessionResumeRow> & { sessionId: string }): SessionResumeRow {
  return {
    title: undefined,
    updatedAt: NOW - 60_000,
    running: false,
    blank: false,
    cwd: undefined,
    ...overrides,
  }
}

describe('resume candidates (16.44)', () => {
  it('sorts newest-first, hides blank and bound sessions, labels untitled with a short id', () => {
    const options = buildResumeCandidates(
      [
        row({  sessionId: 'aaaaaaaa-old', updatedAt: NOW - 3 * 3600_000 , cwd: '/private/tmp' }),
        row({  sessionId: 'cccccccc-new', title: 'Fresh fix', updatedAt: NOW - 5_000 , cwd: '/private/tmp' }),
        row({  sessionId: 'bbbbbbbb-blank', blank: true, updatedAt: NOW - 1_000 , cwd: '/private/tmp' }),
        row({  sessionId: 'dddddddd-bound', updatedAt: NOW - 2_000 , cwd: '/private/tmp' }),
      ],
      { workspacePath: '/private/tmp', boundSessionIds: new Set(['dddddddd-bound']), query: '', nowMs: NOW },
    )
    expect(options.map(option => option.label)).toEqual(['Fresh fix', 'aaaaaaaa'])
    expect(options[0]?.description).toContain('刚刚')
    expect(options[1]?.description).toContain('3 小时前')
  })

  it('marks a running session in the description', () => {
    const options = buildResumeCandidates(
      [row({  sessionId: 'rrrrrrrr-run', title: 'Running one', running: true, updatedAt: NOW , cwd: '/private/tmp' })],
      { workspacePath: '/private/tmp', query: '', nowMs: NOW },
    )
    expect(options[0]?.description).toContain('运行中')
  })

  it('filters by title and id substrings case-insensitively', () => {
    const options = buildResumeCandidates(
      [
        row({  sessionId: 'aaaaaaaa-auth-retry', title: 'Fix AUTH flow', updatedAt: NOW , cwd: '/private/tmp' }),
        row({  sessionId: 'bbbbbbbb-billing', title: 'Billing cleanup', updatedAt: NOW - 1 , cwd: '/private/tmp' }),
        row({  sessionId: 'cccccccc-other', updatedAt: NOW - 2 , cwd: '/private/tmp' }),
      ],
      { workspacePath: '/private/tmp', query: 'aUTh', nowMs: NOW },
    )
    expect(options.map(option => option.label)).toEqual(['Fix AUTH flow'])
    const byId = buildResumeCandidates(
      [
        row({  sessionId: 'aaaaaaaa-auth-retry' , cwd: '/private/tmp' }),
        row({  sessionId: 'bbbbbbbb-BBBB' , cwd: '/private/tmp' }),
      ],
      { workspacePath: '/private/tmp', query: 'bbbb', nowMs: NOW },
    )
    expect(byId.map(option => option.label)).toEqual(['bbbbbbbb'])
  })
})

describe('resume autocomplete capping', () => {
  it('caps the choices at Discord\'s 25 ceiling with prefix ranking', () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({ sessionId: `sess-${String(i).padStart(4, '0')}`, title: `Session ${String(i)}`, updatedAt: NOW - i * 1_000, cwd: '/private/tmp' }))
    const options = buildResumeCandidates(rows, { workspacePath: '/private/tmp', query: 'session', nowMs: NOW })
    expect(options.length).toBe(40)
    const capped = filterResumeCandidates(options, 'session')
    expect(capped.length).toBe(25)
  })
})

describe('relativeTime', () => {
  it('renders the coarse buckets', () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe('刚刚')
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5 分钟前')
    expect(relativeTime(NOW - 3 * 3600_000, NOW)).toBe('3 小时前')
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2 天前')
  })
})
