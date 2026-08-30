/**
 * Question interaction routing (design.md §8, tasks 14.2/14.3). Select
 * answers record against the pending batch through the opaque registry;
 * choosing the reserved "Other" value opens the custom-text modal instead of
 * recording; modal submits record the text. Labels outside the offered
 * options, unknown question ids, and oversized text are refused as values —
 * never silently dropped. Only the originating user on the owning thread may
 * answer, and an incomplete batch never reaches DSH: one complete response
 * or nothing.
 */

import type { ComponentRegistry } from '../discord/components.js'
import { CUSTOM_ANSWER_VALUE } from './question-view.js'
import {
  MAX_CUSTOM_LENGTH,
  type DraftAnswerError,
  type EncodedQuestionAnswer,
  type QuestionRecord,
  type QuestionStore,
} from './question-store.js'

export { CUSTOM_ANSWER_VALUE }

/** The DSH respond face for questions: the answer echoes the ask's rpcId. */
export interface DshQuestionRespondPort {
  respond(input: {
    rpcId: string
    sessionId: string
    answer: EncodedQuestionAnswer
  }): Promise<
    | { outcome: 'confirmed' }
    | { outcome: 'rejected'; reason: string }
    | { outcome: 'unknown' }
  >
}

export interface QuestionRoutingDeps {
  registry: ComponentRegistry
  store: QuestionStore
  port: DshQuestionRespondPort
  nowMs: () => number
  /** Retires the rendered controls on a submitted (terminal) outcome. */
  controls: { disable(questionRpcId: string): Promise<void> }
}

export interface QuestionInteractionInput {
  customId: string
  userId: string
  threadId: string
}

/** The modal descriptor the wire layer turns into a Discord modal callback. */
export interface ModalDescriptor {
  /** Bounded title; Discord allows 45 characters. */
  title: string
  custom_id: string
  textInput: {
    label: string
    min_length: number
    max_length: number
    required: true
    style: 'paragraph'
  }
}

export type QuestionInteractionOutcome =
  | { outcome: 'recorded'; complete: boolean }
  | { outcome: 'modal-requested'; modal: ModalDescriptor }
  | { outcome: 'submitted' }
  | { outcome: 'already-resolved' }
  | { outcome: 'denied' }
  | { outcome: 'unknown-control' }
  | { outcome: 'invalid-answer'; reason: DraftAnswerError }
  | { outcome: 'incomplete' }
  | { outcome: 'unresolved' }
  | { outcome: 'resolved-elsewhere' }

interface RegistryContext {
  questionRpcId: string
  action: 'select' | 'submit' | 'modal'
  questionId?: string | undefined
}

function parseContext(context: Record<string, unknown>): RegistryContext | undefined {
  const questionRpcId = context['questionRpcId']
  const action = context['action']
  if (typeof questionRpcId !== 'string') return undefined
  if (action !== 'select' && action !== 'submit' && action !== 'modal') return undefined
  const questionId = context['questionId']
  return {
    questionRpcId,
    action,
    ...(typeof questionId === 'string' ? { questionId } : {}),
  }
}

/** Milestone 1 question authorization: the originating user, own thread, point. */
function authorize(record: QuestionRecord, input: { userId: string; threadId: string }): boolean {
  return input.userId === record.actorUserId && input.threadId === record.threadId
}

function resolveContext(
  deps: QuestionRoutingDeps,
  customId: string,
): { context: RegistryContext; record: QuestionRecord } | { outcome: 'unknown-control' } {
  const resolution = deps.registry.resolve(customId, deps.nowMs())
  if (!resolution.found) return { outcome: 'unknown-control' as const }
  const context = parseContext(resolution.context)
  if (context === undefined) return { outcome: 'unknown-control' as const }
  const record = deps.store.get(context.questionRpcId)
  if (record === undefined) return { outcome: 'unknown-control' as const }
  return { context, record }
}

function modalTitle(question: string): string {
  const title = question.length <= 45 ? question : `${question.slice(0, 44)}…`
  return title
}

export async function handleSelectInput(
  deps: QuestionRoutingDeps,
  input: QuestionInteractionInput & { values: string[] },
): Promise<QuestionInteractionOutcome> {
  const resolved = resolveContext(deps, input.customId)
  if ('outcome' in resolved) return resolved
  const { context, record } = resolved

  if (!authorize(record, input)) return { outcome: 'denied' }
  if (record.state === 'resolved' || record.state === 'submitting' || record.state === 'expired') {
    return { outcome: 'already-resolved' }
  }

  if (context.action === 'submit') {
    const drafts = record.drafts()
    const complete = record.questions.every(question => drafts.some(draft => draft.id === question.id))
    if (!complete) return { outcome: 'incomplete' }

    // Atomic claim: pending or an explicit retry after an unconfirmed submit.
    const claim = await deps.store.claim(context.questionRpcId)
    if (claim.outcome !== 'claimed') return { outcome: 'already-resolved' }

    // A port that THROWS (distinct from an unknown outcome) is still an
    // unconfirmed submit: park unresolved so the expiry sweeps and the
    // user's own retry stay available — never leave the ask in submitting.
    let submitted: Awaited<ReturnType<typeof deps.port.respond>>
    try {
      submitted = await deps.port.respond({
        rpcId: record.questionRpcId,
        sessionId: record.sessionId,
        answer: deps.store.encodeSubmitted(context.questionRpcId),
      })
    } catch {
      await deps.store.markUnresolved(context.questionRpcId, deps.nowMs())
      return { outcome: 'unresolved' }
    }
    if (submitted.outcome === 'confirmed') {
      await deps.store.markResolved(context.questionRpcId, 'answered', 'user', deps.nowMs())
      // Terminal: retire the controls so stray clicks cannot follow.
      // (disableControl never throws; the guard keeps the settled outcome.)
      await deps.controls.disable(context.questionRpcId).catch(() => {})
      return { outcome: 'submitted' }
    }
    await deps.store.markUnresolved(context.questionRpcId, deps.nowMs())
    return { outcome: 'unresolved' }
  }

  if (context.action !== 'select' || context.questionId === undefined) return { outcome: 'unknown-control' }

  // The reserved Other value opens the custom-text modal instead of
  // recording a label answer.
  if (input.values.includes(CUSTOM_ANSWER_VALUE)) {
    const question = record.questions.find(item => item.id === context.questionId)
    if (question === undefined) return { outcome: 'unknown-control' }
    const customId = deps.registry.register({
      questionRpcId: context.questionRpcId,
      action: 'modal',
      questionId: question.id,
      expiresAtMs: record.expiresAtMs,
    })
    return {
      outcome: 'modal-requested',
      modal: {
        title: modalTitle(question.question),
        custom_id: customId,
        textInput: {
          label: question.header ?? 'Your answer',
          min_length: 1,
          max_length: MAX_CUSTOM_LENGTH,
          required: true,
          style: 'paragraph',
        },
      },
    }
  }

  const verdict = deps.store.setDraft(context.questionRpcId, {
    id: context.questionId,
    selected: input.values,
  })
  if (!verdict.ok) return { outcome: 'invalid-answer', reason: verdict.error }
  return { outcome: 'recorded', complete: verdict.complete }
}

export function handleModalSubmit(
  deps: QuestionRoutingDeps,
  input: QuestionInteractionInput & { text: string },
): QuestionInteractionOutcome {
  const resolved = resolveContext(deps, input.customId)
  if ('outcome' in resolved) return resolved
  const { context, record } = resolved

  if (context.action !== 'modal' || context.questionId === undefined) return { outcome: 'unknown-control' }
  if (!authorize(record, input)) return { outcome: 'denied' }
  if (record.state === 'resolved' || record.state === 'submitting' || record.state === 'expired') {
    return { outcome: 'already-resolved' }
  }
  if (input.text.length === 0 || input.text.length > MAX_CUSTOM_LENGTH) {
    return { outcome: 'invalid-answer', reason: 'custom-too-long' }
  }

  const verdict = deps.store.setDraft(context.questionRpcId, {
    id: context.questionId,
    selected: [],
    custom: input.text,
  })
  if (!verdict.ok) return { outcome: 'invalid-answer', reason: verdict.error }
  return { outcome: 'recorded', complete: verdict.complete }
}

/**
 * A `question/resolved` frame arrived from the Host: the ask was answered or
 * cancelled by another client. The adapter retires its controls and never
 * submits afterwards; a resolution the adapter already recorded (the user's
 * own answer) stays first — the remote frame only retires the controls.
 */
export interface RemoteResolutionDeps {
  store: Pick<QuestionStore, 'get' | 'markResolved'>
  controls: { disable(questionRpcId: string): Promise<void> }
  nowMs: () => number
}

export async function handleRemoteResolution(
  deps: RemoteResolutionDeps,
  input: { questionRpcId: string; outcome: 'answered' | 'cancelled' },
): Promise<{ outcome: 'resolved-elsewhere' } | { outcome: 'unknown-control' }> {
  const record = deps.store.get(input.questionRpcId)
  if (record === undefined) return { outcome: 'unknown-control' }

  if (record.state !== 'resolved') {
    await deps.store.markResolved(input.questionRpcId, input.outcome, 'remote', deps.nowMs())
  }
  await deps.controls.disable(input.questionRpcId)
  return { outcome: 'resolved-elsewhere' }
}
