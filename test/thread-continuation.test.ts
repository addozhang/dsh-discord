/**
 * Thread continuation tests (8.5): EVERY ordinary message in an adapter-owned
 * thread goes through `session.prompt` with `mode: 'queue'` — whether the
 * session is idle or busy — and the flow never improvises steer or cancel
 * semantics on ordinary messages.
 */

import { describe, expect, it, vi } from 'vitest'

import { continueThread, type DshPromptPort } from '../src/features/thread-continuation.js'

function port() {
  const submit = vi.fn((_request: { requestId: string; sessionId: string; prompt: string; mode: 'queue' }): ReturnType<DshPromptPort['submit']> => Promise.resolve({ outcome: 'queued', position: 1 }))
  const prompts: DshPromptPort = { submit }
  return { prompts, submit }
}

describe('thread continuation', () => {
  it('queues an idle-session continuation', async () => {
    const { prompts, submit } = port()
    const result = await continueThread(prompts, {
      sessionId: 'sess-1',
      messageId: 'm-1',
      content: 'next step',
    })
    expect(result).toMatchObject({ outcome: 'queued', position: 1 })
    const firstCall = submit.mock.calls[0]?.[0]
    expect(firstCall).toEqual({
      requestId: 'm-1',
      sessionId: 'sess-1',
      prompt: 'next step',
      mode: 'queue',
    })
  })

  it('queues a busy-session continuation instead of steering', async () => {
    const { prompts, submit } = port()
    const result = await continueThread(prompts, {
      sessionId: 'sess-1',
      messageId: 'm-2',
      content: 'also this',
    })
    expect(result.outcome).toBe('queued')
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ mode: 'queue' })
  })

  it('never sends steer or stop shapes through continuation', async () => {
    const { prompts, submit } = port()
    await continueThread(prompts, { sessionId: 's', messageId: 'm', content: 'x' })
    const body: Record<string, unknown> | undefined = submit.mock.calls[0]?.[0]
    expect(body === undefined ? [] : Object.keys(body)).toEqual(['requestId', 'sessionId', 'prompt', 'mode'])
  })

  it('maps rejection and unknown outcomes to values', async () => {
    const rejecting: DshPromptPort = {
      submit: () => Promise.resolve({ outcome: 'rejected', reason: 'session-not-found' }),
    }
    expect(await continueThread(rejecting, { sessionId: 's', messageId: 'm', content: 'x' }))
      .toEqual({ outcome: 'rejected' })

    const unknown: DshPromptPort = { submit: () => Promise.resolve({ outcome: 'unknown' }) }
    expect(await continueThread(unknown, { sessionId: 's', messageId: 'm', content: 'x' }))
      .toEqual({ outcome: 'unknown' })
  })
})
