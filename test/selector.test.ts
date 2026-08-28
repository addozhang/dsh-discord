/**
 * Selector model tests: autocomplete ranking/cutting and select-menu paging
 * that always respects Discord's 25-entry component limit.
 */

import { describe, expect, it } from 'vitest'

import {
  DISCORD_SELECT_LIMIT,
  filterAutocomplete,
  paginateSelector,
  type SelectorOption,
} from '../src/discord/selector.js'

function options(...labels: string[]): SelectorOption[] {
  return labels.map(label => ({ label, value: label.toLowerCase() }))
}

function range(count: number): SelectorOption[] {
  return Array.from({ length: count }, (_, index) => ({
    label: `item-${String(index).padStart(3, '0')}`,
    value: `v-${String(index)}`,
  }))
}

describe('filterAutocomplete', () => {
  it('keeps the original order for an empty query, cut to the limit', () => {
    const list = range(40)
    const result = filterAutocomplete(list, '')
    expect(result).toHaveLength(DISCORD_SELECT_LIMIT)
    expect(result[0]).toEqual(list[0])
  })

  it('filters case-insensitively by substring', () => {
    const result = filterAutocomplete(options('Alpha', 'beta', 'GAMMA', 'alphabet'), 'alp')
    expect(result.map(option => option.label)).toEqual(['Alpha', 'alphabet'])
  })

  it('ranks prefix matches above substring matches', () => {
    const result = filterAutocomplete(options('xabc', 'abc', 'aabc'), 'abc')
    expect(result.map(option => option.label)).toEqual(['abc', 'xabc', 'aabc'])
  })

  it('returns nothing when nothing matches', () => {
    expect(filterAutocomplete(options('a', 'b'), 'zzz')).toEqual([])
  })

  it('cuts ranked results to the Discord limit', () => {
    const list = Array.from({ length: 60 }, (_, index) => ({
      label: `abc-${String(index)}`,
      value: `v-${String(index)}`,
    }))
    const result = filterAutocomplete(list, 'abc')
    expect(result).toHaveLength(DISCORD_SELECT_LIMIT)
  })
})

describe('paginateSelector', () => {
  it('renders up to 25 entries on a single page with no navigation', () => {
    const list = range(20)
    const page = paginateSelector(list, 0)
    expect(page.items).toEqual(list)
    expect(page.pageCount).toBe(1)
    expect(page.hasPrev).toBe(false)
    expect(page.hasNext).toBe(false)
    expect(page.navValues).toEqual({})
  })

  it('splits 26 entries into two 24-entry pages', () => {
    const list = range(26)
    const first = paginateSelector(list, 0)
    expect(first.items).toHaveLength(24)
    expect(first.pageCount).toBe(2)
    expect(first.hasPrev).toBe(false)
    expect(first.hasNext).toBe(true)
    expect(first.navValues).toEqual({ next: '__page__:1' })

    const second = paginateSelector(list, 1)
    expect(second.items).toHaveLength(2)
    expect(second.hasPrev).toBe(true)
    expect(second.hasNext).toBe(false)
    expect(second.navValues).toEqual({ prev: '__page__:0' })
    expect([...first.items, ...second.items]).toEqual(list)
  })

  it('budgets every page of a multi-page set to 23 entries', () => {
    const list = range(70)
    const middle = paginateSelector(list, 1)
    expect(middle.items).toHaveLength(23)
    expect(middle.navValues).toEqual({ prev: '__page__:0', next: '__page__:2' })

    const first = paginateSelector(list, 0)
    expect(first.items).toHaveLength(23)

    const pages = Array.from({ length: paginateSelector(list, 0).pageCount }, (_, index) => paginateSelector(list, index))
    expect(pages.flatMap(page => page.items)).toEqual(list)
    expect(pages.every(page => page.items.length + Object.keys(page.navValues).length <= DISCORD_SELECT_LIMIT)).toBe(true)
  })

  it('clamps out-of-range page requests into range', () => {
    const list = range(60)
    expect(paginateSelector(list, -5).pageIndex).toBe(0)
    expect(paginateSelector(list, 99).pageIndex).toBe(paginateSelector(list, 0).pageCount - 1)
  })

  it('accepts a custom sentinel for opaque id wrapping', () => {
    const page = paginateSelector(range(30), 0, 'sel:abc')
    expect(page.navValues.next).toBe('sel:abc:1')
  })
})
