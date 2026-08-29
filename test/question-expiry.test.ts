/**
 * Question expiry tests (14.4): a question whose deadline passes while still
 * pending cancels the owning adapter-controlled Turn — DSH must not be left
 * with a tool call waiting forever — records whether cancellation was
 * accepted, and only then expires the Discord controls. The sweep structurally
 * carries no answer port: an expired question is cancelled, never answered.
 * A user click that beats the sweep owns the question instead, and the sweep
 * skips it entirely.
 */

import { describe, expect, it, vi } from 'vitest'

import type { QuestionBatch } from '../src/features/question-store.js'
import { createQuestionStore, type QuestionStore } from '../src/features/question-store.js'
import {
  sweepExpiredQuestions,
  type DshTurnCancelPort,
  type QuestionControls,
  abandonUnrenderableQuestion,
} from '../src/features/question-expiry.js'

function batch(overrides: Partial<QuestionBatch> = {}): QuestionBatch {
  return {
    questionRpcId: 'qrpc-1',
    sessionId: 'sess-1',
    threadId: 'thread-1',
    requestId: 'req-1',
    actorUserId: 'user-owner',
    expiresAtMs: 60_000,
    questions: [{
      id: 'q1',
      question: 'Proceed?',
      options: [{ label: 'yes' }, { label: 'no' }],
      multiSelect: false,
    }],
    ...overrides,
  }
}

function setup() {
  const store: QuestionStore = createQuestionStore()
  const calls: string[] = []
  const cancel = vi.fn((_input: Parameters<DshTurnCancelPort['cancel']>[0]): ReturnType<DshTurnCancelPort['cancel']> => {
    calls.push('cancel')
    return Promise.resolve({ outcome: 'accepted' })
  })
  const cancelPort: DshTurnCancelPort = { cancel }
  const disable = vi.fn(() => {
    calls.push('disable')
    return Promise.resolve()
  })
  const controls: QuestionControls = { disable }
  store.open(batch())

  const sweep = (nowMs: number) => sweepExpiredQuestions({ store, cancelPort, controls, nowMs: () => nowMs })

  return { store, cancel, disable, calls, sweep }
}

describe('question expiry sweep', () => {
  it('cancels the owning turn with the record ids, records acceptance, then expires controls', async () => {
    const { cancel, store, calls, sweep } = setup()

    const result = await sweep(61_000)

    expect(result.handled).toEqual(['qrpc-1'])
    expect(cancel).toHaveBeenCalledWith({ sessionId: 'sess-1', requestId: 'req-1' })
    expect(store.get('qrpc-1')).toEqual(expect.objectContaining({
      state: 'expired',
      expiredCancel: 'accepted',
    }))
    expect(calls).toEqual(['cancel', 'disable'])
  })

  it('leaves questions still within their deadline untouched', async () => {
    const { cancel, disable, store, sweep } = setup()

    const result = await sweep(59_999)

    expect(result.handled).toEqual([])
    expect(cancel).not.toHaveBeenCalled()
    expect(disable).not.toHaveBeenCalled()
    expect(store.get('qrpc-1')?.state).toBe('pending')
  })

  it('never races a user click that already claimed the question', async () => {
    const { store, cancel, disable, sweep } = setup()
    await store.claim('qrpc-1')

    const result = await sweep(61_000)

    expect(result.handled).toEqual([])
    expect(cancel).not.toHaveBeenCalled()
    expect(disable).not.toHaveBeenCalled()
  })

  it('answers a user submit after expiry as already-resolved', async () => {
    const { store, sweep } = setup()
    await sweep(61_000)
    expect(store.get('qrpc-1')?.state).toBe('expired')

    const claim = await store.claim('qrpc-1')
    expect(claim.outcome).toBe('not-claimable')
  })

  it('records a rejected cancellation and still expires the controls', async () => {
    const { cancel, store, calls, sweep } = setup()
    cancel.mockImplementationOnce((input: Parameters<DshTurnCancelPort['cancel']>[0]): ReturnType<DshTurnCancelPort['cancel']> => {
      calls.push('cancel')
      void input
      return Promise.resolve({ outcome: 'rejected', reason: 'session idle' })
    })

    const result = await sweep(61_000)

    expect(result.handled).toEqual(['qrpc-1'])
    expect(store.get('qrpc-1')).toEqual(expect.objectContaining({
      state: 'expired',
      expiredCancel: 'rejected',
    }))
    expect(calls).toEqual(['cancel', 'disable'])
  })

  it('skips a question the user already answered before the deadline', async () => {
    const { store, cancel, sweep } = setup()
    await store.claim('qrpc-1')
    await store.markResolved('qrpc-1', 'answered', 'user', 1_000)

    const result = await sweep(61_000)

    expect(result.handled).toEqual([])
    expect(cancel).not.toHaveBeenCalled()
  })
})

describe('abandonUnrenderableQuestion', () => {
  it('cancels the owning turn and records expiry when the controls never rendered', async () => {
    const { store, cancel, disable } = setup()
    await abandonUnrenderableQuestion({
      store,
      cancelPort: { cancel },
      nowMs: () => 5_000,
    }, 'qrpc-1')

    expect(cancel).toHaveBeenCalledWith({ sessionId: 'sess-1', requestId: 'req-1' })
    expect(store.get('qrpc-1')).toEqual(expect.objectContaining({
      state: 'expired',
      expiredCancel: 'accepted',
    }))
    expect(disable).not.toHaveBeenCalled()
  })

  it('is a no-op when a user click already owns the question', async () => {
    const { store, cancel, disable } = setup()
    await store.claim('qrpc-1')

    await abandonUnrenderableQuestion({
      store,
      cancelPort: { cancel },
      nowMs: () => 5_000,
    }, 'qrpc-1')

    expect(cancel).not.toHaveBeenCalled()
    expect(disable).not.toHaveBeenCalled()
  })
})
