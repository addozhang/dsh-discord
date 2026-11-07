/**
 * Question store tests (14.1): a pending DSH question batch binds the owning
 * Session, Thread, adapter-submitted request ID, question rpcId, originating
 * user, and the full question list. Drafts accumulate one answer per question
 * and are validated against the batch — unknown question ids, labels outside
 * the offered options, oversized custom text, and batches beyond Discord's
 * component bounds are refused as values. Completion is exact: every question
 * answered before the batch can encode.
 */

import { describe, expect, it } from 'vitest'

import {
  createQuestionStore,
  encodeAnswer,
  isCompleteDraft,
  questionBoundsError,
  validateDraftAnswer,
  type QuestionBatch,
  type QuestionDraft,
  type QuestionItemView,
} from '../src/features/question-store.js'

function batch(overrides: Partial<QuestionBatch> = {}): QuestionBatch {
  return {
    questionRpcId: 'qrpc-1',
    sessionId: 'sess-1',
    threadId: 'thread-1',
    requestId: 'req-1',
    actorUserId: 'user-owner',
    expiresAtMs: 60_000,
    questions: [
      {
        id: 'q1',
        question: 'Which database?',
        options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        multiSelect: false,
      },
      {
        id: 'q2',
        question: 'Which languages?',
        options: [{ label: 'TypeScript' }, { label: 'Rust' }],
        multiSelect: true,
      },
    ],
    ...overrides,
  }
}

function store() {
  return createQuestionStore()
}

function firstQuestion() {
  const question = batch().questions[0]
  if (question === undefined) throw new Error('missing fixture question')
  return question
}

function secondQuestion() {
  const question = batch().questions[1]
  if (question === undefined) throw new Error('missing fixture question')
  return question
}

describe('question batch bounds', () => {
  it('accepts a batch within Discord component bounds', () => {
    const opened = store().open(batch())
    expect(opened).toEqual({ ok: true })
  })

  it('refuses more questions than Discord action rows allow', () => {
    const many = batch({
      questions: Array.from({ length: 6 }, (_, index) => ({
        id: `q${String(index)}`,
        question: `Q${String(index)}`,
        options: [{ label: 'yes' }],
        multiSelect: false,
      })),
    })
    expect(store().open(many)).toEqual({ ok: false, error: 'too-many-questions' })
  })

  it('refuses more options than a select menu allows (25th slot is the custom entry)', () => {
    const wide = batch({
      questions: [{
        id: 'q1',
        question: 'Pick',
        options: Array.from({ length: 25 }, (_, index) => ({ label: `option-${String(index)}` })),
        multiSelect: false,
      }],
    })
    expect(store().open(wide)).toEqual({ ok: false, error: 'too-many-options' })
  })

  it('accepts a question at the 24-option bound (24 host + 1 custom = 25 wire slots)', () => {
    expect(store().open(batch({
      questions: [{
        id: 'q1',
        question: 'Pick',
        options: Array.from({ length: 24 }, (_, index) => ({ label: `option-${String(index)}` })),
        multiSelect: false,
      }],
    }))).toEqual({ ok: true })
  })

  it('refuses labels longer than a select option can carry', () => {
    const long = batch({
      questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'x'.repeat(101) }], multiSelect: false }],
    })
    expect(store().open(long)).toEqual({ ok: false, error: 'option-label-too-long' })
  })

  it('accepts a free-text question without options (16.108: modal answer)', () => {
    expect(store().open(batch({
      questions: [{ id: 'q1', question: 'Free?', options: undefined, multiSelect: false }],
    }))).toEqual({ ok: true })
  })

  it('open() and questionBoundsError agree on every refusal kind', () => {
    const refusals: Array<[QuestionBatch, QuestionItemView[]]> = [
      // [full batch for open(), bare question list for the pure check]
      [batch({ questions: Array.from({ length: 6 }, (_, index) => ({ id: `q${String(index)}`, question: 'Q', options: [{ label: 'y' }], multiSelect: false })) }),
        Array.from({ length: 6 }, () => ({ id: 'q', question: 'Q', options: [{ label: 'y' }], multiSelect: false }))],
      [batch({ questions: [{ id: 'q1', question: 'Pick', options: Array.from({ length: 25 }, () => ({ label: 'o' })), multiSelect: false }] }),
        [{ id: 'q1', question: 'Pick', options: Array.from({ length: 25 }, () => ({ label: 'o' })), multiSelect: false }]],
      [batch({ questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'x'.repeat(101) }], multiSelect: false }] }),
        [{ id: 'q1', question: 'Pick', options: [{ label: 'x'.repeat(101) }], multiSelect: false }]],
    ]
    for (const [full, questions] of refusals) {
      const viaOpen = store().open(full)
      expect(viaOpen, `open() accepted a batch the pure check refuses: ${JSON.stringify(questions)}`).toMatchObject({ ok: false })
      if (!viaOpen.ok) {
        expect(questionBoundsError(questions), `pure check disagrees with open() (${viaOpen.error})`).toBe(viaOpen.error)
      }
    }
  })

  it('questionBoundsError accepts a renderable batch and names the first violation otherwise', () => {
    expect(questionBoundsError(batch().questions)).toBeUndefined()
    // Free-text questions are renderable since 16.108 (single-option select + modal).
    expect(questionBoundsError([
      { id: 'q1', question: 'Free text?', options: undefined, multiSelect: false },
    ])).toBeUndefined()
    expect(questionBoundsError([
      { id: 'q1', question: 'Ok?', options: [{ label: 'y' }], multiSelect: false },
      { id: 'q2', question: 'Too wide?', options: Array.from({ length: 25 }, () => ({ label: 'o' })), multiSelect: false },
      { id: 'q3', question: 'Long?', options: [{ label: 'x'.repeat(101) }], multiSelect: false },
    ])).toBe('too-many-options')
  })

  it('validates a free-text draft against an option-less question', () => {
    const question: QuestionItemView = { id: 'q1', question: 'Free?', options: undefined, multiSelect: false }
    expect(validateDraftAnswer(question, { id: 'q1', selected: [], custom: 'blue' })).toEqual({ ok: true })
    expect(validateDraftAnswer(question, { id: 'q1', selected: ['nope'] })).toEqual({ ok: false, error: 'invalid-label' })
  })
})

describe('question draft validation', () => {
  it('accepts a single-select answer naming an offered label exactly once', () => {
    const result = validateDraftAnswer(firstQuestion(), { id: 'q1', selected: ['Postgres'] })
    expect(result).toEqual({ ok: true })
  })

  it('accepts a multi-select answer with several offered labels', () => {
    const q2 = secondQuestion()
    expect(validateDraftAnswer(q2, { id: 'q2', selected: ['TypeScript', 'Rust'] })).toEqual({ ok: true })
  })

  it('rejects labels the question never offered', () => {
    const result = validateDraftAnswer(firstQuestion(), { id: 'q1', selected: ['Oracle'] })
    expect(result).toEqual({ ok: false, error: 'invalid-label' })
  })

  it('rejects a single-select answer with several labels', () => {
    const result = validateDraftAnswer(firstQuestion(), { id: 'q1', selected: ['Postgres', 'SQLite'] })
    expect(result).toEqual({ ok: false, error: 'invalid-label' })
  })

  it('rejects an unknown question id', () => {
    const result = validateDraftAnswer(firstQuestion(), { id: 'qX', selected: ['Postgres'] })
    expect(result).toEqual({ ok: false, error: 'unknown-question' })
  })

  it('rejects custom text beyond the bounded length', () => {
    const result = validateDraftAnswer(firstQuestion(), {
      id: 'q1',
      selected: [],
      custom: 'x'.repeat(1001),
    })
    expect(result).toEqual({ ok: false, error: 'custom-too-long' })
  })

  it('accepts a custom-text-only answer', () => {
    const result = validateDraftAnswer(firstQuestion(), { id: 'q1', selected: [], custom: 'whichever is cheaper' })
    expect(result).toEqual({ ok: true })
  })
})

describe('question completion and encoding', () => {
  it('is incomplete until every question has an answer', () => {
    const questions = batch().questions
    expect(isCompleteDraft(questions, new Map([['q1', { id: 'q1', selected: ['Postgres'] } as QuestionDraft]]))).toBe(false)
    const full = new Map([
      ['q1', { id: 'q1', selected: ['Postgres'] } as QuestionDraft],
      ['q2', { id: 'q2', selected: ['Rust'] } as QuestionDraft],
    ])
    expect(isCompleteDraft(questions, full)).toBe(true)
  })

  it('encodes the complete draft keyed by question id with labels only', () => {
    const questions = batch().questions
    const drafts = new Map<string, QuestionDraft>([
      ['q1', { id: 'q1', selected: ['Postgres'] }],
      ['q2', { id: 'q2', selected: ['TypeScript', 'Rust'], custom: 'also Go if easy' }],
    ])
    expect(encodeAnswer(questions, drafts)).toEqual({
      answers: [
        { id: 'q1', selected: ['Postgres'] },
        { id: 'q2', selected: ['TypeScript', 'Rust'], custom: 'also Go if easy' },
      ],
    })
  })

  it('encodes a custom-only answer without a selected list', () => {
    const drafts = new Map<string, QuestionDraft>([
      ['q1', { id: 'q1', selected: [], custom: 'neither — file an issue' }],
      ['q2', { id: 'q2', selected: ['Rust'] }],
    ])
    expect(encodeAnswer(batch().questions, drafts)).toEqual({
      answers: [
        { id: 'q1', selected: [], custom: 'neither — file an issue' },
        { id: 'q2', selected: ['Rust'] },
      ],
    })
  })
})

describe('question store drafts and ownership', () => {
  it('persists validated drafts per question id and reports completion', () => {
    const questions = store()
    questions.open(batch())

    const first = questions.setDraft('qrpc-1', { id: 'q1', selected: ['Postgres'] })
    expect(first).toEqual({ ok: true, complete: false })

    const second = questions.setDraft('qrpc-1', { id: 'q2', selected: ['Rust'] })
    expect(second).toEqual({ ok: true, complete: true })

    const record = questions.get('qrpc-1')
    expect(record?.draft('q1')).toEqual({ id: 'q1', selected: ['Postgres'] })
    expect(record?.drafts()).toHaveLength(2)
  })

  it('refuses drafts for unknown rpc ids or invalid answers', () => {
    const questions = store()
    questions.open(batch())

    expect(questions.setDraft('missing', { id: 'q1', selected: ['Postgres'] }))
      .toEqual({ ok: false, error: 'unknown-question' })
    expect(questions.setDraft('qrpc-1', { id: 'q1', selected: ['Oracle'] }))
      .toEqual({ ok: false, error: 'invalid-label' })
  })

  it('keeps one record per question rpc id on host replay', () => {
    const questions = store()
    questions.open(batch())
    questions.open(batch({ actorUserId: 'user-other' }))
    expect(questions.get('qrpc-1')?.actorUserId).toBe('user-owner')
  })
})

describe('question store retention', () => {
  it('prunes terminal entries past retention and keeps unresolved ones', async () => {
    // Terminal (resolved/expired) batches age out of the in-memory store;
    // unresolved entries stay — they await explicit resolution, never a timer.
    const store = createQuestionStore()
    const now = Date.now()
    const opened = store.open({
      questionRpcId: 'qr-resolved', sessionId: 's', threadId: 't', requestId: 'r',
      actorUserId: 'u', expiresAtMs: now - 10 * 60_000,
      questions: [{ id: 'q1', question: 'Q', options: [{ label: 'A' }], multiSelect: false }],
    })
    expect(opened.ok).toBe(true)
    await store.markResolved('qr-resolved', 'answered', 'user', now)

    expect(store.pruneSettled(now, 5 * 60_000)).toBe(1)
    expect(store.get('qr-resolved')).toBeUndefined()
    expect(store.pruneSettled(now, 5 * 60_000)).toBe(0)
  })
})
