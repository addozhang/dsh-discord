/**
 * Composition wiring for the answerable server-request face (approvals and
 * questions): ownership resolution, record opening, control rendering, and
 * render-failure abandonment in one testable unit. This is the layer where
 * the live incidents lived (an actor lost across turns, a batch built from
 * the wrong field names) — so the wiring is a module, not inline glue.
 *
 * Ownership rule: the active turn's Discord author wins; when DSH starts
 * follow-up turns without a new submission the durable thread creator falls
 * back as owner (Milestone 1: one thread, one session, one owner).
 */

import type { ComponentRegistry } from '../discord/components.js'
import type { ApprovalStore } from './approval-store.js'
import { renderApprovalControls } from './approval-view.js'
import type { QuestionStore } from './question-store.js'
import { renderQuestionControls } from './question-view.js'
import type { DshTurnCancelPort } from './question-expiry.js'
import { abandonUnrenderableQuestion } from './question-expiry.js'
import { handleRemoteResolution } from './question-routing.js'

/** One approval ask projected from the Host mux frame. */
export interface ApprovalAskInput {
  sessionId: string
  threadId: string
  rpcId: string
  approvalId: string
  toolName: string
  reason?: string | undefined
  expiresAtMs: number
}

/** One question ask projected from the Host mux frame (raw question rows). */
export interface QuestionAskInput {
  sessionId: string
  threadId: string
  rpcId: string
  expiresAtMs: number
  questions: ReadonlyArray<Record<string, unknown>>
}

export interface AskWiringDeps {
  registry: ComponentRegistry
  approvals: ApprovalStore
  questions: QuestionStore
  /** Cancellation face for asks that can never be answered. */
  cancelPort: DshTurnCancelPort
  nowMs(): number
  log(event: string, detail?: unknown): void
  /** Request id of the adapter-owned active turn, when the adapter owns one. */
  activeTurnRequestId(sessionId: string): string | undefined
  /** The Discord author recorded for a submitted request id. */
  turnActor(requestId: string): string | undefined
  /** The durable thread binding's creator, when the thread is bound. */
  threadOwner(threadId: string): string | undefined
  /**
   * Post one rendered control message into the ask's thread. `stored` is
   * true only when Discord accepted the message and returned its id;
   * otherwise `reason` carries the failure cause for the log.
   */
  postMessage(threadId: string, payload: unknown): Promise<{ stored: boolean; reason?: string; messageId?: string }>
  /**
   * Edit an already-posted control message (PATCH). Retirement greys the
   * controls out on the ORIGINAL message — a POST would only add a new,
   * empty message while the live buttons stayed behind (16.41).
   */
  editMessage(channelId: string, messageId: string, payload: unknown): Promise<{ stored: boolean; reason?: string }>
}

export function createAskWiring(deps: AskWiringDeps): {
  /** Retire a rendered control (clear components) once the ask is settled. */
  disableControl(key: string): Promise<void>
  onApprovalRequested(input: ApprovalAskInput): void
  onApprovalResolved(input: { sessionId: string; approvalId: string; outcome?: string | undefined }): void
  onQuestionRequested(input: QuestionAskInput): void
  onQuestionResolved(input: { sessionId: string; questionRpcId: string; outcome: 'answered' | 'cancelled' }): void
} {
  /** Discord message refs + rendered rows for controls, keyed by ask id. */
  const controlMessages = new Map<string, { channelId: string; messageId: string; components: unknown }>()

  /**
   * Every interactive component greys out (`disabled: true`): the settled
   * ask keeps its visual context on the thread and Discord stops
   * delivering clicks for it entirely.
   */
  type WireComponent = Record<string, unknown>
  type WireRow = { components?: WireComponent[] }
  function disabledComponents(components: unknown): unknown {
    if (!Array.isArray(components)) return []
    return (components as WireRow[]).map(row => ({
      ...row,
      components: (row.components ?? []).map(control => ({ ...control, disabled: true })),
    }))
  }

  const disableControl = async (key: string): Promise<void> => {
    const target = controlMessages.get(key)
    if (target === undefined) return
    controlMessages.delete(key)
    // Retirement is best-effort: a failed disable must never fail the ask's
    // settled outcome — the registry TTL keeps stray clicks answerable.
    try {
      const patched = await deps.editMessage(target.channelId, target.messageId, {
        components: disabledComponents(target.components),
      })
      if (!patched.stored) deps.log('discord_control_disable_failed', { key, reason: patched.reason })
    } catch (cause) {
      deps.log('discord_control_disable_failed', { key, cause: String(cause) })
    }
  }

  function resolveAskActor(sessionId: string, threadId: string): { actorUserId: string; actorSource: 'turn' | 'thread-binding' | 'none' } {
    const requestId = deps.activeTurnRequestId(sessionId)
    if (requestId !== undefined) {
      const actor = deps.turnActor(requestId)
      if (actor !== undefined) return { actorUserId: actor, actorSource: 'turn' }
    }
    const owner = deps.threadOwner(threadId)
    if (owner !== undefined) return { actorUserId: owner, actorSource: 'thread-binding' }
    return { actorUserId: '', actorSource: 'none' }
  }

  return {
    disableControl,

    onApprovalRequested: (input) => {
      const { actorUserId, actorSource } = resolveAskActor(input.sessionId, input.threadId)
      const requestId = deps.activeTurnRequestId(input.sessionId) ?? ''
      deps.log('discord_approval_opened', {
        approvalId: input.approvalId, requestId, actorUserId, actorSource,
        sessionId: input.sessionId, threadId: input.threadId,
      })
      deps.approvals.open({
        approvalId: input.approvalId,
        sessionId: input.sessionId,
        threadId: input.threadId,
        requestId,
        rpcId: input.rpcId,
        actorUserId,
        toolName: input.toolName,
        reason: input.reason,
        expiresAtMs: input.expiresAtMs,
        state: 'pending',
      })
      const payload = renderApprovalControls({
        registry: deps.registry,
        sessionId: input.sessionId,
        rpcId: input.rpcId,
        approvalId: input.approvalId,
        toolName: input.toolName,
        reason: input.reason,
        expiresAtMs: input.expiresAtMs,
      })
      void deps.postMessage(input.threadId, payload)
        .then(sent => {
          if (sent.stored && sent.messageId !== undefined) {
            controlMessages.set(input.approvalId, { channelId: input.threadId, messageId: sent.messageId, components: payload.components })
          }
        })
        .catch((cause: unknown) => { deps.log('discord_approval_render_failed', String(cause)) })
    },

    onApprovalResolved: (input) => {
      const record = deps.approvals.get(input.approvalId)
      if (record !== undefined && record.state === 'pending') {
        void deps.approvals.markResolved(
          input.approvalId,
          input.outcome === 'allowed-once' ? 'allowed-once' : 'rejected',
          deps.nowMs(),
        )
      }
      void disableControl(input.approvalId)
    },

    onQuestionRequested: (input) => {
      const { actorUserId, actorSource } = resolveAskActor(input.sessionId, input.threadId)
      const requestId = deps.activeTurnRequestId(input.sessionId) ?? ''
      deps.log('discord_question_opened', {
        questionRpcId: input.rpcId, requestId, actorUserId, actorSource,
        sessionId: input.sessionId, threadId: input.threadId,
      })
      const batch = {
        questionRpcId: input.rpcId,
        sessionId: input.sessionId,
        threadId: input.threadId,
        requestId,
        actorUserId,
        expiresAtMs: input.expiresAtMs,
        questions: input.questions.map(question => ({
          id: typeof question['id'] === 'string' ? question['id'] : '',
          question: typeof question['question'] === 'string' ? question['question'] : '',
          header: typeof question['header'] === 'string' ? question['header'] : undefined,
          options: Array.isArray(question['options'])
            ? question['options'].map(option => ({
                label: typeof (option as { label?: unknown }).label === 'string'
                  ? (option as { label: string }).label
                  : '',
              }))
            : undefined,
          multiSelect: question['multiSelect'] === true,
        })),
      }
      const opened = deps.questions.open(batch)
      if (!opened.ok) {
        deps.log('discord_question_open_rejected', { error: opened.error })
        return
      }
      const payload = renderQuestionControls({ registry: deps.registry, batch })
      // Controls that never reached Discord can never be answered: cancel
      // the owning Turn now instead of letting the sweep wait out the
      // deadline with DSH's tool call hanging.
      const abandonQuestion = (cause: string): void => {
        deps.log('discord_question_render_failed', cause)
        void abandonUnrenderableQuestion(
          { store: deps.questions, cancelPort: deps.cancelPort, nowMs: () => deps.nowMs() },
          input.rpcId,
        ).catch(() => {})
      }
      void deps.postMessage(input.threadId, payload)
        .then(sent => {
          if (!sent.stored || sent.messageId === undefined) {
            abandonQuestion(sent.reason ?? 'post rejected')
            return
          }
          controlMessages.set(input.rpcId, { channelId: input.threadId, messageId: sent.messageId, components: payload.components })
        })
        .catch((cause: unknown) => { abandonQuestion(String(cause)) })
    },

    onQuestionResolved: (input) => {
      void handleRemoteResolution(
        {
          store: deps.questions,
          controls: { disable: key => disableControl(key) },
          nowMs: () => deps.nowMs(),
        },
        { questionRpcId: input.questionRpcId, outcome: input.outcome },
      ).catch((cause: unknown) => { deps.log('discord_question_remote_resolve_failed', String(cause)) })
    },
  }
}
