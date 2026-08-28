/**
 * `/session resume` selector (design.md §13, task 9.1). Metadata only: the
 * current workspace's sessions, filtered by id/title substring — never
 * full-text content search (disabled by default in the Web profile).
 * Untitled sessions fall back to their id; archived sessions carry an
 * explicit mark so the user can tell before adopting.
 */

import { filterAutocomplete, paginateSelector, type SelectorOption } from '../discord/selector.js'
import { safeTitle } from '../policy/disclosure.js'

export interface SessionCatalogPort {
  listSessions(): Promise<
    | { outcome: 'completed'; sessions: ReadonlyArray<{ sessionId: string; title: string | null; archived: boolean }> }
    | { outcome: 'failed' }
    | { outcome: 'unknown' }
  >
}

export interface ResumeSelectorRequest {
  workspaceId: string
  selectionId: string
  query?: string | undefined
  page?: number | undefined
}

export type ResumeSelectorView =
  | {
      outcome: 'ok'
      items: SelectorOption[]
      pageIndex: number
      pageCount: number
      hasPrev: boolean
      hasNext: boolean
      navValues: { prev?: string; next?: string }
    }
  | { outcome: 'failed'; reason: 'session-catalog-unavailable' | 'session-catalog-unknown' }

export async function buildResumeSelector(
  port: SessionCatalogPort,
  request: ResumeSelectorRequest,
): Promise<ResumeSelectorView> {
  const catalog = await port.listSessions()
  if (catalog.outcome === 'failed') {
    return { outcome: 'failed', reason: 'session-catalog-unavailable' }
  }
  if (catalog.outcome === 'unknown') {
    return { outcome: 'failed', reason: 'session-catalog-unknown' }
  }

  const selectable: SelectorOption[] = catalog.sessions.map(session => ({
    label: session.archived
      ? `[archived] ${session.title === null ? session.sessionId : safeTitle(session.title)}`
      : session.title === null
        ? session.sessionId
        : safeTitle(session.title),
    value: `sess:${session.sessionId.replace('sess-', '')}`,
  }))

  const query = request.query ?? ''
  const matches = query.trim() === ''
    ? selectable
    : filterAutocomplete(selectable, query.trim(), Number.POSITIVE_INFINITY)

  const page = paginateSelector(matches, request.page ?? 0, `${request.selectionId}:page`)
  return {
    outcome: 'ok',
    items: page.items,
    pageIndex: page.pageIndex,
    pageCount: page.pageCount,
    hasPrev: page.hasPrev,
    hasNext: page.hasNext,
    navValues: page.navValues,
  }
}
