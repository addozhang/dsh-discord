/**
 * `/permission` tests (16.59–16.61): show reads the live catalog + the
 * session's current preset; the switch mutation is restricted to Host
 * operators by default (danger-full-access disables sandbox AND approval),
 * validates the preset against the live catalog, and goes through the Host
 * command path — the port reports exactly what the Host proved.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  CONFIRM_REQUIRED_PRESETS,
  applyPermissionPreset,
  requiresConfirmation,
  showPermission,
  type DshPermissionPort,
} from '../src/features/permission-control.js'

const OPERATOR = { allowed: true, level: 'host-operator' } as const
const GUILD_ADMIN = { allowed: true, level: 'workspace-administrator' } as const
const MEMBER = { allowed: true, level: 'member' } as const

const CATALOG = [
  { value: 'read-only', name: 'read-only' },
  { value: 'workspace-write', name: 'workspace-write' },
  { value: 'danger-full-access', name: 'danger-full-access' },
]

function makePort(overrides: {
  catalog?: DshPermissionPort['catalog']
  current?: DshPermissionPort['current']
  set?: DshPermissionPort['set']
} = {}): DshPermissionPort {
  return {
    catalog: overrides.catalog ?? ((): ReturnType<DshPermissionPort['catalog']> =>
      Promise.resolve({ outcome: 'completed', entries: CATALOG })),
    current: overrides.current ?? ((): ReturnType<DshPermissionPort['current']> =>
      Promise.resolve({ outcome: 'completed', preset: 'workspace-write' })),
    set: overrides.set ?? ((_sessionId: string, preset: string): ReturnType<DshPermissionPort['set']> =>
      Promise.resolve({ outcome: 'completed', preset })),
  }
}

describe('/permission show', () => {
  it('returns the current preset plus the switchable catalog entries', async () => {
    const view = await showPermission(makePort(), { sessionId: 'sess-1' })
    expect(view).toEqual({
      outcome: 'ok',
      current: 'workspace-write',
      entries: CATALOG.map(entry => entry.value),
    })
  })

  it('marks the view failed when the catalog read fails, even with a current value', async () => {
    const view = await showPermission(
      makePort({ catalog: () => Promise.resolve({ outcome: 'failed' }) }),
      { sessionId: 'sess-1' },
    )
    expect(view.outcome).toBe('failed')
  })

  it('still lists entries when the current value is unreadable (projection gap is not the catalog gap)', async () => {
    const view = await showPermission(
      makePort({ current: () => Promise.resolve({ outcome: 'failed' }) }),
      { sessionId: 'sess-1' },
    )
    expect(view).toEqual({ outcome: 'ok', current: undefined, entries: CATALOG.map(e => e.value) })
  })
})

describe('/permission set: authorization', () => {
  it('refuses a Guild administrator when the operator gate is on (default posture)', async () => {
    const result = await applyPermissionPreset(makePort(), {
      decision: GUILD_ADMIN,
      sessionId: 'sess-1',
      preset: 'read-only',
    })
    expect(result).toEqual({ outcome: 'refused', reason: 'not-host-operator' })
  })

  it('admits a plain member when the deployment loosened the gate (mirrors /model)', async () => {
    const result = await applyPermissionPreset(makePort(), {
      decision: MEMBER,
      sessionId: 'sess-1',
      preset: 'read-only',
      requireHostOperator: false,
    })
    expect(result).toEqual({ outcome: 'applied', preset: 'read-only' })
  })

  it('allows a workspace administrator when the deployment loosened the gate', async () => {
    const result = await applyPermissionPreset(makePort(), {
      decision: GUILD_ADMIN,
      sessionId: 'sess-1',
      preset: 'read-only',
      requireHostOperator: false,
    })
    expect(result).toEqual({ outcome: 'applied', preset: 'read-only' })
  })

  it('refuses a denied decision outright (deny-first outranks any level)', async () => {
    const result = await applyPermissionPreset(makePort(), {
      decision: { allowed: false, reason: 'denied' },
      sessionId: 'sess-1',
      preset: 'read-only',
    })
    expect(result).toEqual({ outcome: 'refused', reason: 'not-host-operator' })
  })
})

describe('/permission set: catalog validation', () => {
  it('refuses a preset that is not in the live catalog (custom deployments differ)', async () => {
    const result = await applyPermissionPreset(makePort(), {
      decision: OPERATOR,
      sessionId: 'sess-1',
      preset: 'super-user',
    })
    expect(result).toEqual({ outcome: 'refused', reason: 'preset-not-in-catalog' })
  })

  it('refuses without mutation when the catalog read fails', async () => {
    const set = vi.fn()
    const result = await applyPermissionPreset(
      makePort({ catalog: () => Promise.resolve({ outcome: 'unknown' }), set }),
      { decision: OPERATOR, sessionId: 'sess-1', preset: 'read-only' },
    )
    expect(result).toEqual({ outcome: 'refused', reason: 'preset-not-in-catalog' })
    expect(set).not.toHaveBeenCalled()
  })
})

describe('/permission set: outcomes', () => {
  it('reports the applied preset', async () => {
    const result = await applyPermissionPreset(makePort(), {
      decision: OPERATOR,
      sessionId: 'sess-1',
      preset: 'read-only',
    })
    expect(result).toEqual({ outcome: 'applied', preset: 'read-only' })
  })

  it('carries the Host command error text as the rejection reason', async () => {
    const result = await applyPermissionPreset(
      makePort({ set: () => Promise.resolve({ outcome: 'rejected', reason: 'unknown preset "read-only" (available: …)' }) }),
      { decision: OPERATOR, sessionId: 'sess-1', preset: 'read-only' },
    )
    expect(result).toEqual({ outcome: 'rejected', reason: 'unknown preset "read-only" (available: …)' })
  })

  it('passes unknown through untouched (at-most-once posture: never retry blindly)', async () => {
    const result = await applyPermissionPreset(
      makePort({ set: () => Promise.resolve({ outcome: 'unknown' }) }),
      { decision: OPERATOR, sessionId: 'sess-1', preset: 'read-only' },
    )
    expect(result).toEqual({ outcome: 'unknown' })
  })
})

describe('danger-full-access confirmation', () => {
  it('flags exactly the canonical dangerous preset(s)', () => {
    expect(CONFIRM_REQUIRED_PRESETS).toEqual(['danger-full-access'])
    expect(requiresConfirmation('danger-full-access')).toBe(true)
    expect(requiresConfirmation('workspace-write')).toBe(false)
    expect(requiresConfirmation('read-only')).toBe(false)
    expect(requiresConfirmation('custom')).toBe(false)
  })
})
