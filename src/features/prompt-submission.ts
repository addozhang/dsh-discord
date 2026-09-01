/**
 * At-most-once prompt submission (design.md §5, §10, task 8.4). Every prompt
 * carries a stable request id claimed before the DSH call. A same-id/same-
 * hash delivery never resubmits; a different hash conflicts. A rejection ends
 * that intent — an explicit user retry mints a NEW intent. An unknown
 * admission is recorded as `unknown` and NEVER retried automatically; the
 * reconciler checks DSH history/queue evidence, and an explicit retry (new
 * intent) is the user's deliberate act.
 */

import { hashPayload, type IntentStore } from '../state/intents.js'

/** The DSH prompt surface the flow needs (session.prompt in production). */
export interface DshPromptPort {
  submit(request: {
    requestId: string
    sessionId: string
    prompt: string
    mode: 'queue'
    /** Collected images (16.50); omitted for text-only prompts so legacy shapes are untouched. */
    images?: ReadonlyArray<PromptRequestImage>
  }): Promise<
    | { outcome: 'accepted' }
    | { outcome: 'rejected'; reason: string }
    | { outcome: 'unknown' }
  >
}

/** One collected image, ready for the prompt parts encoding. */
export interface PromptRequestImage {
  mediaType: string
  base64: string
}

export interface PromptSubmissionDeps {
  prompts: DshPromptPort
  intents: IntentStore
  nowMs: () => number
}

export type PromptSubmissionResult =
  | { outcome: 'accepted' }
  | { outcome: 'rejected' }
  | { outcome: 'unknown' }
  | { outcome: 'already-submitted' }
  | { outcome: 'conflict' }

export interface PromptRequest {
  requestId: string
  sessionId: string
  prompt: string
  /** Collected images (16.50); omitted for text-only prompts. */
  images?: ReadonlyArray<PromptRequestImage>
}

export function createPromptSubmissionFlow(deps: PromptSubmissionDeps): {
  submitOnce(request: PromptRequest): Promise<PromptSubmissionResult>
  retry(request: PromptRequest, options: { newRequestId: string }): Promise<PromptSubmissionResult>
} {
  async function submit(requestId: string, request: PromptRequest): Promise<PromptSubmissionResult> {
    const images = request.images ?? []
    const contentHash = await hashPayload({
      sessionId: request.sessionId,
      prompt: request.prompt,
      ...(images.length > 0 ? { images } : {}),
    })
    const claim = await deps.intents.claim({
      messageId: requestId,
      contentHash,
      claimedAtMs: deps.nowMs(),
    })

    if (claim.outcome === 'conflict') return { outcome: 'conflict' }
    if (claim.outcome === 'duplicate') {
      return { outcome: 'already-submitted' }
    }

    const submitted = await deps.prompts.submit({
      requestId,
      sessionId: request.sessionId,
      prompt: request.prompt,
      mode: 'queue',
      ...(images.length > 0 ? { images } : {}),
    })

    if (submitted.outcome === 'accepted') {
      await deps.intents.resolve(requestId, 'succeeded', deps.nowMs())
      return { outcome: 'accepted' }
    }
    if (submitted.outcome === 'rejected') {
      await deps.intents.resolve(requestId, 'failed', deps.nowMs())
      return { outcome: 'rejected' }
    }
    await deps.intents.resolve(requestId, 'unknown', deps.nowMs())
    return { outcome: 'unknown' }
  }

  return {
    submitOnce: request => submit(request.requestId, request),
    retry(request, { newRequestId }) {
      return submit(newRequestId, request)
    },
  }
}
