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
import type { CopyTable } from '../i18n.js'
import { filterAutocomplete, type SelectorOption } from '../discord/selector.js'

export interface SessionCatalogPort {
  listSessions(): Promise<
    | { outcome: 'completed'; sessions: ReadonlyArray<SessionResumeRow> }
    | { outcome: 'failed' }
    | { outcome: 'unknown' }
  >
}

export type ResumeCandidatesPort = (
  query: string,
  /**
   * The bound Workspace's REGISTERED PATH, resolved by the router from the
   * channel binding through the workspace catalog. Not a workspace id: the
   * port must never re-resolve it through the catalog (an id/path swap here
   * once answered `unavailable` in every channel — 16.45). `undefined`
   * (unbound channel / catalog miss) is fail-closed.
   */
  workspacePath?: string,
  /** The registry's archived set (16.49): archived sessions never resume. */
  archivedSessionIds?: ReadonlySet<string>,
) => Promise<
  | { outcome: 'ok'; options: SelectorOption[] }
  | { outcome: 'unavailable' }
>

/**
 * Relative-time rendering for a candidate's label. Discord autocomplete
 * choices carry no description field on the wire (name/value only), so the
 * age rides the label — bilingual via the copy table (16.47).
 */
export function relativeTime(copy: CopyTable, fromMs: number, nowMs: number): string {
  const delta = Math.max(0, nowMs - fromMs)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return copy.sessionCandidateJustNow
  if (minutes < 60) return copy.sessionCandidateMinutesAgo(minutes)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return copy.sessionCandidateHoursAgo(hours)
  const days = Math.floor(hours / 24)
  return copy.sessionCandidateDaysAgo(days)
}

/** Short display form of a session id (first 8 chars). */
function shortId(sessionId: string): string {
  return sessionId.slice(0, 8)
}

/** Discord rejects the whole autocomplete answer when a choice name exceeds 100. */
const DISCORD_CHOICE_NAME_MAX = 100

function candidateLabel(copy: CopyTable, session: SessionResumeRow, nowMs: number): string {
  const parts = [session.title ?? shortId(session.sessionId), relativeTime(copy, session.updatedAt, nowMs)]
  if (session.running) parts.push(copy.sessionCandidateRunning)
  const label = parts.join(' · ')
  return label.length <= DISCORD_CHOICE_NAME_MAX ? label : label.slice(0, DISCORD_CHOICE_NAME_MAX)
}

/**
 * Build the /session resume autocomplete candidates from one Host listing:
 * blank sessions are hidden (nothing to resume), already-bound sessions are
 * excluded (their thread is the live surface), the query filters over
 * title/id case-insensitively, and rows sort newest-first. Uncapped here —
 * the caller applies Discord's 25-choice ceiling. Same-titled candidates
 * get a short-id suffix: choices have no description on the wire, so
 * identical labels would be indistinguishable (16.47).
 */
export function buildResumeCandidates(
  sessions: ReadonlyArray<SessionResumeRow>,
  options: {
    /** Registered path of the bound Workspace; only its sessions are offered. */
    workspacePath: string | undefined
    boundSessionIds?: ReadonlySet<string>
    /** Registry's archived set: archived sessions never resume (16.49). */
    archivedSessionIds?: ReadonlySet<string>
    query?: string | undefined
    nowMs?: number
    copy: CopyTable
  },
): SelectorOption[] {
  const query = (options.query ?? '').trim().toLowerCase()
  const nowMs = options.nowMs ?? Date.now()
  const bound = options.boundSessionIds ?? new Set<string>()
  const archived = options.archivedSessionIds ?? new Set<string>()
  const copy = options.copy
  const rows = sessions
    .filter(session => !session.blank && !bound.has(session.sessionId))
    // Subagent sessions are never resumable as top-level threads (the spec's
    // "Subagent Session selected" refusal) — offering them only produces
    // selections that must fail (16.48).
    .filter(session => session.origin !== 'subagent')
    // Archived sessions adopt fine but never run a turn — the user waits in
    // a dead thread. `workspace.list` carries the registry's archived set;
    // sessions.list rows have no archived marker (16.49).
    .filter(session => !archived.has(session.sessionId))
    // Workspace scoping (16.44): a session belongs to the channel's Workspace
    // only when its recorded cwd is that Workspace's registered path.
    // Sessions with no recorded cwd cannot be attributed and are never
    // offered.
    .filter(session => options.workspacePath === undefined || session.cwd === options.workspacePath)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const options_: SelectorOption[] = rows.map(session => ({
    label: candidateLabel(copy, session, nowMs),
    value: session.sessionId,
  }))
  const counts = new Map<string, number>()
  for (const option of options_) counts.set(option.label, (counts.get(option.label) ?? 0) + 1)
  const disambiguated = options_.map(option =>
    (counts.get(option.label) ?? 0) > 1
      ? { label: `${option.label} · ${shortId(option.value)}`.slice(0, DISCORD_CHOICE_NAME_MAX), value: option.value }
      : option)
  if (query === '') return disambiguated
  return disambiguated.filter(option =>
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

/**
 * The composition-root wiring for the router's `resumeCandidates` dep
 * (16.44): one Host listing per call, filtered by the handed-in workspace
 * path against the live thread-ownership set. Listing failure is logged at
 * the face (`…failed`/`…timeout`) and degrades to `unavailable` — Discord
 * autocomplete then answers empty choices, never an unanswered interaction.
 */
export function createResumeCandidatesPort(deps: {
  listSessions: SessionCatalogPort['listSessions']
  /** Sessions this adapter already owns a thread for, re-read per call. */
  boundSessionIds: () => ReadonlySet<string>
  copy: CopyTable
}): ResumeCandidatesPort {
  return async (query, workspacePath, archivedSessionIds) => {
    if (workspacePath === undefined) return { outcome: 'unavailable' }
    const summaries = await deps.listSessions()
    if (summaries.outcome !== 'completed') return { outcome: 'unavailable' }
    const candidates = buildResumeCandidates(summaries.sessions, {
      workspacePath,
      boundSessionIds: deps.boundSessionIds(),
      ...(archivedSessionIds === undefined ? {} : { archivedSessionIds }),
      query,
      copy: deps.copy,
    })
    return { outcome: 'ok', options: filterResumeCandidates(candidates, query, 25) }
  }
}
