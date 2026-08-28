/**
 * `/project list` discovery (design.md §3, §13). The feature talks to DSH
 * through one narrow port (satisfied by the apiProxy adapter in production,
 * by fakes in tests): every registered Workspace is selectable, labels come
 * from the least-disclosure policy (safe titles, opaque `ws:` references,
 * duplicate disambiguation, never a canonical path), and large catalogs page
 * inside Discord's component limit with interaction-scoped navigation values.
 * Catalog failures surface as sanitized outcomes — no raw provider detail
 * ever reaches Discord.
 */

import { filterAutocomplete, paginateSelector, type SelectorOption } from '../discord/selector.js'
import { safeTitle, workspaceLabels, workspaceReference } from '../policy/disclosure.js'

/** How the feature reads the DSH Workspace catalog. */
export interface ProjectListPort {
  listWorkspaces(): Promise<
    | { outcome: 'completed'; workspaces: ReadonlyArray<{ id: string; title: string }> }
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
 * Kimaki `/resume` pattern: the option lists live candidates as you type,
 * so no id is ever copy-pasted). Label work comes from the same sanitized
 * labels as `/project list`; the query narrows via the shared filter.
 */
export function workspaceAutocompleteChoices(
  catalog: ReadonlyArray<{ id: string; title: string }>,
  query: string,
): AutocompleteChoice[] {
  const entries = catalog.map(workspace => ({
    id: workspace.id,
    title: safeTitle(workspace.title),
  }))
  const labeled = workspaceLabels(entries)
  const selectable: SelectorOption[] = labeled.map(entry => ({
    label: entry.label,
    value: workspaceReference(entry.id),
  }))
  const matches = filterAutocomplete(selectable, query, Number.POSITIVE_INFINITY)
  return matches.map(match => ({ name: match.label, value: match.value }))
}
