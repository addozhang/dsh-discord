/**
 * `/project list` discovery (design.md §3, §13). The feature talks to DSH
 * through one narrow port (satisfied by the apiProxy adapter in production,
 * by fakes in tests): every registered Workspace is selectable, labels come
 * from the least-disclosure policy (safe titles, opaque `ws:` references,
 * duplicate disambiguation); per amended design §3 the bind autocomplete
 * appends the abbreviated canonical path to each candidate label. This
 * surface renders plain text, so it has no navigation: large catalogs are
 * reported honestly — first page items plus the total count for the caller's
 * truncation note — while the selector pagination helpers stay available to
 * select-based surfaces.
 * Catalog failures surface as sanitized outcomes — no raw provider detail
 * ever reaches Discord.
 */

import { filterAutocomplete, paginateSelector, type SelectorOption } from '../discord/selector.js'
import { abbreviatePath, safeTitle, workspaceLabels, workspaceReference } from '../policy/disclosure.js'

/** How the feature reads the DSH Workspace catalog. */
export interface ProjectListPort {
  listWorkspaces(): Promise<
    | { outcome: 'completed'; workspaces: ReadonlyArray<{ id: string; title: string; path?: string | undefined }> }
    | { outcome: 'failed' }
    | { outcome: 'unknown' }
  >
}

export interface ProjectListRequest {
  /** The unique id of this interaction, scoping page navigation values. */
  selectionId: string
  query?: string | undefined
  page?: number | undefined
}

export type ProjectListView =
  | {
      outcome: 'ok'
      items: SelectorOption[]
      /** The whole (query-filtered) catalog size, for truncation copy. */
      totalCount: number
      pageIndex: number
      pageCount: number
      hasPrev: boolean
      hasNext: boolean
      navValues: { prev?: string; next?: string }
    }
  | { outcome: 'failed'; reason: 'workspace-catalog-unavailable' | 'workspace-catalog-unknown' }

/**
 * Build the `/project list` view: fetch the catalog, sanitize and
 * disambiguate labels, apply the query, and page the result.
 */
export async function createProjectListView(port: ProjectListPort, request: ProjectListRequest): Promise<ProjectListView> {
  const catalog = await port.listWorkspaces()
  if (catalog.outcome === 'failed') {
    return { outcome: 'failed', reason: 'workspace-catalog-unavailable' }
  }
  if (catalog.outcome === 'unknown') {
    return { outcome: 'failed', reason: 'workspace-catalog-unknown' }
  }

  // Down-project to the two display fields before any label work, so the
  // canonical path is structurally out of every label below.
  const entries = catalog.workspaces.map(workspace => ({
    id: workspace.id,
    title: safeTitle(workspace.title),
  }))
  const labeled = workspaceLabels(entries)

  const query = request.query ?? ''
  const selectable: SelectorOption[] = labeled.map(entry => ({
    label: entry.label,
    value: entry.id,
  }))
  const matches = query.trim() === ''
    ? selectable
    : filterAutocomplete(selectable, query.trim(), Number.POSITIVE_INFINITY)

  const byId = new Map(labeled.map(entry => [entry.id, entry]))
  const options: SelectorOption[] = []
  for (const match of matches) {
    const entry = byId.get(match.value)
    if (entry === undefined) continue
    options.push({ label: entry.label, value: workspaceReference(entry.id) })
  }

  const page = paginateSelector(options, request.page ?? 0, `${request.selectionId}:page`)
  return {
    outcome: 'ok',
    items: page.items,
    totalCount: options.length,
    pageIndex: page.pageIndex,
    pageCount: page.pageCount,
    hasPrev: page.hasPrev,
    hasNext: page.hasNext,
    navValues: page.navValues,
  }
}

/** One Discord autocomplete choice: display label plus the opaque value. */
export interface AutocompleteChoice {
  name: string
  value: string
}

/**
 * Build the autocomplete choices for a workspace reference option (the
 * Live-candidates pattern: the option lists live candidates as you type,
 * so no id is ever copy-pasted). Labels carry the same sanitized base as
 * `/project list` plus the abbreviated canonical path when the
 * Host supplies one; the query narrows via the shared filter and matches
 * path text too. Labels exceeding Discord's 100-character choice-name
 * limit fall back to the bare sanitized label rather than truncating.
 */
export function workspaceAutocompleteChoices(
  catalog: ReadonlyArray<{ id: string; title: string; path?: string | undefined }>,
  query: string,
  options: { home?: string } = {},
): AutocompleteChoice[] {
  const entries = catalog.map(workspace => ({
    id: workspace.id,
    title: safeTitle(workspace.title),
  }))
  const labeled = workspaceLabels(entries)
  const selectable: SelectorOption[] = labeled.map((entry, index) => ({
    label: withAbbreviatedPath(entry.label, catalog[index]?.path, options.home),
    value: workspaceReference(entry.id),
  }))
  const matches = filterAutocomplete(selectable, query, Number.POSITIVE_INFINITY)
  return matches.map(match => ({ name: match.label, value: match.value }))
}

/** Discord caps autocomplete choice names at 100 characters. */
const DISCORD_CHOICE_NAME_MAX = 100

function withAbbreviatedPath(label: string, path: string | undefined, home: string | undefined): string {
  if (path === undefined || path === '') return label
  const candidate = `${label} (${abbreviatePath(path, home)})`
  return candidate.length <= DISCORD_CHOICE_NAME_MAX ? candidate : label
}
