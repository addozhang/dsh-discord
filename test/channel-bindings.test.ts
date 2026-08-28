/**
 * Channel-binding persistence tests (7.3). Bindings keyed by
 * application+guild+channel are fully independent across channels and across
 * guilds, concurrent rebinds of DIFFERENT channels both succeed, and a
 * concurrent rebind of the SAME channel resolves through the revision fence
 * (exactly one winner). Guild-scoped listing derives from parsed keys.
 */

import { describe, expect, it } from 'vitest'

import { createKvTableStub } from './helpers/kv-table.js'
import type { ChannelBinding } from '../src/state/records.js'
import { createBindingStore } from '../src/state/bindings.js'
import { channelBindingKey } from '../src/state/domain.js'
import { createChannelBindingService, type ChannelBindingService } from '../src/state/channel-bindings.js'

const APP = '111111111111111111'

function scope(guildId: string, channelId: string) {
  return { applicationId: APP, guildId, channelId }
}

function setup(): ChannelBindingService {
  const table = createKvTableStub<ChannelBinding>()
  const store = createBindingStore(table)
  return createChannelBindingService({ store, applicationId: APP, listKeys: () => table.keys() })
}

describe('channel binding service', () => {
  it('keeps bindings on different channels independent', async () => {
    const service = setup()
    await service.bind(scope('g1', 'chA'), { workspaceId: 'ws-1', actorId: 'u1', nowMs: 100 })
    await service.bind(scope('g1', 'chB'), { workspaceId: 'ws-2', actorId: 'u1', nowMs: 110 })

    expect(service.resolve(scope('g1', 'chA'))?.workspaceId).toBe('ws-1')
    expect(service.resolve(scope('g1', 'chB'))?.workspaceId).toBe('ws-2')
  })

  it('keeps the same channel id independent across guilds', async () => {
    const service = setup()
    await service.bind(scope('g1', 'shared'), { workspaceId: 'ws-1', actorId: 'u1', nowMs: 100 })
    await service.bind(scope('g2', 'shared'), { workspaceId: 'ws-9', actorId: 'u2', nowMs: 100 })

    expect(service.resolve(scope('g1', 'shared'))?.workspaceId).toBe('ws-1')
    expect(service.resolve(scope('g2', 'shared'))?.workspaceId).toBe('ws-9')
  })

  it('rebinds one channel without disturbing others', async () => {
    const service = setup()
    await service.bind(scope('g1', 'chA'), { workspaceId: 'ws-1', actorId: 'u1', nowMs: 100 })
    await service.bind(scope('g1', 'chB'), { workspaceId: 'ws-2', actorId: 'u1', nowMs: 100 })

    await service.bind(scope('g1', 'chA'), { workspaceId: 'ws-3', actorId: 'u1', nowMs: 200 }, { expectedRevision: 1 })

    expect(service.resolve(scope('g1', 'chA'))?.workspaceId).toBe('ws-3')
    expect(service.resolve(scope('g1', 'chB'))?.workspaceId).toBe('ws-2')
  })

  it('applies concurrent rebinds of different channels', async () => {
    const service = setup()
    await service.bind(scope('g1', 'chA'), { workspaceId: 'ws-1', actorId: 'u1', nowMs: 100 })
    await service.bind(scope('g1', 'chB'), { workspaceId: 'ws-2', actorId: 'u1', nowMs: 100 })

    const [a, b] = await Promise.all([
      service.bind(scope('g1', 'chA'), { workspaceId: 'ws-3', actorId: 'u1', nowMs: 200 }, { expectedRevision: 1 }),
      service.bind(scope('g1', 'chB'), { workspaceId: 'ws-4', actorId: 'u1', nowMs: 200 }, { expectedRevision: 1 }),
    ])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
  })

  it('resolves a concurrent rebind of the same channel through the fence', async () => {
    const service = setup()
    await service.bind(scope('g1', 'chA'), { workspaceId: 'ws-1', actorId: 'u1', nowMs: 100 })

    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = service.bind(
      scope('g1', 'chA'),
      { workspaceId: 'ws-2', actorId: 'u1', nowMs: 200 },
      { expectedRevision: 1, beforeWrite: () => firstGate },
    )
    const second = service.bind(
      scope('g1', 'chA'),
      { workspaceId: 'ws-3', actorId: 'u2', nowMs: 210 },
      { expectedRevision: 1 },
    )

    releaseFirst()
    const [r1, r2] = await Promise.all([first, second])
    expect(r1.ok).toBe(true)
    expect(r2).toEqual({ ok: false, error: 'stale-revision' })
    expect(service.resolve(scope('g1', 'chA'))?.workspaceId).toBe('ws-2')
  })

  it('lists only the queried guild bindings', async () => {
    const service = setup()
    await service.bind(scope('g1', 'chA'), { workspaceId: 'ws-1', actorId: 'u1', nowMs: 100 })
    await service.bind(scope('g1', 'chB'), { workspaceId: 'ws-2', actorId: 'u1', nowMs: 100 })
    await service.bind(scope('g2', 'chC'), { workspaceId: 'ws-3', actorId: 'u1', nowMs: 100 })

    const g1 = service.listForGuild('g1')
    expect(g1).toHaveLength(2)
    expect(g1.map(entry => entry.scope.channelId).sort()).toEqual(['chA', 'chB'])
    expect(service.listForGuild('g9')).toEqual([])
  })

  it('round-trips through the canonical key codec', () => {
    const service = setup()
    expect(service.keyFor(scope('g1', 'chA'))).toBe(channelBindingKey({ applicationId: APP, guildId: 'g1', channelId: 'chA' }))
  })
})
