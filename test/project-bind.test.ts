/**
 * `/project bind` tests (7.2): only Workspace administrators (and above) may
 * bind; the durable write is two-phase — a plan that snapshots the current
 * binding, then an explicit confirmation that commits through the
 * revision-fenced store; a selection referencing a since-deleted Workspace
 * reports stale without writing; and a cancelled confirmation never touches
 * the store.
 */

import { describe, expect, it } from 'vitest'

import { createKvTableStub } from './helpers/kv-table.js'
import { createBindingStore, type ChannelBindingStore } from '../src/state/bindings.js'
import type { ChannelBinding } from '../src/state/records.js'
import { createProjectBindFlow, type WorkspaceResolver } from '../src/features/project-bind.js'

const SCOPE = { applicationId: '111', guildId: '333333333333333333', channelId: '444444444444444444' }
const ADMIN = { allowed: true, level: 'workspace-administrator' } as const
const MEMBER = { allowed: true, level: 'member' } as const

function foundWorkspace(fallbackId = 'ws-9'): WorkspaceResolver {
  return {
    resolve: (reference: string) => Promise.resolve({
      outcome: 'found',
      workspace: {
        id: reference.startsWith('ws:') ? reference.slice(3) : fallbackId,
        title: 'Target',
      },
    }),
  }
}

function setup(resolver: WorkspaceResolver = foundWorkspace()) {
  const store: ChannelBindingStore = createBindingStore<ChannelBinding>(createKvTableStub())
  const flow = createProjectBindFlow({ resolver, bindings: store })
  return { store, flow }
}

describe('/project bind authorization', () => {
  it('binds for a workspace administrator', async () => {
    const { flow, store } = setup()
    const plan = await flow.plan({ decision: ADMIN, scope: SCOPE, actorId: '555555555555555555', reference: 'ws:ws-9', confirmed: true })
    const result = await flow.commit(plan)
    expect(result).toMatchObject({ outcome: 'bound', binding: { workspaceId: 'ws-9', revision: 1 } })
    expect(store.get('app:111:guild:333333333333333333:channel:444444444444444444')?.workspaceId).toBe('ws-9')
  })

  it('ranks host operators at administrator authority', async () => {
    const { flow } = setup()
    const plan = await flow.plan({
      decision: { allowed: true, level: 'host-operator' } as const,
      scope: SCOPE,
      actorId: '555555555555555555',
      reference: 'ws:ws-9',
      confirmed: true,
    })
    expect(plan).toMatchObject({ outcome: 'planned' })
  })

  it('refuses ordinary members before any DSH or store access', async () => {
    const { flow } = setup()
    const plan = await flow.plan({ decision: MEMBER, scope: SCOPE, actorId: '555555555555555555', reference: 'ws:ws-9', confirmed: true })
    expect(plan).toEqual({ outcome: 'refused', reason: 'not-authorized' })
  })
})

describe('/project bind confirmation', () => {
  it('does not write until the user confirms', async () => {
    const { flow, store } = setup()
    const plan = await flow.plan({ decision: ADMIN, scope: SCOPE, actorId: '555555555555555555', reference: 'ws:ws-9', confirmed: false })
    expect(plan).toMatchObject({ outcome: 'planned' })
    expect(store.get('app:111:guild:333333333333333333:channel:444444444444444444')).toBeUndefined()

    const result = await flow.commit(plan)
    expect(result).toMatchObject({ outcome: 'bound' })
  })

  it('reports a cancelled confirmation without writing', async () => {
    const { flow, store } = setup()
    const plan = await flow.plan({ decision: ADMIN, scope: SCOPE, actorId: '555555555555555555', reference: 'ws:ws-9', confirmed: false })
    const result = await flow.commit(plan, { cancelled: true })
    expect(result).toEqual({ outcome: 'cancelled' })
    expect(store.get('app:111:guild:333333333333333333:channel:444444444444444444')).toBeUndefined()
  })

  it('rebinding an already-bound channel goes through the revision fence', async () => {
    const { flow, store } = setup()
    const first = await flow.plan({ decision: ADMIN, scope: SCOPE, actorId: '555555555555555555', reference: 'ws:ws-9', confirmed: true })
    await flow.commit(first)

    // Plan over the existing binding: the plan snapshots its revision.
    const second = await flow.plan({ decision: ADMIN, scope: SCOPE, actorId: '555555555555555555', reference: 'ws:ws-8', confirmed: true })
    if (second.outcome !== 'planned') throw new Error('expected planned')
    expect(second.previousRevision).toBe(1)

    const result = await flow.commit(second)
    expect(result).toMatchObject({ outcome: 'bound', binding: { workspaceId: 'ws-8', revision: 2 } })

    // A stale concurrent commit loses.
    const stale = await flow.commit(second)
    expect(stale).toMatchObject({ outcome: 'stale-revision' })
    expect(store.get('app:111:guild:333333333333333333:channel:444444444444444444')?.revision).toBe(2)
  })
})

describe('/project bind stale workspace', () => {
  it('reports a since-deleted workspace without writing', async () => {
    const { flow, store } = setup({
      resolve: () => Promise.resolve({ outcome: 'stale' }),
    })
    const plan = await flow.plan({ decision: ADMIN, scope: SCOPE, actorId: '555555555555555555', reference: 'ws:gone', confirmed: true })
    expect(plan).toEqual({ outcome: 'refused', reason: 'workspace-no-longer-registered' })
    expect(store.get('app:111:guild:333333333333333333:channel:444444444444444444')).toBeUndefined()
  })

  it('reports a resolver failure as sanitized and writes nothing', async () => {
    const { flow, store } = setup({
      resolve: () => Promise.resolve({ outcome: 'unknown' }),
    })
    const plan = await flow.plan({ decision: ADMIN, scope: SCOPE, actorId: '555555555555555555', reference: 'ws:x', confirmed: true })
    expect(plan).toEqual({ outcome: 'refused', reason: 'workspace-catalog-unavailable' })
    expect(store.get('app:111:guild:333333333333333333:channel:444444444444444444')).toBeUndefined()
  })
})
