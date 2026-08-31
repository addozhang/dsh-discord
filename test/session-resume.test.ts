/**
 * `/session resume` candidate tests (9.1 + 16.44): the Host's rich
 * `sessions.list` rows become autocomplete candidates — blank sessions and
 * sessions this adapter already owns are excluded, rows sort newest-first,
 * untitled sessions fall back to a short id, and the query filters over
 * title/id case-insensitively. Discord autocomplete choices carry no
 * description on the wire, so the relative age (and the running marker)
 * ride the label; same-titled candidates get a short-id suffix (16.47).
 */

import { describe, expect, it } from 'vitest'

import { createCopy } from '../src/i18n.js'
import { buildResumeCandidates, createResumeCandidatesPort, filterResumeCandidates, relativeTime, type SessionResumeRow } from '../src/features/session-resume.js'

const NOW = 1_800_000_000_000
const copy = createCopy('zh')
const en = createCopy('en')

function row(overrides: Partial<SessionResumeRow> & { sessionId: string }): SessionResumeRow {
  return {
    title: undefined,
    updatedAt: NOW - 60_000,
    running: false,
    blank: false,
    cwd: undefined,
    origin: undefined,
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
      { workspacePath: '/private/tmp', boundSessionIds: new Set(['dddddddd-bound']), query: '', nowMs: NOW, copy },
    )
    expect(options.map(option => option.label)).toEqual(['Fresh fix · 刚刚', 'aaaaaaaa · 3 小时前'])
    expect(options[0]).toEqual({ label: 'Fresh fix · 刚刚', value: 'cccccccc-new' })
  })

  it('marks a running session in the label', () => {
    const options = buildResumeCandidates(
      [row({  sessionId: 'rrrrrrrr-run', title: 'Running one', running: true, updatedAt: NOW , cwd: '/private/tmp' })],
      { workspacePath: '/private/tmp', query: '', nowMs: NOW, copy },
    )
    expect(options[0]?.label).toBe('Running one · 刚刚 · 运行中')
  })

  it('renders the age in the configured language', () => {
    const options = buildResumeCandidates(
      [row({  sessionId: 'rrrrrrrr-run', title: 'Running one', updatedAt: NOW - 2 * 3600_000 , cwd: '/private/tmp' })],
      { workspacePath: '/private/tmp', query: '', nowMs: NOW, copy: en },
    )
    expect(options[0]?.label).toBe('Running one · 2h ago')
  })

  it('suffixes same-titled candidates with their short id so they stay distinguishable', () => {
    const options = buildResumeCandidates(
      [
        row({  sessionId: 'aaaaaaaa-dup', title: 'Same title', updatedAt: NOW , cwd: '/private/tmp' }),
        row({  sessionId: 'bbbbbbbb-dup', title: 'Same title', updatedAt: NOW , cwd: '/private/tmp' }),
        row({  sessionId: 'cccccccc-unique', title: 'Same title', updatedAt: NOW - 60_000 , cwd: '/private/tmp' }),
      ],
      { workspacePath: '/private/tmp', query: '', nowMs: NOW, copy },
    )
    expect(options.map(option => option.label)).toEqual([
      'Same title · 刚刚 · aaaaaaaa',
      'Same title · 刚刚 · bbbbbbbb',
      'Same title · 1 分钟前',
    ])
  })

  it('hides subagent sessions from the candidates (16.48)', () => {
    // Regression 16.48: subagent spawns ("You are investigating …") flooded
    // the fiber channel's list even though resuming one as a top-level
    // thread is refused by the spec.
    const options = buildResumeCandidates(
      [
        row({ sessionId: 'aaaaaaaa-sub', title: 'You are investigating', origin: 'subagent', cwd: '/ws/fiber', updatedAt: NOW }),
        row({ sessionId: 'cccccccc-top', title: 'Top level', cwd: '/ws/fiber', updatedAt: NOW - 1 }),
      ],
      { workspacePath: '/ws/fiber', query: '', nowMs: NOW, copy },
    )
    expect(options.map(option => option.label)).toEqual(['Top level · 刚刚'])
  })

  it('filters by title and id substrings case-insensitively', () => {
    const options = buildResumeCandidates(
      [
        row({  sessionId: 'aaaaaaaa-auth-retry', title: 'Fix AUTH flow', updatedAt: NOW , cwd: '/private/tmp' }),
        row({  sessionId: 'bbbbbbbb-billing', title: 'Billing cleanup', updatedAt: NOW - 1 , cwd: '/private/tmp' }),
        row({  sessionId: 'cccccccc-other', updatedAt: NOW - 2 , cwd: '/private/tmp' }),
      ],
      { workspacePath: '/private/tmp', query: 'aUTh', nowMs: NOW, copy },
    )
    expect(options.map(option => option.label)).toEqual(['Fix AUTH flow · 刚刚'])
    const byId = buildResumeCandidates(
      [
        row({  sessionId: 'aaaaaaaa-auth-retry' , cwd: '/private/tmp' }),
        row({  sessionId: 'bbbbbbbb-BBBB' , cwd: '/private/tmp' }),
      ],
      { workspacePath: '/private/tmp', query: 'bbbb', nowMs: NOW, copy },
    )
    expect(byId.map(option => option.label)).toEqual(['bbbbbbbb · 1 分钟前'])
  })
})

describe('resume autocomplete capping', () => {
  it('caps the choices at Discord\'s 25 ceiling with prefix ranking', () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({ sessionId: `sess-${String(i).padStart(4, '0')}`, title: `Session ${String(i)}`, updatedAt: NOW - i * 1_000, cwd: '/private/tmp' }))
    const options = buildResumeCandidates(rows, { workspacePath: '/private/tmp', query: 'session', nowMs: NOW, copy })
    expect(options.length).toBe(40)
    const capped = filterResumeCandidates(options, 'session')
    expect(capped.length).toBe(25)
  })
})

describe('relativeTime', () => {
  it('renders the coarse buckets bilingually', () => {
    expect(relativeTime(copy, NOW - 30_000, NOW)).toBe('刚刚')
    expect(relativeTime(copy, NOW - 5 * 60_000, NOW)).toBe('5 分钟前')
    expect(relativeTime(copy, NOW - 3 * 3600_000, NOW)).toBe('3 小时前')
    expect(relativeTime(copy, NOW - 2 * 86_400_000, NOW)).toBe('2 天前')
    expect(relativeTime(en, NOW - 30_000, NOW)).toBe('just now')
    expect(relativeTime(en, NOW - 5 * 60_000, NOW)).toBe('5m ago')
    expect(relativeTime(en, NOW - 3 * 3600_000, NOW)).toBe('3h ago')
    expect(relativeTime(en, NOW - 2 * 86_400_000, NOW)).toBe('2d ago')
  })
})

describe('resume candidates port (16.45 composition wiring)', () => {
  /** Port deps over an in-memory listing, counting Host RPCs. */
  function portWith(sessions: SessionResumeRow[], counters: { listed?: number }) {
    return createResumeCandidatesPort({
      listSessions: () => {
        counters.listed = (counters.listed ?? 0) + 1
        return Promise.resolve({ outcome: 'completed' as const, sessions })
      },
      boundSessionIds: () => new Set(['bbbbbbbb-bound']),
      copy,
    })
  }

  it('is fail-closed on an unresolvable workspace and never reaches the Host listing', async () => {
    const counters: { listed?: number } = {}
    const port = portWith([row({ sessionId: 'aaaaaaaa-any', cwd: '/ws/fiber', updatedAt: NOW })], counters)
    await expect(port('', undefined)).resolves.toEqual({ outcome: 'unavailable' })
    expect(counters.listed).toBeUndefined()
  })

  it('matches sessions against the handed-in workspace path verbatim (the router contract)', async () => {
    // Regression 16.45: the composition root once re-resolved this argument
    // as a workspace ID through the catalog — an id/path swap that answered
    // `unavailable` in every channel and emptied the list everywhere.
    const port = portWith(
      [
        row({ sessionId: 'aaaaaaaa-fiber', title: 'Fiber fix', updatedAt: NOW, cwd: '/ws/fiber' }),
        row({ sessionId: 'bbbbbbbb-bound', title: 'Already live', updatedAt: NOW, cwd: '/ws/fiber' }),
        row({ sessionId: 'cccccccc-other', title: 'Other dir', updatedAt: NOW - 1, cwd: '/somewhere/else' }),
        row({ sessionId: 'dddddddd-blank', title: 'Empty', updatedAt: NOW - 2, blank: true, cwd: '/ws/fiber' }),
      ],
      {},
    )
    await expect(port('', '/ws/fiber')).resolves.toEqual({
      outcome: 'ok',
      options: [{ label: 'Fiber fix · 刚刚', value: 'aaaaaaaa-fiber' }],
    })
  })

  it('hides archived sessions from the candidates (16.49)', async () => {
    // Regression 16.49: an archived session accepts the resume adoption but
    // never runs a turn — the user waited in a dead thread. `workspace.list`
    // carries the registry's archivedSessionIds; the port must subtract them.
    const port = portWith(
      [
        row({ sessionId: 'aaaaaaaa-live', title: 'Live one', updatedAt: NOW, cwd: '/ws/fiber' }),
        row({ sessionId: 'session-archived', title: 'Archived ztm', updatedAt: NOW - 1, cwd: '/ws/fiber' }),
      ],
      {},
    )
    await expect(port('', '/ws/fiber', new Set(['session-archived']))).resolves.toEqual({
      outcome: 'ok',
      options: [{ label: 'Live one · 刚刚', value: 'aaaaaaaa-live' }],
    })
  })

  it('answers unavailable when the Host listing fails or is uncertain', async () => {
    for (const outcome of ['failed', 'unknown'] as const) {
      const port = createResumeCandidatesPort({
        listSessions: () => Promise.resolve({ outcome }),
        boundSessionIds: () => new Set(),
        copy,
      })
      await expect(port('', '/ws/fiber')).resolves.toEqual({ outcome: 'unavailable' })
    }
  })
})
