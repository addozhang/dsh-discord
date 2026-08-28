/**
 * Uncertain prompt reconciliation tests (15.5): an intent left in `unknown`
 * after an uncertain DSH admission is reconciled against evidence, never by
 * resubmission. A durable history `user/message.source.rpcId` is proof of
 * acceptance; the live queue snapshot still holding the pending item is also
 * acceptance; anything else — including probes the adapter could not
 * complete — leaves the intent unknown for an explicit user retry.
 */

import { describe, expect, it, vi } from 'vitest'

import { reconcileIntents, type IntentEvidenceInput } from '../src/features/reconcile-intents.js'

function intent(overrides: Partial<IntentEvidenceInput> = {}): IntentEvidenceInput {
  return {
    messageId: 'msg-1',
    sessionId: 'sess-1',
    requestId: 'req-1',
    ...overrides,
  }
}

function setup(historyOutcome: 'present' | 'absent' | 'unknown', queueOutcome: 'present' | 'absent' | 'unknown') {
  const resolve = vi.fn((_messageId: string, _outcome: 'succeeded' | 'failed' | 'unknown', _atMs: number) => Promise.resolve())
  const historyEvidence = vi.fn((_sessionId: string, _requestId: string) => Promise.resolve(historyOutcome))
  const queueEvidence = vi.fn((_sessionId: string, _requestId: string) => Promise.resolve(queueOutcome))
  const nowMs = () => 5_000
  return { resolve, historyEvidence, queueEvidence, nowMs }
}

describe('uncertain intent reconciliation', () => {
  it('proves acceptance from durable history and resolves the intent succeeded', async () => {
    const { resolve, historyEvidence, queueEvidence, nowMs } = setup('present', 'absent')

    const result = await reconcileIntents(
      { resolve, historyEvidence, queueEvidence, nowMs },
      { intents: [intent()], maxIntents: 5 },
    )

    expect(result.proven).toEqual(['msg-1'])
    expect(result.unresolved).toEqual([])
    expect(resolve).toHaveBeenCalledWith('msg-1', 'succeeded', 5_000)
    expect(queueEvidence).not.toHaveBeenCalled()
  })

  it('accepts live queue evidence when history carries no matching rpc id', async () => {
    const { resolve } = setup('absent', 'present')

    const result = await reconcileIntents(
      { resolve, historyEvidence: vi.fn(() => Promise.resolve('absent' as const)), queueEvidence: vi.fn(() => Promise.resolve('present' as const)), nowMs: () => 5_000 },
      { intents: [intent()], maxIntents: 5 },
    )
    void resolve

    expect(result.proven).toEqual(['msg-1'])
  })

  it('leaves intents unknown without evidence and never resubmits', async () => {
    const { resolve } = setup('absent', 'absent')

    const result = await reconcileIntents(
      { resolve, historyEvidence: vi.fn(() => Promise.resolve('absent' as const)), queueEvidence: vi.fn(() => Promise.resolve('absent' as const)), nowMs: () => 5_000 },
      { intents: [intent({ messageId: 'msg-x' })], maxIntents: 5 },
    )

    expect(result.unresolved).toEqual(['msg-x'])
    expect(result.proven).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('fails closed when a probe could not complete', async () => {
    const { resolve } = setup('unknown', 'unknown')

    const result = await reconcileIntents(
      { resolve, historyEvidence: vi.fn(() => Promise.resolve('unknown' as const)), queueEvidence: vi.fn(() => Promise.resolve('unknown' as const)), nowMs: () => 5_000 },
      { intents: [intent({ messageId: 'msg-u' })], maxIntents: 5 },
    )

    expect(result.unresolved).toEqual(['msg-u'])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('processes a bounded number of intents per sweep', async () => {
    const { resolve, historyEvidence, queueEvidence, nowMs } = setup('absent', 'absent')
    const intents = [intent({ messageId: 'm1' }), intent({ messageId: 'm2' }), intent({ messageId: 'm3' })]

    const result = await reconcileIntents(
      { resolve, historyEvidence, queueEvidence, nowMs },
      { intents, maxIntents: 2 },
    )

    expect(result.unresolved).toEqual(['m1', 'm2'])
    expect(historyEvidence).toHaveBeenCalledTimes(2)
  })
})
