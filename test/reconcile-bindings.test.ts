/**
 * Binding reconciliation tests (15.1): at startup the adapter checks every
 * persisted mapping against the DSH baseline. A mapping whose Workspace or
 * Session has disappeared is retired — the adapter's own record only, never
 * Host data — and changed Workspace metadata updates the adapter's cached
 * label without touching the binding itself.
 */

import { describe, expect, it } from "vitest"

import type { ChannelBinding, ThreadBinding } from '../src/state/records.js'
import {
  planBindingReconciliation,
  refineUnlistedThreadFacts,
  type DshBaseline,
  type DiscordChannelFacts,
} from '../src/features/reconcile-bindings.js'

function channelBinding(overrides: Partial<ChannelBinding & { channelId: string }> = {}): ChannelBinding & { channelId: string } {
  return {
    channelId: 'channel-1',
    workspaceId: 'ws-1',
    revision: 1,
    boundBy: 'user-admin',
    boundAtMs: 1_000,
    ...overrides,
  }
}

function threadBinding(overrides: Partial<ThreadBinding & { threadId: string }> = {}): ThreadBinding & { threadId: string } {
  return {
    threadId: 'thread-1',
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    revision: 1,
    createdBy: 'user-owner',
    createdAtMs: 1_000,
    ...overrides,
  }
}

function baseline(overrides: Partial<DshBaseline> = {}): DshBaseline {
  return {
    workspaces: [{ workspaceId: 'ws-1', title: 'fiber', path: '/w/fiber' }],
    sessionIds: ['sess-1'],
    ...overrides,
  }
}

function discordFacts(overrides: Partial<DiscordChannelFacts> = {}): DiscordChannelFacts {
  return {
    channels: { 'channel-1': 'ok', 'thread-1': 'ok' },
    ...overrides,
  }
}

describe('binding reconciliation planning (15.1)', () => {
  it('keeps a mapping whose Workspace, Session, and Discord channel all verify', () => {
    const plan = planBindingReconciliation({
      channelBindings: [channelBinding()],
      threadBindings: [threadBinding()],
      baseline: baseline(),
      discord: discordFacts(),
    })

    expect(plan.channelActions).toEqual([{ channelId: 'channel-1', action: 'keep' }])
    expect(plan.threadActions).toEqual([{ threadId: 'thread-1', action: 'keep' }])
  })

  it('retires a channel binding whose Workspace no longer exists on the Host', () => {
    const plan = planBindingReconciliation({
      channelBindings: [channelBinding()],
      threadBindings: [],
      baseline: baseline({ workspaces: [] }),
      discord: discordFacts(),
    })

    expect(plan.channelActions).toEqual([{ channelId: 'channel-1', action: 'retire', reason: 'workspace-missing' }])
  })

  it('retires a thread binding whose Session no longer exists on the Host', () => {
    const plan = planBindingReconciliation({
      channelBindings: [],
      threadBindings: [threadBinding()],
      baseline: baseline({ sessionIds: [] }),
      discord: discordFacts(),
    })

    expect(plan.threadActions).toEqual([{ threadId: 'thread-1', action: 'retire', reason: 'session-missing' }])
  })

  it('updates cached Workspace metadata when title or path changed', () => {
    const plan = planBindingReconciliation({
      channelBindings: [channelBinding()],
      threadBindings: [],
      baseline: baseline({
        workspaces: [{ workspaceId: 'ws-1', title: 'fiber-renamed', path: '/w/fiber-moved' }],
      }),
      discord: discordFacts(),
      cachedWorkspaceMetadata: { 'ws-1': { title: 'fiber', path: '/w/fiber' } },
    })

    expect(plan.channelActions).toEqual([{
      channelId: 'channel-1',
      action: 'update-metadata',
      metadata: { title: 'fiber-renamed', path: '/w/fiber-moved' },
    }])
  })

  it('never plans a Host-side deletion: retirement is adapter-record only', () => {
    const plan = planBindingReconciliation({
      channelBindings: [channelBinding(), channelBinding({ channelId: 'channel-2', workspaceId: 'ws-gone' })],
      threadBindings: [threadBinding({ threadId: 'thread-2', sessionId: 'sess-gone' })],
      baseline: baseline(),
      discord: discordFacts({ channels: { 'channel-1': 'ok', 'channel-2': 'ok', 'thread-1': 'ok', 'thread-2': 'ok' } }),
    })

    for (const action of [...plan.channelActions, ...plan.threadActions]) {
      expect(['keep', 'retire', 'update-metadata', 'keep-blocked']).toContain(action.action)
    }
    expect(plan).not.toHaveProperty('deleteWorkspace')
    expect(plan).not.toHaveProperty('deleteSession')
  })
})

describe('confirmed versus unverifiable Discord state (15.2)', () => {
  it('retires a mapping only when Discord confirmed the channel is deleted', () => {
    const plan = planBindingReconciliation({
      channelBindings: [channelBinding()],
      threadBindings: [threadBinding({ threadId: 'thread-1' })],
      baseline: baseline(),
      discord: discordFacts({
        channels: { 'channel-1': 'missing', 'thread-1': 'missing' },
      }),
    })

    expect(plan.channelActions).toEqual([{
      channelId: 'channel-1',
      action: 'retire',
      reason: 'discord-deleted',
    }])
    expect(plan.threadActions).toEqual([{
      threadId: 'thread-1',
      action: 'retire',
      reason: 'discord-deleted',
    }])
  })

  it('keeps a mapping blocked when Discord is only temporarily unreachable', () => {
    const plan = planBindingReconciliation({
      channelBindings: [channelBinding()],
      threadBindings: [threadBinding({ threadId: 'thread-1' })],
      baseline: baseline(),
      discord: discordFacts({
        channels: { 'channel-1': 'unknown', 'thread-1': 'unknown' },
      }),
    })

    expect(plan.channelActions).toEqual([{
      channelId: 'channel-1',
      action: 'keep-blocked',
      reason: 'discord-unverified',
    }])
    expect(plan.threadActions).toEqual([{
      threadId: 'thread-1',
      action: 'keep-blocked',
      reason: 'discord-unverified',
    }])
  })
})

describe('unlisted thread probe refinement (16.104)', () => {
  it('maps a 200 probe to ok and a 404 probe to missing', async () => {
    const probed: string[] = []
    const facts = await refineUnlistedThreadFacts(['thread-live', 'thread-gone'], threadId => {
      probed.push(threadId)
      return Promise.resolve(threadId === 'thread-gone'
        ? { outcome: 'rejected' as const, status: 404 }
        : { outcome: 'completed' as const })
    })

    expect(facts).toEqual({ 'thread-live': 'ok', 'thread-gone': 'missing' })
    expect(probed).toEqual(['thread-live', 'thread-gone'])
  })

  it('marks a forbidden or unreachable probe unknown, never missing', async () => {
    const facts = await refineUnlistedThreadFacts(['thread-403', 'thread-net'], threadId =>
      Promise.resolve(threadId === 'thread-403'
        ? { outcome: 'rejected' as const, status: 403 }
        : { outcome: 'unknown' as const }))

    expect(facts).toEqual({ 'thread-403': 'unknown', 'thread-net': 'unknown' })
  })

  it('feeds the planner: probe-verified deletion retires, probe-verified life keeps, inconclusive keeps blocked', async () => {
    const facts = await refineUnlistedThreadFacts(['thread-gone', 'thread-live', 'thread-flaky'], threadId => {
      if (threadId === 'thread-gone') return Promise.resolve({ outcome: 'rejected' as const, status: 404 })
      if (threadId === 'thread-live') return Promise.resolve({ outcome: 'completed' as const })
      return Promise.resolve({ outcome: 'unknown' as const })
    })

    const plan = planBindingReconciliation({
      channelBindings: [],
      threadBindings: [
        threadBinding({ threadId: 'thread-gone' }),
        threadBinding({ threadId: 'thread-live' }),
        threadBinding({ threadId: 'thread-flaky' }),
      ],
      baseline: baseline(),
      discord: { channels: facts },
    })

    expect(plan.threadActions).toEqual([
      { threadId: 'thread-gone', action: 'retire', reason: 'discord-deleted' },
      { threadId: 'thread-live', action: 'keep' },
      { threadId: 'thread-flaky', action: 'keep-blocked', reason: 'discord-unverified' },
    ])
  })
})
