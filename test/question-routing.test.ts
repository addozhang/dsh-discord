/**
 * Question interaction routing tests (14.2): select answers record through
 * the opaque registry against the pending batch, custom text rides the modal
 * flow, labels outside the offered options are refused as values, and only
 * the originating user on the owning thread may answer. Incomplete batches
 * never submit — one complete response or nothing.
 */

import { describe, expect, it, vi } from 'vitest'

import { createComponentRegistry, type ComponentRegistry } from '../src/discord/components.js'
import type { EncodedQuestionAnswer } from '../src/features/question-store.js'
import { createQuestionStore, type QuestionBatch } from '../src/features/question-store.js'
import {
  CUSTOM_ANSWER_VALUE,
  handleSelectInput,
  handleModalSubmit,
  handleRemoteResolution,
  type DshQuestionRespondPort,
  type ModalDescriptor,
} from '../src/features/question-routing.js'

function batch(overrides: Partial<QuestionBatch> = {}): QuestionBatch {
  return {
    questionRpcId: 'qrpc-1',
    sessionId: 'sess-1',
    threadId: 'thread-1',
    requestId: 'req-1',
    actorUserId: 'user-owner',
    expiresAtMs: 60_000,
    questions: [
      { id: 'q1', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multiSelect: false },
      { id: 'q2', question: 'Which languages?', options: [{ label: 'TypeScript' }, { label: 'Rust' }], multiSelect: true },
    ],
    ...overrides,
  }
}

function setup() {
  let n = 0
  const registry: ComponentRegistry = createComponentRegistry({ idFactory: () => {
    n += 1
    return `opaque-${String(n)}`
  } })
  const store = createQuestionStore()
  const batchValue = batch()
  store.open(batchValue)
  const respond = vi.fn((_input: Parameters<DshQuestionRespondPort['respond']>[0]): ReturnType<DshQuestionRespondPort['respond']> =>
    Promise.resolve({ outcome: 'confirmed' }))
  const port: DshQuestionRespondPort = { respond }

  // Register the ids the way the renderer would: one select per question,
  // then the submit button.
  const q1Id = registry.register({ questionRpcId: 'qrpc-1', action: 'select', questionId: 'q1', expiresAtMs: 60_000 })
  const q2Id = registry.register({ questionRpcId: 'qrpc-1', action: 'select', questionId: 'q2', expiresAtMs: 60_000 })
  const submitId = registry.register({ questionRpcId: 'qrpc-1', action: 'submit', expiresAtMs: 60_000 })

  const select = (customId: string, values: string[], over: { userId?: string; threadId?: string } = {}) =>
    handleSelectInput(
      { registry, store, port, nowMs: () => 0, controls: { disable: async () => {} } },
      { customId, values, userId: over.userId ?? 'user-owner', threadId: over.threadId ?? 'thread-1' },
    )

  return { registry, store, respond, port, batchValue, q1Id, q2Id, submitId, select }
}

describe('question select routing', () => {
  it('records a single-select answer without submitting the batch', async () => {
    const { select, respond, store } = setup()

    await expect(select('dc:opaque-1', ['Postgres'])).resolves.toEqual({ outcome: 'recorded', complete: false })
    expect(respond).not.toHaveBeenCalled()
    expect(store.get('qrpc-1')?.draft('q1')).toEqual({ id: 'q1', selected: ['Postgres'] })
  })

  it('records a multi-select answer with several labels', async () => {
    const { select, store } = setup()

    await expect(select('dc:opaque-2', ['TypeScript', 'Rust'])).resolves.toEqual({ outcome: 'recorded', complete: false })
    expect(store.get('qrpc-1')?.draft('q2')).toEqual({ id: 'q2', selected: ['TypeScript', 'Rust'] })
  })

  it('refuses labels outside the offered options and records nothing', async () => {
    const { select, store } = setup()

    await expect(select('dc:opaque-1', ['Oracle'])).resolves.toEqual({ outcome: 'invalid-answer', reason: 'invalid-label' })
    expect(store.get('qrpc-1')?.draft('q1')).toBeUndefined()
  })

  it('denies a wrong actor before touching the draft', async () => {
    const { select, store } = setup()

    await expect(select('dc:opaque-1', ['Postgres'], { userId: 'user-other' })).resolves.toEqual({ outcome: 'denied' })
    await expect(select('dc:opaque-1', ['Postgres'], { threadId: 'thread-other' })).resolves.toEqual({ outcome: 'denied' })
    expect(store.get('qrpc-1')?.draft('q1')).toBeUndefined()
  })

  it('answers an unknown or expired control without recording anything', async () => {
    const { select, store } = setup()

    await expect(select('dc:missing', ['Postgres'])).resolves.toEqual({ outcome: 'unknown-control' })
    expect(store.get('qrpc-1')?.draft('q1')).toBeUndefined()
  })

  it('refuses to submit an incomplete batch', async () => {
    const { select, respond } = setup()

    await expect(select('dc:opaque-3', [])).resolves.toEqual({ outcome: 'incomplete' })
    expect(respond).not.toHaveBeenCalled()
  })
})

describe('custom-answer modal flow', () => {
  it('routes the Other selection to a modal descriptor instead of recording', async () => {
    const { select } = setup()

    const outcome = await select('dc:opaque-1', [CUSTOM_ANSWER_VALUE])
    expect(outcome.outcome).toBe('modal-requested')
    if (outcome.outcome !== 'modal-requested') return
    const modal: ModalDescriptor = outcome.modal
    expect(modal.title).toContain('Which database?')
    expect(modal.custom_id).toMatch(/^dc:[A-Za-z0-9-]+$/u)
    expect(modal.textInput.max_length).toBe(1000)
    expect(modal.custom_id).not.toContain('MARKER')
  })

  it('records the custom text from the modal submit and completes the batch', async () => {
    const { registry, store, select } = setup()
    await select('dc:opaque-1', [CUSTOM_ANSWER_VALUE])
    const modalContext = registry.resolve('dc:opaque-4', 0)
    expect(modalContext.found).toBe(true)

    const outcome = handleModalSubmit(
      { registry, store, port: { respond: vi.fn() }, nowMs: () => 0, controls: { disable: async () => {} } },
      { customId: 'dc:opaque-4', text: 'whichever is cheaper', userId: 'user-owner', threadId: 'thread-1' },
    )
    expect(outcome).toEqual({ outcome: 'recorded', complete: false })
    expect(store.get('qrpc-1')?.draft('q1')).toEqual({ id: 'q1', selected: [], custom: 'whichever is cheaper' })
  })

  it('denies a modal submit from the wrong actor', async () => {
    const { registry, store, select } = setup()
    await select('dc:opaque-1', [CUSTOM_ANSWER_VALUE])

    const outcome = handleModalSubmit(
      { registry, store, port: { respond: vi.fn() }, nowMs: () => 0, controls: { disable: async () => {} } },
      { customId: 'dc:opaque-4', text: 'sneaky', userId: 'user-other', threadId: 'thread-1' },
    )
    expect(outcome).toEqual({ outcome: 'denied' })
    expect(store.get('qrpc-1')?.draft('q1')).toBeUndefined()
  })

  it('answers an expired modal submit as an unknown control', async () => {
    const { registry, store, select } = setup()
    await select('dc:opaque-1', [CUSTOM_ANSWER_VALUE])

    const outcome = handleModalSubmit(
      { registry, store, port: { respond: vi.fn() }, nowMs: () => 60_000, controls: { disable: async () => {} } },
      { customId: 'dc:opaque-4', text: 'too late', userId: 'user-owner', threadId: 'thread-1' },
    )
    expect(outcome).toEqual({ outcome: 'unknown-control' })
    expect(store.get('qrpc-1')?.draft('q1')).toBeUndefined()
  })

  it('retires the rendered controls when the submit is confirmed', async () => {
    const { registry, store, port, select, submitId } = setup()
    const disable = vi.fn(async () => {})
    await select('dc:opaque-1', ['Postgres'])
    await select('dc:opaque-2', ['Rust'])

    const outcome = await handleSelectInput(
      { registry, store, port, nowMs: () => 0, controls: { disable } },
      { customId: submitId, values: [], userId: 'user-owner', threadId: 'thread-1' },
    )

    expect(outcome).toEqual({ outcome: 'submitted' })
    expect(disable).toHaveBeenCalledWith('qrpc-1')
  })

  it('parks unresolved when the respond port throws, keeping the retry available', async () => {
    const { registry, store, respond, port, select, submitId } = setup()
    const disable = vi.fn(async () => {})
    await select('dc:opaque-1', ['Postgres'])
    await select('dc:opaque-2', ['Rust'])
    respond.mockImplementationOnce(() => Promise.reject(new Error('port blew up')))

    const outcome = await handleSelectInput(
      { registry, store, port, nowMs: () => 0, controls: { disable } },
      { customId: submitId, values: [], userId: 'user-owner', threadId: 'thread-1' },
    )
    // A thrown port is an unconfirmed submit: unresolved, never submitting.
    expect(outcome).toEqual({ outcome: 'unresolved' })
    expect(store.get('qrpc-1')?.state).toBe('unresolved')
    expect(disable).not.toHaveBeenCalled()

    // The user's own retry re-submits once the port recovers.
    const retried = await handleSelectInput(
      { registry, store, port, nowMs: () => 0, controls: { disable } },
      { customId: submitId, values: [], userId: 'user-owner', threadId: 'thread-1' },
    )
    expect(retried).toEqual({ outcome: 'submitted' })
    expect(store.get('qrpc-1')?.state).toBe('resolved')
  })

  it('encodes the submitted batch with labels and custom text per question', async () => {
    const { registry, store, port, respond, select } = setup()
    await select('dc:opaque-1', [CUSTOM_ANSWER_VALUE])
    handleModalSubmit(
      { registry, store, port, nowMs: () => 0, controls: { disable: async () => {} } },
      { customId: 'dc:opaque-4', text: 'whichever is cheaper', userId: 'user-owner', threadId: 'thread-1' },
    )
    await select('dc:opaque-2', ['Rust'])

    const outcome = await select('dc:opaque-3', [])
    expect(outcome).toEqual({ outcome: 'submitted' })
    expect(respond).toHaveBeenCalledWith({
      rpcId: 'qrpc-1',
      sessionId: 'sess-1',
      answer: {
        answers: [
          { id: 'q1', selected: [], custom: 'whichever is cheaper' },
          { id: 'q2', selected: ['Rust'] },
        ],
      } satisfies EncodedQuestionAnswer,
    })
  })
})

describe('atomic submission and remote resolution (14.3)', () => {
  function completedSetup() {
    const base = setup()
    const { select, store } = base
    void select('dc:opaque-1', ['Postgres'])
    void select('dc:opaque-2', ['Rust'])
    expect(store.get('qrpc-1')?.drafts()).toHaveLength(2)
    return base
  }

  it('answers a concurrent double submit once; the loser sees already-resolved', async () => {
    const { select, respond } = completedSetup()

    const [first, second] = await Promise.all([
      select('dc:opaque-3', []),
      select('dc:opaque-3', []),
    ])

    expect(respond).toHaveBeenCalledTimes(1)
    expect([first, second].map(result => result.outcome).sort()).toEqual(['already-resolved', 'submitted'])
  })

  it('disables controls and never resubmits when DSH resolved elsewhere', async () => {
    const { store, respond } = setup()
    const disable = vi.fn(async () => {})
    const outcome = await handleRemoteResolution(
      { store, nowMs: () => 0, controls: { disable } },
      { questionRpcId: 'qrpc-1', outcome: 'cancelled' },
    )

    expect(outcome).toEqual({ outcome: 'resolved-elsewhere' })
    expect(disable).toHaveBeenCalledWith('qrpc-1')
    expect(store.get('qrpc-1')).toEqual(expect.objectContaining({
      state: 'resolved',
      resolvedBy: 'remote',
      resolvedOutcome: 'cancelled',
    }))
    expect(respond).not.toHaveBeenCalled()
  })

  it('treats later user interaction on a remotely resolved batch as already-resolved', async () => {
    const { store, select, respond } = setup()
    const disable = vi.fn(async () => {})
    await handleRemoteResolution(
      { store, nowMs: () => 0, controls: { disable } },
      { questionRpcId: 'qrpc-1', outcome: 'answered' },
    )

    await expect(select('dc:opaque-1', ['Postgres'])).resolves.toEqual({ outcome: 'already-resolved' })
    await expect(select('dc:opaque-3', [])).resolves.toEqual({ outcome: 'already-resolved' })
    expect(respond).not.toHaveBeenCalled()
    expect(store.get('qrpc-1')?.draft('q1')).toBeUndefined()
  })

  it('keeps the user answer first when DSH reports a remote resolution afterwards', async () => {
    const { store, select, respond } = setup()
    await select('dc:opaque-1', ['Postgres'])
    await select('dc:opaque-2', ['Rust'])
    await select('dc:opaque-3', [])
    expect(respond).toHaveBeenCalledTimes(1)

    const disable = vi.fn(async () => {})
    const outcome = await handleRemoteResolution(
      { store, nowMs: () => 0, controls: { disable } },
      { questionRpcId: 'qrpc-1', outcome: 'cancelled' },
    )

    expect(outcome).toEqual({ outcome: 'resolved-elsewhere' })
    const record = store.get('qrpc-1')
    expect(record?.resolvedBy).toBe('user')
    expect(record?.resolvedOutcome).toBe('answered')
    expect(respond).toHaveBeenCalledTimes(1)
  })

  it('lets an explicit resubmit retry after DSH did not confirm', async () => {
    const { select, respond } = completedSetup()
    respond.mockReturnValueOnce(Promise.resolve({ outcome: 'unknown' }))

    await expect(select('dc:opaque-3', [])).resolves.toEqual({ outcome: 'unresolved' })
    await expect(select('dc:opaque-3', [])).resolves.toEqual({ outcome: 'submitted' })
    expect(respond).toHaveBeenCalledTimes(2)
  })
})
