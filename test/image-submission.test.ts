/**
 * Image submission tests (12.3): mixed text/images encode into ordered
 * prompt parts and submit through `session.prompt` EXACTLY ONCE; an
 * unsupported model modality refuses before any DSH call; Host rejection is
 * a value; and a duplicate Discord delivery of the same message never
 * resubmits.
 */

import { describe, expect, it, vi } from 'vitest'

import { createKvTableStub } from './helpers/kv-table.js'
import { createIntentStore } from '../src/state/intents.js'
import { createImageSubmissionFlow, type DshImagePromptPort } from '../src/features/image-submission.js'

const PNG_BASE64 = 'iVBORw0KGgo='

function setup(submit: DshImagePromptPort['submit'], options: { supportsImages: boolean }) {
  const intents = createIntentStore(createKvTableStub())
  const submitMock = vi.fn(submit)
  const port: DshImagePromptPort = { submit: submitMock }
  const flow = createImageSubmissionFlow({
    prompts: port,
    intents,
    modality: () => options.supportsImages,
    nowMs: () => 1_000,
  })
  return { flow, submitMock, intents }
}

describe('image submission', () => {
  it('encodes mixed text and images into ordered parts and submits once', async () => {
    const { flow, submitMock } = setup(
      () => Promise.resolve({ outcome: 'accepted' }),
      { supportsImages: true },
    )

    const result = await flow.submit({
      requestId: 'm-1',
      sessionId: 'sess-1',
      text: 'what is in this screenshot',
      images: [{ mediaType: 'image/png', base64: PNG_BASE64 }],
    })

    expect(result).toEqual({ outcome: 'accepted' })
    const call = submitMock.mock.calls[0]?.[0]
    expect(call?.parts).toEqual([
      { type: 'text', text: 'what is in this screenshot' },
      { type: 'image', mediaType: 'image/png', data: PNG_BASE64 },
    ])
    expect(submitMock).toHaveBeenCalledTimes(1)
  })

  it('submits an image-only message without a text part', async () => {
    const { flow, submitMock } = setup(
      () => Promise.resolve({ outcome: 'accepted' }),
      { supportsImages: true },
    )
    await flow.submit({
      requestId: 'm-1',
      sessionId: 'sess-1',
      text: '',
      images: [{ mediaType: 'image/jpeg', base64: PNG_BASE64 }],
    })
    const parts = submitMock.mock.calls[0]?.[0]?.parts ?? []
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ type: 'image' })
  })

  it('refuses images on a model without image modality before any DSH call', async () => {
    const { flow, submitMock } = setup(
      () => Promise.resolve({ outcome: 'accepted' }),
      { supportsImages: false },
    )
    const result = await flow.submit({
      requestId: 'm-1',
      sessionId: 'sess-1',
      text: 'look',
      images: [{ mediaType: 'image/png', base64: PNG_BASE64 }],
    })
    expect(result).toEqual({ outcome: 'refused', reason: 'unsupported-modality' })
    expect(submitMock).not.toHaveBeenCalled()
  })

  it('maps Host rejection to a value and marks the intent failed', async () => {
    const { flow, submitMock, intents } = setup(
      () => Promise.resolve({ outcome: 'rejected' }),
      { supportsImages: true },
    )
    const result = await flow.submit({
      requestId: 'm-1',
      sessionId: 'sess-1',
      text: 'x',
      images: [{ mediaType: 'image/png', base64: PNG_BASE64 }],
    })
    expect(result).toEqual({ outcome: 'rejected' })
    expect(intents.get('m-1')?.state).toBe('failed')
    expect(submitMock).toHaveBeenCalledTimes(1)
  })

  it('never resubmits a duplicate Discord delivery of the same message', async () => {
    const { flow, submitMock } = setup(
      () => Promise.resolve({ outcome: 'accepted' }),
      { supportsImages: true },
    )
    const first = await flow.submit({
      requestId: 'm-1',
      sessionId: 'sess-1',
      text: 'same',
      images: [{ mediaType: 'image/png', base64: PNG_BASE64 }],
    })
    const replay = await flow.submit({
      requestId: 'm-1',
      sessionId: 'sess-1',
      text: 'same',
      images: [{ mediaType: 'image/png', base64: PNG_BASE64 }],
    })

    expect(first).toEqual({ outcome: 'accepted' })
    expect(replay).toEqual({ outcome: 'already-submitted' })
    expect(submitMock).toHaveBeenCalledTimes(1)
  })
})
