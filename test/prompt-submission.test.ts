/**
 * Initial prompt submission tests (8.4). Every submission carries a stable
 * request id claimed BEFORE the DSH call: same-id/same-hash replays never
 * resubmit, different hashes conflict, a rejection is final for that intent
 * (explicit retry mints a NEW intent), and an unknown admission is recorded
 * and never retried automatically — reconciliation or an explicit user retry
 * decides.
 */

import { describe, expect, it, vi } from 'vitest'

import { createKvTableStub } from './helpers/kv-table.js'
import { createIntentStore } from '../src/state/intents.js'
import { createPromptSubmissionFlow, type DshPromptPort } from '../src/features/prompt-submission.js'

function setup(submit: DshPromptPort['submit']) {
  const intents = createIntentStore(createKvTableStub())
  const submitMock = vi.fn(submit)
  const port: DshPromptPort = { submit: submitMock }
  const flow = createPromptSubmissionFlow({ prompts: port, intents, nowMs: () => 1_000 })
  return { flow, submitFn: submitMock, intents }
}

const REQUEST = { requestId: 'req-1', sessionId: 'sess-1', prompt: 'do the thing' }

describe('prompt submission', () => {
  it('submits once and records success', async () => {
    const { flow, submitFn } = setup(() => Promise.resolve({ outcome: 'accepted' }))
    const result = await flow.submitOnce(REQUEST)
    expect(result).toEqual({ outcome: 'accepted' })
    expect(submitFn).toHaveBeenCalledTimes(1)
  })

  it('never resubmits a same-id/same-hash replay', async () => {
    const { flow, submitFn } = setup(() => Promise.resolve({ outcome: 'accepted' }))
    await flow.submitOnce(REQUEST)
    const replay = await flow.submitOnce({ ...REQUEST, prompt: 'do the thing' })
    expect(replay).toEqual({ outcome: 'already-submitted' })
    expect(submitFn).toHaveBeenCalledTimes(1)
  })

  it('conflicts when the same request id carries different content', async () => {
    const { flow, submitFn } = setup(() => Promise.resolve({ outcome: 'accepted' }))
    await flow.submitOnce(REQUEST)
    const conflict = await flow.submitOnce({ ...REQUEST, prompt: 'DIFFERENT' })
    expect(conflict).toEqual({ outcome: 'conflict' })
    expect(submitFn).toHaveBeenCalledTimes(1)
  })

  it('records a rejection as final for that intent; explicit retry mints a new one', async () => {
    const responses: Array<ReturnType<DshPromptPort['submit']>> = [
      Promise.resolve({ outcome: 'rejected', reason: 'session-not-found' }),
      Promise.resolve({ outcome: 'accepted' }),
    ]
    const { flow, submitFn } = setup(() => responses.shift() ?? Promise.resolve({ outcome: 'accepted' }))
    const rejected = await flow.submitOnce(REQUEST)
    expect(rejected).toEqual({ outcome: 'rejected' })
    expect(submitFn).toHaveBeenCalledTimes(1)

    // The SAME intent is never resubmitted…
    expect(await flow.submitOnce(REQUEST)).toEqual({ outcome: 'already-submitted' })
    expect(submitFn).toHaveBeenCalledTimes(1)

    // …but an explicit retry creates a fresh intent and lands.
    const retry = await flow.retry(REQUEST, { newRequestId: 'req-2' })
    expect(retry).toEqual({ outcome: 'accepted' })
    expect(submitFn).toHaveBeenCalledTimes(2)
  })

  it('records an unknown admission without retrying; explicit retry lands', async () => {
    const { flow, submitFn } = setup(() => Promise.resolve({ outcome: 'unknown' }))
    const unknown = await flow.submitOnce(REQUEST)
    expect(unknown).toEqual({ outcome: 'unknown' })
    expect(submitFn).toHaveBeenCalledTimes(1)

    // No automatic resubmission of the uncertain intent.
    expect(await flow.submitOnce(REQUEST)).toEqual({ outcome: 'already-submitted' })
    expect(submitFn).toHaveBeenCalledTimes(1)

    const retry = await flow.retry(REQUEST, { newRequestId: 'req-2' })
    expect(retry).toEqual({ outcome: 'unknown' })
    expect(submitFn).toHaveBeenCalledTimes(2)
  })
})

describe('prompt submission with images (16.50)', () => {
  const PNG = { mediaType: 'image/png', base64: 'cG5n' }
  const GIF = { mediaType: 'image/gif', base64: 'Z2lm' }

  it('carries images through to the port on the submitted request', async () => {
    const { flow, submitFn } = setup(() => Promise.resolve({ outcome: 'accepted' }))
    const result = await flow.submitOnce({ ...REQUEST, images: [PNG] })
    expect(result).toEqual({ outcome: 'accepted' })
    expect(submitFn.mock.calls[0]?.[0]).toEqual({
      requestId: 'req-1',
      sessionId: 'sess-1',
      prompt: 'do the thing',
      mode: 'queue',
      images: [PNG],
    })
  })

  it('keeps text-only requests at the exact legacy wire shape (no images key)', async () => {
    const { flow, submitFn } = setup(() => Promise.resolve({ outcome: 'accepted' }))
    await flow.submitOnce(REQUEST)
    expect(Object.keys(submitFn.mock.calls[0]?.[0] ?? {})).toEqual(['requestId', 'sessionId', 'prompt', 'mode'])
  })

  it('dedupes a replay of the same id with the same images', async () => {
    const { flow, submitFn } = setup(() => Promise.resolve({ outcome: 'accepted' }))
    await flow.submitOnce({ ...REQUEST, images: [PNG] })
    const replay = await flow.submitOnce({ ...REQUEST, images: [PNG] })
    expect(replay).toEqual({ outcome: 'already-submitted' })
    expect(submitFn).toHaveBeenCalledTimes(1)
  })

  it('conflicts when the same request id carries a different image', async () => {
    const { flow, submitFn } = setup(() => Promise.resolve({ outcome: 'accepted' }))
    await flow.submitOnce({ ...REQUEST, images: [PNG] })
    const conflict = await flow.submitOnce({ ...REQUEST, images: [GIF] })
    expect(conflict).toEqual({ outcome: 'conflict' })
    expect(submitFn).toHaveBeenCalledTimes(1)
  })

  it('hashes images separately from text: same image + different text conflicts', async () => {
    const { flow, submitFn } = setup(() => Promise.resolve({ outcome: 'accepted' }))
    await flow.submitOnce({ ...REQUEST, images: [PNG] })
    const conflict = await flow.submitOnce({ ...REQUEST, prompt: 'DIFFERENT', images: [PNG] })
    expect(conflict).toEqual({ outcome: 'conflict' })
    expect(submitFn).toHaveBeenCalledTimes(1)
  })
})
