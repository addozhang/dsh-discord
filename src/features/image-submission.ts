/**
 * Image submission through `session.prompt` (design.md §12, task 12.3).
 * Mixed text/images encode into ordered prompt parts; the model's modality
 * is checked BEFORE any DSH call; and the request id claims an intent so a
 * duplicate Discord delivery never resubmits. Host outcomes map to values
 * with the intent state kept honest (failed on rejection, unknown preserved
 * for reconciliation).
 */

import { hashPayload, type IntentStore } from '../state/intents.js'

export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string }

export interface DshImagePromptPort {
  submit(request: { requestId: string; sessionId: string; parts: readonly PromptPart[] }): Promise<
    | { outcome: 'accepted' }
    | { outcome: 'rejected' }
    | { outcome: 'unknown' }
  >
}

export interface ImageSubmissionDeps {
  prompts: DshImagePromptPort
  intents: IntentStore
  /** Whether the session's current model accepts image parts. */
  modality: () => boolean
  nowMs: () => number
}

export type ImageSubmissionResult =
  | { outcome: 'accepted' }
  | { outcome: 'rejected' }
  | { outcome: 'unknown' }
  | { outcome: 'already-submitted' }
  | { outcome: 'refused'; reason: 'unsupported-modality' }

/** Encode text plus images into ordered prompt parts. */
export function encodePromptParts(text: string, images: ReadonlyArray<{ mediaType: string; base64: string }>): PromptPart[] {
  const parts: PromptPart[] = []
  const trimmed = text.trim()
  if (trimmed !== '') parts.push({ type: 'text', text: trimmed })
  for (const image of images) {
    parts.push({ type: 'image', mediaType: image.mediaType, data: image.base64 })
  }
  return parts
}

export function createImageSubmissionFlow(deps: ImageSubmissionDeps): {
  submit(request: {
    requestId: string
    sessionId: string
    text: string
    images: ReadonlyArray<{ mediaType: string; base64: string }>
  }): Promise<ImageSubmissionResult>
} {
  return {
    async submit(request) {
      const parts = encodePromptParts(request.text, request.images)

      // Modality gate: refuse BEFORE the intent claim so an explicit user
      // retry with a text-only message is a clean new attempt.
      if (request.images.length > 0 && !deps.modality()) {
        return { outcome: 'refused', reason: 'unsupported-modality' }
      }

      const contentHash = await hashPayload({ sessionId: request.sessionId, parts })
      const claim = await deps.intents.claim({
        messageId: request.requestId,
        contentHash,
        claimedAtMs: deps.nowMs(),
      })
      if (claim.outcome === 'conflict') return { outcome: 'already-submitted' }
      if (claim.outcome === 'duplicate') return { outcome: 'already-submitted' }

      const submitted = await deps.prompts.submit({
        requestId: request.requestId,
        sessionId: request.sessionId,
        parts,
      })

      if (submitted.outcome === 'accepted') {
        await deps.intents.resolve(request.requestId, 'succeeded', deps.nowMs())
        return { outcome: 'accepted' }
      }
      if (submitted.outcome === 'rejected') {
        await deps.intents.resolve(request.requestId, 'failed', deps.nowMs())
        return { outcome: 'rejected' }
      }
      await deps.intents.resolve(request.requestId, 'unknown', deps.nowMs())
      return { outcome: 'unknown' }
    },
  }
}
