/**
 * The /permission host-face port (16.59): the permission-presets catalog,
 * the session's `permissions` projection read, and the switch through the
 * Host's own `/permission` command path (resolveAgent → commands.execute).
 * Contract under test: plain values in and out, thrown RemoteErrors mapped
 * onto stable outcome vocabulary, every call bounded, terminal outcomes
 * logged. Signatures mirror the 2026-09-19 real-host probe (0.1.6-alpha.2).
 */

import { describe, expect, it, vi } from 'vitest'

import {
  createPermissionPort,
  permissionCatalog,
  switchSessionPermission,
  type DshCommandsFace,
  type DshHostFace,
  type DshPermissionPresetsFace,
  type DshSessionControllerFace,
} from '../src/dsh/host-face.js'

/** The probe-verified catalog shape: {options: [{value, name}…]}. */
const CATALOG = {
  options: [
    { value: 'read-only', name: 'read-only' },
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access' },
  ],
}

/** The probe-verified execute result: {commandId, result: {kind, text}}. */
const EXECUTE_SUCCESS = { commandId: 'cmd-1', result: { kind: 'success', text: 'preset read-only' } }
const EXECUTE_ERROR = { commandId: 'cmd-2', result: { kind: 'error', text: 'unknown preset "x" (available: …)' } }

function permissionFace(input: {
  catalog?: () => Promise<unknown>
  observe?: () => Promise<unknown>
  resolveAgent?: () => Promise<unknown>
  execute?: (line: string) => Promise<unknown>
  signal?: AbortSignal
} = {}): DshHostFace {
  const agent = { id: 'agent-1', session: {} }
  return {
    session: {
      prompt: () => { throw new Error('not under test') },
      create: () => { throw new Error('not under test') },
      list: () => { throw new Error('not under test') },
      cancel: () => { throw new Error('not under test') },
      updateQueue: () => { throw new Error('not under test') },
      selectModel: () => { throw new Error('not under test') },
      modelCatalog: () => { throw new Error('not under test') },
      follow: () => { throw new Error('not under test') },
      control: () => { throw new Error('not under test') },
      resolveAgent: () => (input.resolveAgent ? input.resolveAgent() : Promise.resolve({ agent })) as ReturnType<DshSessionControllerFace['resolveAgent']>,
    },
    workspace: { follow: () => { throw new Error('not under test') } },
    sessionQuery: {
      observeSession: () => (input.observe ? input.observe() : Promise.resolve({
        projections: { values: { permissions: { currentValue: 'workspace-write' } } },
      })) as ReturnType<DshHostFace['sessionQuery']['observeSession']>,
    },
    commands: {
      execute: (_agent: unknown, line: string, _attachments: readonly unknown[], signal: AbortSignal) => {
        if (input.signal !== undefined && signal !== input.signal) throw new TypeError('signal must pass through')
        return (input.execute ? input.execute(line) : Promise.resolve(EXECUTE_SUCCESS)) as ReturnType<DshCommandsFace['execute']>
      },
    },
    permissionPresets: {
      catalog: () => (input.catalog ? input.catalog() : Promise.resolve(CATALOG)) as ReturnType<DshPermissionPresetsFace['catalog']>,
    },
  }
}

describe('permissionCatalog', () => {
  it('normalizes the probe-verified catalog shape onto entries', async () => {
    const outcome = await permissionCatalog(permissionFace())
    expect(outcome).toEqual({
      outcome: 'completed',
      entries: [
        { value: 'read-only', name: 'read-only' },
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
    })
  })

  it('tolerates entries without a name and drops malformed rows', async () => {
    const outcome = await permissionCatalog(permissionFace({
      catalog: () => Promise.resolve({ options: [{ value: 'a' }, { value: 42 }, 'junk', { value: 'b', name: 'B' }] }),
    }))
    expect(outcome).toEqual({
      outcome: 'completed',
      entries: [{ value: 'a' }, { value: 'b', name: 'B' }],
    })
  })

  it('maps a malformed catalog body onto failed, never a completed empty catalog', async () => {
    const outcome = await permissionCatalog(permissionFace({ catalog: () => Promise.resolve({}) }))
    expect(outcome.outcome).toBe('failed')
  })

  it('maps a Host rejection onto failed', async () => {
    const outcome = await permissionCatalog(permissionFace({
      catalog: () => Promise.reject(Object.assign(new Error('boom'), { code: 'internal' })),
    }))
    expect(outcome.outcome).toBe('failed')
  })
})

describe('switchSessionPermission', () => {
  it('runs the /permission command against the resolved agent', async () => {
    const execute = vi.fn((_line: string) => Promise.resolve(EXECUTE_SUCCESS))
    const outcome = await switchSessionPermission(permissionFace({ execute }), { sessionId: 'sess-1', preset: 'read-only' })
    expect(outcome).toEqual({ outcome: 'completed', preset: 'read-only' })
    expect(execute).toHaveBeenCalledWith('/permission read-only')
  })

  it('carries the command error text as the rejection reason', async () => {
    const outcome = await switchSessionPermission(
      permissionFace({ execute: () => Promise.resolve(EXECUTE_ERROR) }),
      { sessionId: 'sess-1', preset: 'x' },
    )
    expect(outcome).toEqual({ outcome: 'rejected', reason: 'unknown preset "x" (available: …)' })
  })

  it('reports the resolveAgent error as a rejection with its message', async () => {
    const outcome = await switchSessionPermission(
      permissionFace({ resolveAgent: () => Promise.resolve({ error: { code: 'session/not-found', message: 'no such session' } }) }),
      { sessionId: 'sess-x', preset: 'read-only' },
    )
    expect(outcome).toEqual({ outcome: 'rejected', reason: 'no such session' })
  })

  it('maps an unmatched command (undefined) onto rejected — the host lacks /permission', async () => {
    const outcome = await switchSessionPermission(
      permissionFace({ execute: () => Promise.resolve(undefined) }),
      { sessionId: 'sess-1', preset: 'read-only' },
    )
    expect(outcome.outcome).toBe('rejected')
  })

  it('maps a thrown execute onto unknown (the command may have run — never retry)', async () => {
    const outcome = await switchSessionPermission(
      permissionFace({ execute: () => Promise.reject(new Error('void')) }),
      { sessionId: 'sess-1', preset: 'read-only' },
    )
    expect(outcome.outcome).toBe('unknown')
  })
})

describe('createPermissionPort', () => {
  it('reads the current preset off the permissions projection view', async () => {
    const port = createPermissionPort(permissionFace(), { log: () => {} })
    await expect(port.current('sess-1')).resolves.toEqual({ outcome: 'completed', preset: 'workspace-write' })
  })

  it('treats a missing permissions projection as a plain failed read (older host)', async () => {
    const port = createPermissionPort(permissionFace({ observe: () => Promise.resolve({ projections: { values: {} } }) }), { log: () => {} })
    await expect(port.current('sess-1')).resolves.toEqual({ outcome: 'failed' })
  })

  it('disposes the observation after reading (projection pinning is the host contract)', async () => {
    let disposed = 0
    const observation = {
      projections: { values: { permissions: { currentValue: 'read-only' } } },
      [Symbol.asyncDispose]: () => { disposed += 1 },
    }
    const port = createPermissionPort(permissionFace({ observe: () => Promise.resolve(observation) }), { log: () => {} })
    await port.current('sess-1')
    expect(disposed).toBe(1)
  })
})
