/**
 * Thread routing tests (7.4). Rebinding a project channel changes only the
 * Workspace used by FUTURE threads: a thread already bound to its Session
 * keeps that Session and its immutable cwd workspace no matter how many times
 * the parent channel rebinds, and only subsequently created threads route
 * through the new binding.
 */

import { describe, expect, it } from 'vitest'

import { createKvTableStub } from './helpers/kv-table.js'
import { createBindingStore } from '../src/state/bindings.js'
import type { ThreadBinding } from '../src/state/records.js'
import { threadBindingKey } from '../src/state/domain.js'
import { createThreadRoutingService } from '../src/features/thread-routing.js'

const APP = '111'
const GUILD = 'g1'

function setup() {
  const table = createKvTableStub<ThreadBinding>()
  const store = createBindingStore(table)
  const service = createThreadRoutingService({ threadBindings: store, applicationId: APP })
  return { service, table, store }
}

function seedThread(service: ReturnType<typeof createThreadRoutingService>, threadId: string, sessionId: string, workspaceId: string): Promise<unknown> {
  return service.bindThread({
    scope: { applicationId: APP, guildId: GUILD, threadId },
    request: { sessionId, workspaceId, createdBy: 'u1', nowMs: 100 },
  })
}

describe('thread routing', () => {
  it('routes a thread with a session binding to that session and workspace', async () => {
    const { service } = setup()
    await seedThread(service, 't1', 'sess-1', 'ws-original')

    const route = service.route({
      guildId: GUILD,
      threadId: 't1',
      channelWorkspaceId: 'ws-REBOUND',
    })
    expect(route).toEqual({ route: 'existing-session', sessionId: 'sess-1', workspaceId: 'ws-original' })
  })

  it('routes a fresh thread through the channel binding at mention time', () => {
    const { service } = setup()
    const route = service.route({
      guildId: GUILD,
      threadId: 't-new',
      channelWorkspaceId: 'ws-current',
    })
    expect(route).toEqual({ route: 'new-session', workspaceId: 'ws-current' })
  })

  it('keeps existing threads on their original session after a channel rebind', async () => {
    const { service, table } = setup()
    await seedThread(service, 't1', 'sess-1', 'ws-original')
    await seedThread(service, 't2', 'sess-2', 'ws-original')

    // The parent channel rebinds to a new workspace.
    const channelWorkspaceId = 'ws-REBOUND'

    // Old threads keep their original sessions and cwd workspaces.
    expect(service.route({ guildId: GUILD, threadId: 't1', channelWorkspaceId }))
      .toEqual({ route: 'existing-session', sessionId: 'sess-1', workspaceId: 'ws-original' })
    expect(service.route({ guildId: GUILD, threadId: 't2', channelWorkspaceId }))
      .toEqual({ route: 'existing-session', sessionId: 'sess-2', workspaceId: 'ws-original' })

    // Only a subsequently created thread routes through the new workspace.
    expect(service.route({ guildId: GUILD, threadId: 't-fresh', channelWorkspaceId }))
      .toEqual({ route: 'new-session', workspaceId: 'ws-REBOUND' })

    // And the rebind structurally never rewrote the thread bindings.
    expect(table.get(threadBindingKey({ applicationId: APP, guildId: GUILD, threadId: 't1' }))?.workspaceId)
      .toBe('ws-original')
  })

  it('reports unbound when neither the thread nor the channel carries a binding', () => {
    const { service } = setup()
    const route = service.route({ guildId: GUILD, threadId: 't-none', channelWorkspaceId: undefined })
    expect(route).toEqual({ route: 'unbound' })
  })

  it('binds a thread once and refuses a conflicting second binding', async () => {
    const { service } = setup()
    const first = await seedThread(service, 't1', 'sess-1', 'ws-original')
    expect(first).toMatchObject({ ok: true })
    const second = await seedThread(service, 't1', 'sess-OTHER', 'ws-original')
    expect(second).toEqual({ ok: false, error: 'already-bound' })
    expect(service.route({ guildId: GUILD, threadId: 't1', channelWorkspaceId: 'ws-x' }))
      .toEqual({ route: 'existing-session', sessionId: 'sess-1', workspaceId: 'ws-original' })
  })
})
