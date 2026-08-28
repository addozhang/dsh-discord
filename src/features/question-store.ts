/**
 * Pending question records and answer drafts (design.md §8, task 14.1). One
 * record binds the ownership facts — Session, Discord Thread, owning
 * adapter-submitted request ID, the answerable question rpcId, originating
 * user — plus the full question list and one draft answer per question. DSH
 * answers an ask() as a whole batch or not at all, so drafts may accumulate
 * but never submit until every question is answered and valid.
 *
 * Bounds are Discord's component limits, enforced at open as fail-closed
 * values: a batch the adapter cannot render is refused rather than silently
 * truncated. Records are process-local by design — a Host restart invalidates
 * pending questions, which reconciliation (15.7) treats as unresolved.
 */

/** One question as the adapter carries it (labels only; details render). */
export interface QuestionItemView {
  id: string
  question: string
  header?: string | undefined
  options?: ReadonlyArray<{ label: string; description?: string | undefined }> | undefined
  multiSelect: boolean
}

/** The full pending batch with its ownership facts. */
export interface QuestionBatch {
  questionRpcId: string
  sessionId: string
  threadId: string
  requestId: string
  actorUserId: string
  /** The ask deadline; the expiry sweep cancels the owning turn past it. */
  expiresAtMs: number
  questions: readonly QuestionItemView[]
}

/** One validated draft answer. */
export interface QuestionDraft {
  id: string
  selected: string[]
  custom?: string | undefined
}

/** The DSH answer shape (AskUserQuestionAnswer) the adapter submits. */
export interface EncodedQuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string | undefined }>
}

/** Discord action rows per message — one select each. */
export const MAX_QUESTIONS_PER_BATCH = 5
/** Discord string-select option bound. */
export const MAX_OPTIONS_PER_QUESTION = 25
/** Discord select option label bound (characters). */
export const MAX_LABEL_LENGTH = 100
/** The adapter's own custom-text bound (inside Discord's 4000). */
export const MAX_CUSTOM_LENGTH = 1000

export type OpenBatchError =
  | 'too-many-questions'
  | 'too-many-options'
  | 'option-label-too-long'
  | 'options-required'
  | 'duplicate'

export type DraftAnswerError =
  | 'unknown-question'
  | 'invalid-label'
  | 'custom-too-long'

export type ValidateResult =
  | { ok: true }
  | { ok: false; error: DraftAnswerError }

/** Validate one draft answer against its question (pure; also used by routing). */
export function validateDraftAnswer(
  question: QuestionItemView | undefined,
  draft: QuestionDraft,
): ValidateResult {
  if (question === undefined || draft.id !== question.id) return { ok: false, error: 'unknown-question' }
  const labels = new Set((question.options ?? []).map(option => option.label))
  if (!draft.selected.every(label => labels.has(label))) return { ok: false, error: 'invalid-label' }
  if (!question.multiSelect && draft.selected.length > 1) return { ok: false, error: 'invalid-label' }
  if (draft.custom !== undefined && draft.custom.length > MAX_CUSTOM_LENGTH) {
    return { ok: false, error: 'custom-too-long' }
  }
  return { ok: true }
}

/** A batch is complete exactly when every question carries a draft. */
export function isCompleteDraft(
  questions: readonly QuestionItemView[],
  drafts: ReadonlyMap<string, QuestionDraft>,
): boolean {
  return questions.every(question => drafts.has(question.id))
}

/** Encode the complete draft into the DSH answer batch (pure). */
export function encodeAnswer(
  questions: readonly QuestionItemView[],
  drafts: ReadonlyMap<string, QuestionDraft>,
): EncodedQuestionAnswer {
  return {
    answers: questions.map((question) => {
      const draft = drafts.get(question.id)
      const selected = draft?.selected ?? []
      return {
        id: question.id,
        selected,
        ...(draft?.custom === undefined ? {} : { custom: draft.custom }),
      }
    }),
  }
}

export type OpenBatchResult =
  | { ok: true }
  | { ok: false; error: OpenBatchError }

/** One pending record as callers observe it. */
export interface QuestionRecord extends QuestionBatch {
  state: 'pending' | 'submitting' | 'resolved' | 'unresolved' | 'expired'
  resolvedOutcome?: 'answered' | 'cancelled' | undefined
  resolvedBy?: 'user' | 'remote' | undefined
  expiredCancel?: 'accepted' | 'rejected' | 'unknown' | undefined
  draft(questionId: string): QuestionDraft | undefined
  drafts(): QuestionDraft[]
}

export interface QuestionStore {
  get(questionRpcId: string): QuestionRecord | undefined
  open(batch: QuestionBatch): OpenBatchResult
  /** Validate then persist one question's draft; reports batch completion. */
  setDraft(questionRpcId: string, draft: QuestionDraft):
    | { ok: true; complete: boolean }
    | { ok: false; error: DraftAnswerError }
  /** Snapshot the drafts (the submitter reads them under the claim). */
  takeDrafts(questionRpcId: string): QuestionDraft[]
  /** Encode the current drafts into the DSH answer batch. */
  encodeSubmitted(questionRpcId: string): EncodedQuestionAnswer
  /**
   * Atomically claim the batch for submission: pending (or an explicit retry
   * after unresolved) flips to submitting exactly once per key.
   */
  claim(questionRpcId: string): Promise<
    | { outcome: 'claimed'; record: QuestionRecord }
    | { outcome: 'not-claimable'; record: QuestionRecord }
    | { outcome: 'unknown' }
  >
  /** Record a DSH-confirmed user answer; terminal. */
  markResolved(questionRpcId: string, outcome: 'answered' | 'cancelled', by: 'user' | 'remote', atMs: number): Promise<void>
  /** Retain the batch in an explicit unresolved state when DSH is silent. */
  markUnresolved(questionRpcId: string, atMs: number): Promise<void>
  /** Pending batches whose deadline has passed, for the expiry sweep (14.4). */
  listPendingExpired(atMs: number): QuestionRecord[]
  /** Record the expiry: the owning turn's cancellation outcome, controls gone. */
  markExpired(questionRpcId: string, cancel: 'accepted' | 'rejected' | 'unknown', atMs: number): Promise<void>
}

interface StoreEntry {
  batch: QuestionBatch
  state: QuestionRecord['state']
  resolvedOutcome?: 'answered' | 'cancelled' | undefined
  resolvedBy?: 'user' | 'remote' | undefined
  expiredCancel?: 'accepted' | 'rejected' | 'unknown' | undefined
  drafts: Map<string, QuestionDraft>
}

function toRecord(entry: StoreEntry): QuestionRecord {
  return {
    ...entry.batch,
    state: entry.state,
    ...(entry.resolvedOutcome === undefined ? {} : { resolvedOutcome: entry.resolvedOutcome }),
    ...(entry.resolvedBy === undefined ? {} : { resolvedBy: entry.resolvedBy }),
    ...(entry.expiredCancel === undefined ? {} : { expiredCancel: entry.expiredCancel }),
    draft: questionId => entry.drafts.get(questionId),
    drafts: () => [...entry.batch.questions.flatMap(question => {
      const draft = entry.drafts.get(question.id)
      return draft === undefined ? [] : [draft]
    })],
  }
}

export function createQuestionStore(): QuestionStore {
  const entries = new Map<string, StoreEntry>()
  const chains = new Map<string, Promise<unknown>>()

  function entry(rpcId: string): StoreEntry | undefined {
    return entries.get(rpcId)
  }

  /** Per-key serialization: operations on one batch never interleave. */
  function serialized<T>(rpcId: string, op: () => T | Promise<T>): Promise<T> {
    const tail = chains.get(rpcId) ?? Promise.resolve()
    const run = tail.then(op, op)
    chains.set(rpcId, run.then(() => undefined, () => undefined))
    return run
  }

  function mutate(rpcId: string, change: (found: StoreEntry) => void): Promise<void> {
    return serialized(rpcId, () => {
      const found = entries.get(rpcId)
      if (found === undefined) return
      change(found)
    })
  }

  return {
    get(rpcId) {
      const found = entry(rpcId)
      return found === undefined ? undefined : toRecord(found)
    },
    open(candidate) {
      const existing = entries.get(candidate.questionRpcId)
      if (existing !== undefined) return { ok: true }
      if (candidate.questions.length > MAX_QUESTIONS_PER_BATCH) return { ok: false, error: 'too-many-questions' }
      for (const question of candidate.questions) {
        const options = question.options ?? []
        if (options.length === 0) return { ok: false, error: 'options-required' }
        if (options.length > MAX_OPTIONS_PER_QUESTION) return { ok: false, error: 'too-many-options' }
        if (options.some(option => option.label.length > MAX_LABEL_LENGTH)) {
          return { ok: false, error: 'option-label-too-long' }
        }
      }
      entries.set(candidate.questionRpcId, {
        batch: candidate,
        state: 'pending',
        drafts: new Map(),
      })
      return { ok: true }
    },
    setDraft(rpcId, draft) {
      const found = entry(rpcId)
      if (found === undefined) return { ok: false, error: 'unknown-question' }
      const question = found.batch.questions.find(item => item.id === draft.id)
      const verdict = validateDraftAnswer(question, draft)
      if (!verdict.ok) return verdict
      found.drafts.set(draft.id, draft)
      return { ok: true, complete: isCompleteDraft(found.batch.questions, found.drafts) }
    },
    takeDrafts(rpcId) {
      const found = entry(rpcId)
      if (found === undefined) return []
      return found.batch.questions.flatMap(question => {
        const draft = found.drafts.get(question.id)
        return draft === undefined ? [] : [draft]
      })
    },
    encodeSubmitted(rpcId) {
      const found = entry(rpcId)
      if (found === undefined) return { answers: [] }
      return encodeAnswer(found.batch.questions, found.drafts)
    },
    claim(rpcId) {
      return serialized(rpcId, () => {
        const found = entries.get(rpcId)
        if (found === undefined) return { outcome: 'unknown' as const }
        const claimable = found.state === 'pending' || found.state === 'unresolved'
        if (!claimable) return { outcome: 'not-claimable' as const, record: toRecord(found) }
        found.state = 'submitting'
        return { outcome: 'claimed' as const, record: toRecord(found) }
      })
    },
    markResolved(rpcId, outcome, by, _atMs) {
      return mutate(rpcId, (found) => {
        // First resolution wins: a remote frame arriving after the user's own
        // recorded answer retires controls elsewhere, never rewrites history.
        if (found.state === 'resolved') return
        found.state = 'resolved'
        found.resolvedOutcome = outcome
        found.resolvedBy = by
      })
    },
    markUnresolved(rpcId, _atMs) {
      return mutate(rpcId, (found) => {
        found.state = 'unresolved'
      })
    },
    listPendingExpired(atMs) {
      const expired: QuestionRecord[] = []
      for (const entry of entries.values()) {
        if (entry.state === 'pending' && atMs >= entry.batch.expiresAtMs) expired.push(toRecord(entry))
      }
      return expired
    },
    markExpired(rpcId, cancel, _atMs) {
      return mutate(rpcId, (found) => {
        found.state = 'expired'
        found.expiredCancel = cancel
      })
    },
  }
}
