/**
 * Discord delivery reconciliation tests (15.6): an outbound delivery parked
 * in an unknown state is resolved by looking the Discord message up —
 * present proves delivery, a confirmed 404 proves failure — and bounded so a
 * sweep never fans out unbounded lookups. A probe that cannot complete
 * leaves the record unknown for the next sweep. Reconciliation carries no
 * send port: it never resends blindly.
 */

import { describe, expect, it, vi } from 'vitest'

import { reconcileDeliveries, type DeliveryLookupInput } from '../src/features/reconcile-deliveries.js'

function delivery(overrides: Partial<DeliveryLookupInput> = {}): DeliveryLookupInput {
  return {
    deliveryId: 'd1',
    channelId: 'channel-1',
    messageId: 'msg-1',
    ...overrides,
  }
}

function setup(probeOutcome: 'present' | 'missing' | 'unknown') {
  const resolve = vi.fn((_deliveryId: string, _outcome: "succeeded" | "failed" | "unknown", _atMs: number) => Promise.resolve())
  const messageProbe = vi.fn((_channelId: string, _messageId: string) => Promise.resolve(probeOutcome))
  return { resolve, messageProbe, nowMs: () => 7_000 }
}

describe('delivery reconciliation', () => {
  it('resolves an unknown delivery as succeeded when Discord has the message', async () => {
    const { resolve, messageProbe, nowMs } = setup('present')

    const result = await reconcileDeliveries(
      { resolve, messageProbe, nowMs },
      { deliveries: [delivery()], maxLookups: 5 },
    )

    expect(result.delivered).toEqual(['d1'])
    expect(messageProbe).toHaveBeenCalledWith('channel-1', 'msg-1')
    expect(resolve).toHaveBeenCalledWith('d1', 'succeeded', 7_000)
  })

  it('resolves an unknown delivery as failed when Discord confirms it is gone', async () => {
    const { resolve } = setup('missing')

    const result = await reconcileDeliveries(
      { resolve, messageProbe: vi.fn(() => Promise.resolve('missing' as const)), nowMs: () => 7_000 },
      { deliveries: [delivery({ deliveryId: 'd2' })], maxLookups: 5 },
    )

    expect(result.failed).toEqual(['d2'])
    expect(resolve).toHaveBeenCalledWith('d2', 'failed', 7_000)
  })

  it('leaves the record unknown when the probe cannot complete', async () => {
    const { resolve } = setup('unknown')

    const result = await reconcileDeliveries(
      { resolve, messageProbe: vi.fn(() => Promise.resolve('unknown' as const)), nowMs: () => 7_000 },
      { deliveries: [delivery({ deliveryId: 'd3' })], maxLookups: 5 },
    )

    expect(result.unresolved).toEqual(['d3'])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('bounds the number of lookups per sweep', async () => {
    const { messageProbe } = setup('unknown')
    const deliveries = [
      delivery({ deliveryId: 'd1' }),
      delivery({ deliveryId: 'd2' }),
      delivery({ deliveryId: 'd3' }),
    ]

    const result = await reconcileDeliveries(
      { resolve: vi.fn(() => Promise.resolve()), messageProbe, nowMs: () => 7_000 },
      { deliveries, maxLookups: 2 },
    )

    expect(messageProbe).toHaveBeenCalledTimes(2)
    expect(result.unresolved).toEqual(['d1', 'd2'])
  })
})
