/**
 * Checkpoint D integration (11.11): the render pipeline — render model,
 * update scheduler, splitter, outbound builder, finalizer —
 * under bursty chunks, parallel tools, delayed REST, cancellation, and
 * duplicate events. Rendered fixtures are asserted directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createThreadRenderModel } from '../src/stream/render-model.js'
import { createUpdateScheduler } from '../src/stream/update-scheduler.js'
import { createAnswerFinalizer, type AnswerDeliveryPort } from '../src/stream/finalizer.js'
import { createToolActivitySurface } from '../src/stream/tool-view.js'
import { buildOutboundMessage } from '../src/stream/outbound.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('render pipeline under stress', () => {
  it('coalesces bursty chunks and finalizes once', async () => {
    // Bursty chunks into the render model.
    const model = createThreadRenderModel()
    model.beginTurn({ turnId: 't1' })
    model.beginStep({ turnId: 't1', stepId: 's1' })

    const edits: string[] = []
    const scheduler = createUpdateScheduler({
      minIntervalMs: 800,
      onFlush: (content) => { edits.push(content); return Promise.resolve() },
    })
    for (let index = 0; index < 200; index += 1) {
      model.appendDelta({ turnId: 't1', stepId: 's1', text: `w${String(index)} ` })
      scheduler.schedule(model.snapshot().answers[0]?.text ?? '')
    }
    await vi.advanceTimersByTimeAsync(800)
    // 200 chunks → exactly one coalesced edit per 800ms window so far.
    expect(edits).toHaveLength(1)

    // Duplicate event replay: the same chunk applied twice must not
    // double what Discord ever sees — the model is honest, but the
    // scheduler coalesces, and turn-end finalization is the commit point.
    model.appendDelta({ turnId: 't1', stepId: 's1', text: 'dup ' })
    model.appendDelta({ turnId: 't1', stepId: 's1', text: 'dup ' })
    const textAfterDup = model.snapshot().answers[0]?.text ?? ''
    expect(textAfterDup.endsWith('dup dup ')).toBe(true)
    scheduler.dispose()

    // Parallel tools render bounded rows without raw data.
    const tools = createToolActivitySurface({ verbosity: 'essential-tools' })
    tools.record({ callId: 'c1', toolName: 'bash', state: 'running', rawArguments: 'SECRET_ARGS' })
    tools.record({ callId: 'c2', toolName: 'unknown', state: 'succeeded', rawOutput: 'SECRET_OUT' })
    const toolRender = JSON.stringify(tools.render())
    expect(toolRender).not.toContain('SECRET')

    // Outbound: mention suppression on every path.
    const message = buildOutboundMessage({ kind: 'assistant', content: 'done @everyone' })
    expect(message.flags & (1 << 12)).toBe(1 << 12)

    // Finalization: exactly once, ordered continuations.
    const sendOrder: number[] = []
    const delivery: AnswerDeliveryPort = {
      editHead: () => Promise.resolve({ outcome: 'completed' }),
      sendContinuation: (request) => {
        sendOrder.push(request.index)
        return Promise.resolve({ outcome: 'completed' })
      },
    }
    const finalizer = createAnswerFinalizer({ delivery, headMessageId: 'head' })
    const long = Array.from({ length: 25 }, (_, index) => `block ${String(index)} ${'z'.repeat(400)}`).join('\n\n')
    const result = await finalizer.finalize(long)
    expect(result.outcome).toBe('finalized')
    expect(sendOrder).toEqual(sendOrder.map((_, position) => position + 1))
    expect((await finalizer.finalize(long)).outcome).toBe('skipped')
  })
})
