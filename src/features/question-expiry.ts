/**
 * Question expiry sweep (design.md §8, task 14.4). An ask left pending past
 * its deadline must not strand DSH's tool call forever, and the adapter has
 * no answer to give: the sweep atomically claims the batch — losing to any
 * user click, which then owns the question — requests cancellation of the
 * owning adapter-controlled turn through its request ID, records whether the
 * cancellation was accepted, and only then expires the Discord controls. The
 * sweep's dependencies carry no answer port, so it structurally cannot
 * synthesize a response.
 */

import type { QuestionStore } from './question-store.js'

/** The DSH cancellation face for the owning adapter-controlled turn. */
export interface DshTurnCancelPort {
  cancel(input: { sessionId: string; requestId: string }): Promise<
    | { outcome: 'accepted' }
    | { outcome: 'rejected'; reason: string }
    | { outcome: 'unknown' }
  >
}

/** Face that retires the rendered select menus and submit button. */
export interface QuestionControls {
  disable(questionRpcId: string): Promise<void>
}

export interface QuestionExpiryDeps {
  store: QuestionStore
  cancelPort: DshTurnCancelPort
  controls: QuestionControls
  nowMs: () => number
}

export interface QuestionExpiryResult {
  /** Question rpc ids this sweep cancelled and retired. */
  handled: string[]
}

export async function sweepExpiredQuestions(deps: QuestionExpiryDeps): Promise<QuestionExpiryResult> {
  const nowMs = deps.nowMs()
  const handled: string[] = []

  for (const record of deps.store.listPendingExpired(nowMs)) {
    // Atomic claim: a user click that beat the sweep owns the answer.
    const claim = await deps.store.claim(record.questionRpcId)
    if (claim.outcome !== 'claimed') continue

    const cancelled = await deps.cancelPort.cancel({
      sessionId: record.sessionId,
      requestId: record.requestId,
    })
    const outcome = cancelled.outcome === 'accepted'
      ? 'accepted'
      : cancelled.outcome === 'rejected'
        ? 'rejected'
        : 'unknown'
    await deps.store.markExpired(record.questionRpcId, outcome, deps.nowMs())
    // Controls expire only after the cancellation outcome is on the record.
    await deps.controls.disable(record.questionRpcId)
    handled.push(record.questionRpcId)
  }

  return { handled }
}

export interface AbandonQuestionDeps {
  store: Pick<QuestionStore, 'claim' | 'get' | 'markExpired'>
  cancelPort: DshTurnCancelPort
  nowMs: () => number
}

/**
 * The controls never reached Discord, so nobody can ever answer: cancel the
 * owning turn immediately instead of letting the sweep wait out the deadline
 * with DSH's tool call hanging. Same claim discipline as the sweep — a user
 * click that somehow won the race owns the question and this is a no-op.
 */
export async function abandonUnrenderableQuestion(deps: AbandonQuestionDeps, questionRpcId: string): Promise<void> {
  const claim = await deps.store.claim(questionRpcId)
  if (claim.outcome !== 'claimed') return
  const cancelled = await deps.cancelPort.cancel({
    sessionId: claim.record.sessionId,
    requestId: claim.record.requestId,
  })
  const outcome = cancelled.outcome === 'accepted'
    ? 'accepted'
    : cancelled.outcome === 'rejected'
      ? 'rejected'
      : 'unknown'
  await deps.store.markExpired(questionRpcId, outcome, deps.nowMs())
}
