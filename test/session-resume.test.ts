/**
 * `/session resume` selector tests (9.1): lists the CURRENT workspace's
 * sessions filtered by id/title substring, falls back to the session id when
 * no title exists, marks archived sessions, pages within Discord limits, and
 * never includes content snippets — metadata only, no full-text search.
 */

import { describe, expect, it } from 'vitest'

import { buildResumeSelector, type SessionCatalogPort } from '../src/features/session-resume.js'

function catalog(sessions: Array<{ sessionId: string; title: string | null; archived: boolean }>): SessionCatalogPort {
  return {
    listSessions: () => Promise.resolve({ outcome: 'completed', sessions }),
  }
}

describe('resume selector', () => {
  it('lists the workspace sessions with id-fallback labels and archived marks', async () => {
    const view = await buildResumeSelector(catalog([
      { sessionId: 'sess-1', title: 'Fix auth flow', archived: false },
      { sessionId: 'sess-2', title: null, archived: false },
      { sessionId: 'sess-3', title: 'Old spike', archived: true },
    ]), { workspaceId: 'ws-1', selectionId: 'sr-1' })

    expect(view.outcome).toBe('ok')
    if (view.outcome !== 'ok') return
    expect(view.items.map(item => item.label)).toEqual([
      'Fix auth flow',
      'sess-2',
      '[archived] Old spike',
    ])
    expect(view.items.map(item => item.value)).toEqual(['sess:1', 'sess:2', 'sess:3'])
  })

  it('filters by id/title substring case-insensitively', async () => {
    const view = await buildResumeSelector(catalog([
      { sessionId: 'sess-1', title: 'Fix auth flow', archived: false },
      { sessionId: 'sess-2', title: 'DB migration', archived: false },
      { sessionId: 'sess-migration', title: null, archived: false },
    ]), { workspaceId: 'ws-1', selectionId: 'sr-1', query: 'MIG' })
    if (view.outcome !== 'ok') return
    expect(view.items.map(item => item.label)).toEqual(['DB migration', 'sess-migration'])
  })

  it('pages large catalogs inside the component limit', async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      sessionId: `sess-${String(index)}`,
      title: `session ${String(index)}`,
      archived: false,
    }))
    const view = await buildResumeSelector(catalog(many), { workspaceId: 'ws-1', selectionId: 'sr-9', page: 1 })
    expect(view.outcome).toBe('ok')
    if (view.outcome !== 'ok') return
    expect(view.pageCount).toBeGreaterThan(1)
    expect(view.items.length + Object.keys(view.navValues).length).toBeLessThanOrEqual(25)
    expect(view.navValues.next).toBe('sr-9:page:2')
  })

  it('sanitizes catalog failures', async () => {
    const failed: SessionCatalogPort = { listSessions: () => Promise.resolve({ outcome: 'failed' }) }
    expect(await buildResumeSelector(failed, { workspaceId: 'ws-1', selectionId: 's' }))
      .toEqual({ outcome: 'failed', reason: 'session-catalog-unavailable' })

    const unknown: SessionCatalogPort = { listSessions: () => Promise.resolve({ outcome: 'unknown' }) }
    expect(await buildResumeSelector(unknown, { workspaceId: 'ws-1', selectionId: 's' }))
      .toEqual({ outcome: 'failed', reason: 'session-catalog-unknown' })
  })
})
