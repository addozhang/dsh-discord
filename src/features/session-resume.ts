/**
 * `/session resume` candidate building (design.md §13, tasks 9.1 + 16.44).
 * The Host's `sessions.list` returns rich rows (updatedAt desc, running,
 * blank, cwd, title via projection values). Candidates exclude blank
 * sessions and sessions this adapter already owns a thread for, filter by
 * title/id substring, and sort newest-first — Discord autocomplete caps at
 * 25 choices, the caller slices.
 */

import type { SessionResumeRow } from '../dsh/api-proxy-face.js'

export type { SessionResumeRow }
import { filterAutocomplete, type SelectorOption } from '../discord/selector.js'

export interface SessionCatalogPort {
  listSessions(): Promise<
    | { outcome: 'completed'; sessions: ReadonlyArray<SessionResumeRow> }
    | { outcome: 'failed' }
    | { outcome: 'unknown' }
  >
}

export type ResumeCandidates =
  | { outcome: 'ok'; options: SelectorOption[] }
  | { outcome: 'failed'; reason: 'session-catalog-unavailable' | 'session-catalog-unknown' }

/** Relative-time rendering for a candidate's description line. */
export function relativeTime(fromMs: number, nowMs: number): string {
  const delta = Math.max(0, nowMs - fromMs)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时前`
  const days = Math.floor(hours / 24)
  return `${String(days)} 天前`
}

/** Short display form of a session id (first 8 chars). */
function shortId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

/**
 * Build the /session resume autocomplete candidates from one Host listing:
 * blank sessions are hidden (nothing to resume), already-bound sessions are
 * excluded (their thread is the live surface), the query filters over
 * title/id case-insensitively, and rows sort newest-first. Uncapped here —
 * the caller applies Discord's 25-choice ceiling.
 */
export function buildResumeCandidates(
  sessions: ReadonlyArray<SessionResumeRow>,
  options: {
    /** Registered path of the bound Workspace; only its sessions are offered. */
    workspacePath: string | undefined
    boundSessionIds?: ReadonlySet<string>
    query?: string | undefined
    nowMs?: number
  },
): SelectorOption[] {
  const query = (options.query ?? '').trim().toLowerCase()
  const nowMs = options.nowMs ?? Date.now()
  const bound = options.boundSessionIds ?? new Set<string>()
  const workspacePath = options.workspacePath
  const rows = sessions
    .filter(session => !session.blank && !bound.has(session.sessionId))
    // Workspace scoping (16.44): a session belongs to the channel's Workspace
    // only when its recorded cwd is that Workspace's registered path.
    // Sessions with no recorded cwd cannot be attributed and are never
    // offered.
    .filter(session => workspacePath === undefined || session.cwd === workspacePath)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const options_: SelectorOption[] = rows.map(session => {
    const label = session.title ?? shortId(session.sessionId)
    const age = relativeTime(session.updatedAt, nowMs)
    const description = `${age}${session.running ? ' · 运行中' : ''}`
    return { label, value: session.sessionId, description }
  })
  if (query === '') return options_
  return options_.filter(option =>
    option.label.toLowerCase().includes(query) || option.value.toLowerCase().includes(query))
}

/** Discard candidates: prefix matches first, then substring, capped. */
export function filterResumeCandidates(
  candidates: ReadonlyArray<SelectorOption>,
  query: string,
  limit = 25,
): SelectorOption[] {
  return filterAutocomplete(candidates, query, limit)
}
