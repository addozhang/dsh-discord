/**
 * `/project list` discovery tests (7.1) against a fake DSH port: every
 * registered Workspace is selectable with safe duplicate-title labels and
 * opaque values, a query narrows results, large catalogs paginate within
 * Discord's component limit, and port failures surface as sanitized
 * outcomes. Autocomplete labels additionally carry the abbreviated
 * canonical path per amended design §3 (16.1).
 */

import { describe, expect, it } from 'vitest'

import { createProjectListView, workspaceAutocompleteChoices, type ProjectListPort } from '../src/features/project-list.js'
import { abbreviatePath } from '../src/policy/disclosure.js'

function okPort(items: Array<{ id: string; title: string }>): ProjectListPort {
  return {
    listWorkspaces: () => Promise.resolve({ outcome: 'completed', workspaces: items }),
  }
}

const CATALOG = [
  { id: 'aaaaaaaa-1234', title: 'Alpha' },
  { id: 'bbbbbbbb-5678', title: 'Beta' },
  { id: 'cccccccc-1234', title: 'Alpha' },
]

describe('/project list', () => {
  it('lists every registered workspace with opaque values and path-free labels', async () => {
    const view = await createProjectListView(okPort(CATALOG), { selectionId: 'sel-1' })
    expect(view.outcome).toBe('ok')
    if (view.outcome !== 'ok') return
    expect(view.items).toHaveLength(3)
    for (const item of view.items) {
      expect(item.value.startsWith('ws:')).toBe(true)
      expect(JSON.stringify(item)).not.toContain('/srv')
    }
    expect(view.items.map(item => item.value).sort()).toEqual([
      'ws:aaaaaaaa-1234',
      'ws:bbbbbbbb-5678',
      'ws:cccccccc-1234',
    ])
  })

  it('disambiguates duplicate titles while staying unique', async () => {
    const view = await createProjectListView(okPort(CATALOG), { selectionId: 'sel-1' })
    if (view.outcome !== 'ok') return
    const labels = view.items.map(item => item.label)
    expect(new Set(labels).size).toBe(3)
    expect(labels).toContain('Alpha (aaa-1234)')
    expect(labels).toContain('Alpha (ccc-1234)')
    expect(labels).toContain('Beta')
  })

  it('narrows results with a case-insensitive query', async () => {
    const view = await createProjectListView(okPort(CATALOG), { selectionId: 'sel-1', query: 'beTA' })
    if (view.outcome !== 'ok') return
    expect(view.items.map(item => item.value)).toEqual(['ws:bbbbbbbb-5678'])
  })

  it('paginates large catalogs inside the 25-entry component limit', async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      id: `ws-${String(index).padStart(3, '0')}`,
      title: `project-${String(index).padStart(3, '0')}`,
    }))
    const first = await createProjectListView(okPort(many), { selectionId: 'sel-9', page: 0 })
    if (first.outcome !== 'ok') return
    expect(first.pageCount).toBeGreaterThan(2)
    expect(first.items.length + Object.keys(first.navValues).length).toBeLessThanOrEqual(25)
    expect(first.navValues.next).toBe('sel-9:page:1')

    const second = await createProjectListView(okPort(many), { selectionId: 'sel-9', page: 99 })
    if (second.outcome !== 'ok') return
    expect(second.pageIndex).toBe(second.pageCount - 1)
    expect(second.hasNext).toBe(false)
  })

  it('renders an empty catalog as a valid empty list', async () => {
    const view = await createProjectListView(okPort([]), { selectionId: 'sel-1' })
    expect(view).toMatchObject({ outcome: 'ok', items: [], pageCount: 1 })
  })

  it('maps a failed catalog read to a sanitized failure', async () => {
    const port: ProjectListPort = {
      listWorkspaces: () => Promise.resolve({ outcome: 'failed' }),
    }
    const view = await createProjectListView(port, { selectionId: 'sel-1' })
    expect(view).toEqual({ outcome: 'failed', reason: 'workspace-catalog-unavailable' })
  })

  it('maps an unknown catalog outcome to a sanitized failure', async () => {
    const port: ProjectListPort = {
      listWorkspaces: () => Promise.resolve({ outcome: 'unknown' }),
    }
    const view = await createProjectListView(port, { selectionId: 'sel-1' })
    expect(view).toEqual({ outcome: 'failed', reason: 'workspace-catalog-unknown' })
  })
})

describe('bind autocomplete labels (16.1)', () => {
  it('appends the abbreviated canonical path when the Host supplies one', () => {
    const choices = workspaceAutocompleteChoices([
      { id: 'aaaaaaaa-1234', title: 'fiber', path: '/Users/addo/Workspaces/private_w/fiber' },
      { id: 'bbbbbbbb-5678', title: 'beta' },
    ], '', { home: '/Users/addo' })
    expect(choices).toEqual([
      { name: 'fiber (~/Workspaces/private_w/fiber)', value: 'ws:aaaaaaaa-1234' },
      { name: 'beta', value: 'ws:bbbbbbbb-5678' },
    ])
  })

  it('lets the query match path text and falls back past the 100-character cap', () => {
    const longPath = `/Users/addo/${'x'.repeat(120)}`
    const choices = workspaceAutocompleteChoices([
      { id: 'aaaaaaaa-1234', title: 'huge', path: longPath },
      { id: 'bbbbbbbb-5678', title: 'beta', path: '/Users/addo/code/beta' },
    ], 'code/beta', { home: '/Users/addo' })
    expect(choices).toEqual([{ name: 'beta (~/code/beta)', value: 'ws:bbbbbbbb-5678' }])
  })

  it('abbreviates only an exact home-directory prefix', () => {
    expect(abbreviatePath('/Users/addo/Workspaces/x', '/Users/addo')).toBe('~/Workspaces/x')
    expect(abbreviatePath('/srv/elsewhere/x', '/Users/addo')).toBe('/srv/elsewhere/x')
    expect(abbreviatePath('/Users/addoish/x', '/Users/addo')).toBe('/Users/addoish/x')
  })
})
