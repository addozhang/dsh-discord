/**
 * Answer finalizer tests (11.10): the final answer edits the head message
 * once, overflow continues as ordered follow-up messages sent exactly once,
 * duplicate finalize calls are skipped, a mid-continuation failure stops at
 * that index, and a rate-limited edit retried by the port still lands
 * exactly once.
 */

import { describe, expect, it, vi } from 'vitest'

import { createAnswerFinalizer, type AnswerDeliveryPort } from '../src/stream/finalizer.js'

function deliveryPort(options: {
  edit?: AnswerDeliveryPort['editHead']
  send?: AnswerDeliveryPort['sendContinuation']
}) {
  const editHead = vi.fn(options.edit ?? ((): ReturnType<AnswerDeliveryPort['editHead']> =>
    Promise.resolve({ outcome: 'completed' })))
  const sendContinuation = vi.fn(options.send ?? ((_request: { index: number; content: string }): ReturnType<AnswerDeliveryPort['sendContinuation']> =>
    Promise.resolve({ outcome: 'completed' })))
  return { port: { editHead, sendContinuation } as AnswerDeliveryPort, editHead, sendContinuation }
}

describe('answer finalizer', () => {
  it('edits only the head for a short answer', async () => {
    const { port, editHead, sendContinuation } = deliveryPort({})
    const finalizer = createAnswerFinalizer({ delivery: port, headMessageId: 'm-head' })

    const result = await finalizer.finalize('short answer')
    expect(result).toEqual({ outcome: 'finalized', editedHead: true, continuations: 0 })
    expect(editHead).toHaveBeenCalledTimes(1)
    expect(sendContinuation).not.toHaveBeenCalled()
  })

  it('edits the head once and sends ordered continuations for overflow', async () => {
    const { port, editHead, sendContinuation } = deliveryPort({})
    const finalizer = createAnswerFinalizer({ delivery: port, headMessageId: 'm-head' })

    const long = Array.from({ length: 30 }, (_, index) => `paragraph ${String(index)} ${'x'.repeat(300)}`).join('\n\n')
    const result = await finalizer.finalize(long)

    expect(result.outcome).toBe('finalized')
    if (result.outcome !== 'finalized') return
    expect(result.continuations).toBeGreaterThan(0)
    expect(editHead).toHaveBeenCalledTimes(1)
    // Continuations carry sequential indexes.
    const indexes = sendContinuation.mock.calls.map(call => (call[0] as { index: number }).index)
    expect(indexes).toEqual(indexes.map((_, position) => position + 1))
  })

  it('skips a duplicate finalize without touching Discord again', async () => {
    const { port, editHead, sendContinuation } = deliveryPort({})
    const finalizer = createAnswerFinalizer({ delivery: port, headMessageId: 'm-head' })

    const long = 'word '.repeat(2_000)
    await finalizer.finalize(long)
    const calls = editHead.mock.calls.length + sendContinuation.mock.calls.length
    expect(calls).toBeGreaterThan(1)

    const replay = await finalizer.finalize(long)
    expect(replay).toEqual({ outcome: 'skipped', reason: 'already-finalized' })
    expect(editHead.mock.calls.length + sendContinuation.mock.calls.length).toBe(calls)
  })

  it('stops at the first failed continuation and does not resend on retry', async () => {
    let sendCount = 0
    const { port, sendContinuation } = deliveryPort({
      send: () => {
        sendCount += 1
        if (sendCount === 2) return Promise.resolve({ outcome: 'failed' })
        return Promise.resolve({ outcome: 'completed' })
      },
    })
    const finalizer = createAnswerFinalizer({ delivery: port, headMessageId: 'm-head' })

    const long = Array.from({ length: 20 }, (_, index) => `p${String(index)} ${'y'.repeat(500)}`).join('\n\n')
    const result = await finalizer.finalize(long)
    expect(result).toEqual({ outcome: 'partial', editedHead: true, continuations: 1 })

    // Retry after the failure is a no-op: sent pieces are never resent.
    const replay = await finalizer.finalize(long)
    expect(replay).toEqual({ outcome: 'skipped', reason: 'already-finalized' })
    expect(sendContinuation).toHaveBeenCalledTimes(2)
  })

  it('lands a rate-limited head edit exactly once when the port retries', async () => {
    let editAttempts = 0
    const { port, editHead } = deliveryPort({
      edit: () => {
        editAttempts += 1
        if (editAttempts === 1) return Promise.resolve({ outcome: 'rate-limited', retryAfterMs: 100 })
        return Promise.resolve({ outcome: 'completed' })
      },
    })
    const finalizer = createAnswerFinalizer({ delivery: port, headMessageId: 'm-head' })

    const result = await finalizer.finalize('answer after backoff')
    expect(result).toEqual({ outcome: 'finalized', editedHead: true, continuations: 0 })
    expect(editHead).toHaveBeenCalledTimes(2)
  })
})
