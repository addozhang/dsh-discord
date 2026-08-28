/**
 * Pending interaction reconciliation tests (15.7): at startup the adapter
 * decides, per pending interaction, whether its controls may stay. A Host
 * replay of the still-pending request keeps them; a resolution by another
 * client retires them; a Host-generation change with the interaction missing
 * from the new baseline expires them fail-closed — never claiming an answer
 * was applied. The sweep is disposal-aware: a cancelled sweep touches nothing
 * further.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  planInteractionReconciliation,
  sweepInteractionReconciliation,
  type InteractionRecord,
  type InteractionFacts,
} from '../src/features/reconcile-interactions.js'

function record(overrides: Partial<InteractionRecord> = {}): InteractionRecord {
  return {
    rpcId: 'rpc-1',
    kind: 'approval',
    state: 'pending',
    seenGeneration: 1,
    remoteOutcome: undefined,
    ...overrides,
  }
}

function facts(overrides: Partial<InteractionFacts> = {}): InteractionFacts {
  return {
    hostGeneration: 1,
    pendingBaseline: new Set(['rpc-1']),
    ...overrides,
  }
}

describe('interaction reconciliation planning', () => {
  it('keeps controls for an interaction the Host replayed as still pending', () => {
    const plan = planInteractionReconciliation([record()], facts())
    expect(plan.actions).toEqual([{ rpcId: 'rpc-1', action: 'keep' }])
  })

  it('retires controls when another client resolved the interaction', () => {
    const plan = planInteractionReconciliation(
      [record({ remoteOutcome: 'rejected' })],
      facts({ pendingBaseline: new Set() }),
    )
    expect(plan.actions).toEqual([{
      rpcId: 'rpc-1',
      action: 'retire',
      reason: 'resolved-elsewhere',
      outcome: 'rejected',
    }])
  })

  it('expires controls fail-closed when the Host generation changed and the interaction vanished', () => {
    const plan = planInteractionReconciliation(
      [record({ seenGeneration: 1 })],
      facts({ hostGeneration: 2, pendingBaseline: new Set() }),
    )
    expect(plan.actions).toEqual([{
      rpcId: 'rpc-1',
      action: 'expire',
      reason: 'host-generation-change',
    }])
  })

  it('retires controls that are gone from the baseline with no generation change', () => {
    const plan = planInteractionReconciliation(
      [record()],
      facts({ pendingBaseline: new Set() }),
    )
    expect(plan.actions).toEqual([{
      rpcId: 'rpc-1',
      action: 'retire',
      reason: 'resolved-elsewhere',
      outcome: undefined,
    }])
  })

  it('expires every interaction kind on a generation change, questions included', () => {
    const plan = planInteractionReconciliation(
      [record({ kind: 'question', rpcId: 'rpc-q' })],
      facts({ hostGeneration: 3, pendingBaseline: new Set() }),
    )
    expect(plan.actions).toEqual([{
      rpcId: 'rpc-q',
      action: 'expire',
      reason: 'host-generation-change',
    }])
  })
})

describe('disposal-aware sweep (15.7)', () => {
  it('stops between records when disposal wins and touches nothing further', async () => {
    const records = [
      record({ rpcId: 'rpc-a' }),
      record({ rpcId: 'rpc-b', remoteOutcome: 'rejected' }),
      record({ rpcId: 'rpc-c', seenGeneration: 0 }),
    ]
    const disable = vi.fn(() => Promise.resolve())
    let budget = 3
    const result = await sweepInteractionReconciliation(
      { disable, shouldContinue: () => (budget -= 1) > 0 },
      records,
      facts({ pendingBaseline: new Set(['rpc-a']) }),
    )

    expect(result.retired).toEqual(['rpc-b'])
    expect(result.kept).toEqual(['rpc-a'])
    expect(result.aborted).toBe(true)
    expect(disable).toHaveBeenCalledTimes(1)
  })
})
