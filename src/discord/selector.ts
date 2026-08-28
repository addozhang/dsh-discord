/**
 * Autocomplete filtering and select-menu pagination as pure models. Discord
 * caps autocomplete and select components at 25 entries; filtering ranks
 * prefix matches above substring matches case-insensitively, and the pager
 * budgets navigation entries into the same 25-slot limit so a page is always
 * directly renderable as one component.
 */

/** A selectable entry as Discord renders it. */
export interface SelectorOption {
  label: string
  value: string
  description?: string
}

/** Discord's hard cap for autocomplete choices and select-menu options. */
export const DISCORD_SELECT_LIMIT = 25

/** Sentinel value shape for navigation entries; wrapped into opaque ids later. */
export interface SelectorPage<T extends SelectorOption = SelectorOption> {
  items: T[]
  pageIndex: number
  pageCount: number
  hasPrev: boolean
  hasNext: boolean
  /** Value of the prev/next navigation entries present on this page. */
  navValues: { prev?: string; next?: string }
}

/**
 * Rank and cut options for an autocomplete response: empty queries keep the
 * original order; otherwise prefix matches outrank substring matches and
 * non-matches are dropped, ties keep input order.
 */
export function filterAutocomplete(
  options: readonly SelectorOption[],
  query: string,
  limit: number = DISCORD_SELECT_LIMIT,
): SelectorOption[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return options.slice(0, limit)

  const prefix: SelectorOption[] = []
  const substring: SelectorOption[] = []
  for (const option of options) {
    const haystack = option.label.toLowerCase()
    if (haystack.startsWith(needle)) prefix.push(option)
    else if (haystack.includes(needle)) substring.push(option)
  }
  return [...prefix, ...substring].slice(0, limit)
}

/**
 * Derive a self-consistent page budget: a single page needs no navigation and
 * holds 25 entries; two pages hold 24 data entries each (one nav slot);
 * three or more pages hold 23 (middle pages need prev and next). The chosen
 * page count always re-derives from its own per-page budget.
 */
function computeBudget(total: number): { pageCount: number; perPage: number } {
  if (total <= DISCORD_SELECT_LIMIT) return { pageCount: 1, perPage: DISCORD_SELECT_LIMIT }
  for (const perPage of [DISCORD_SELECT_LIMIT - 1, DISCORD_SELECT_LIMIT - 2]) {
    const pageCount = Math.ceil(total / perPage)
    const requiredPerPage = pageCount === 2 ? DISCORD_SELECT_LIMIT - 1 : DISCORD_SELECT_LIMIT - 2
    if (perPage === requiredPerPage) return { pageCount, perPage }
  }
  const perPage = DISCORD_SELECT_LIMIT - 2
  return { pageCount: Math.ceil(total / perPage), perPage }
}

/**
 * Slice options into one renderable page. Navigation entries spend slots of
 * the same 25-entry budget. Out-of-range indices clamp into range.
 */
export function paginateSelector<T extends SelectorOption>(
  options: readonly T[],
  requestedIndex: number,
  sentinel = '__page__',
): SelectorPage<T> {
  const { pageCount, perPage } = computeBudget(options.length)
  const pageIndex = Math.min(Math.max(requestedIndex, 0), pageCount - 1)
  const hasPrev = pageIndex > 0
  const hasNext = pageIndex < pageCount - 1

  const navValues: SelectorPage['navValues'] = {}
  if (hasPrev) navValues.prev = `${sentinel}:${String(pageIndex - 1)}`
  if (hasNext) navValues.next = `${sentinel}:${String(pageIndex + 1)}`

  return {
    items: options.slice(pageIndex * perPage, (pageIndex + 1) * perPage),
    pageIndex,
    pageCount,
    hasPrev,
    hasNext,
    navValues,
  }
}
