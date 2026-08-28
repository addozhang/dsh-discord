/**
 * Tool activity surface tests (11.8): parallel tool calls each get one
 * status row keyed by callId; labels come from a safe allowlist with a
 * generic fallback; raw arguments and output NEVER render; verbosity gates
 * whether tool rows appear at all.
 */

import { describe, expect, it } from 'vitest'

import { createToolActivitySurface } from '../src/stream/tool-view.js'

describe('tool activity surface', () => {
  it('keeps one row per callId through parallel, out-of-order completion', () => {
    const surface = createToolActivitySurface({ verbosity: 'essential-tools' })
    surface.record({ callId: 'c1', toolName: 'bash', state: 'running' })
    surface.record({ callId: 'c2', toolName: 'grep', state: 'running' })
    surface.record({ callId: 'c2', toolName: 'grep', state: 'succeeded' })
    surface.record({ callId: 'c1', toolName: 'bash', state: 'failed' })

    const rows = surface.render()
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.callId)).toEqual(['c1', 'c2'])
    expect(rows[0]).toMatchObject({ label: 'Shell', state: 'failed' })
    expect(rows[1]).toMatchObject({ label: 'Search', state: 'succeeded' })
  })

  it('falls back to a generic label for unknown tools without leaking the name', () => {
    const surface = createToolActivitySurface({ verbosity: 'essential-tools' })
    surface.record({ callId: 'c1', toolName: 'mcp__internal__secret_scan', state: 'running' })

    const rows = surface.render()
    expect(rows[0]?.label).toBe('Tool')
    expect(JSON.stringify(rows)).not.toContain('secret_scan')
  })

  it('never renders raw arguments or output', () => {
    const surface = createToolActivitySurface({ verbosity: 'full-tools' })
    surface.record({
      callId: 'c1',
      toolName: 'bash',
      state: 'succeeded',
      rawArguments: 'rm -rf / --data token123',
      rawOutput: 'SECRET OUTPUT',
    })

    const rendered = JSON.stringify(surface.render())
    expect(rendered).not.toContain('rm -rf')
    expect(rendered).not.toContain('token123')
    expect(rendered).not.toContain('SECRET OUTPUT')
  })

  it('verbosity text-only renders nothing', () => {
    const surface = createToolActivitySurface({ verbosity: 'text-only' })
    surface.record({ callId: 'c1', toolName: 'bash', state: 'running' })
    expect(surface.render()).toEqual([])
  })

  it('essential and full verbosity render the same bounded rows', () => {
    const record = (verbosity: 'essential-tools' | 'full-tools') => {
      const surface = createToolActivitySurface({ verbosity })
      surface.record({ callId: 'c1', toolName: 'bash', state: 'running' })
      surface.record({ callId: 'c2', toolName: 'unknown-tool', state: 'succeeded' })
      return surface.render()
    }
    expect(record('essential-tools')).toEqual(record('full-tools'))
  })

  it('marks interrupted tool rows', () => {
    const surface = createToolActivitySurface({ verbosity: 'essential-tools' })
    surface.record({ callId: 'c1', toolName: 'bash', state: 'running' })
    surface.record({ callId: 'c1', toolName: 'bash', state: 'interrupted' })
    expect(surface.render()[0]).toMatchObject({ state: 'interrupted' })
  })
})
