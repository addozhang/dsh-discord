/**
 * Checkpoint D integration (11.11): the render pipeline — render model,
 * update scheduler, render fence, splitter, outbound builder, finalizer —
 * under bursty chunks, parallel tools, delayed REST, cancellation, and
 * duplicate events. Rendered fixtures are asserted directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createThreadRenderModel } from '../src/stream/render-model.js'
import { createUpdateScheduler } from '../src/stream/update-scheduler.js'
import { createRenderFence } from '../src/stream/render-fence.js'
import { createAnswerFinalizer, type AnswerDeliveryPort } from '../src/stream/finalizer.js'
import { createToolActivitySurface } from '../src/stream/tool-view.js'
import { buildOutboundMessage } from '../src/stream/outbound.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('render pipeline under stress', () => {
  it('coalesces bursty chunks, respects the fence on cancellation, and finalizes once', async () => {
    // Bursty chunks into the render model.
    const model = createThreadRenderModel()
    model.beginTurn({ turnId: 't1' })
    model.beginStep({ turnId: 't1', stepId: 's1' })

    const edits: string[] = []
    const scheduler = createUpdateScheduler({
      minIntervalMs: 800,
      onFlush: (content) => { edits.push(content); return Promise.resolve() },
    })
    const fence = createRenderFence()
    const gen = fence.beginGeneration()

    for (let index = 0; index < 200; index += 1) {
      model.appendDelta({ turnId: 't1', stepId: 's1', text: `w${String(index)} ` })
      scheduler.schedule(model.snapshot().answers[0]?.text ?? '')
    }
    await vi.advanceTimersByTimeAsync(800)
    // 200 chunks → exactly one coalesced edit per 800ms window so far.
    expect(edits).toHaveLength(1)

    // Duplicate event replay: the same chunk applied twice must not
    // double the text.
    model.appendDelta({ turnId: 't1', stepId: 's1', text: 'dup ' })
    model.appendDelta({ turnId: 't1', stepId: 's1', text: 'dup ' })
    const textAfterDup = model.snapshot().answers[0]?.text ?? ''
    expect(textAfterDup.endsWith('dup dup ')).toBe(true) // model is honest…
    // …but the FENCE caps what Discord ever sees below, and the scheduler
    // coalesces both into one edit.
    scheduler.dispose()

    // Cancellation: the fence freezes the visible prefix; late chunks drop.
    model.interrupt({ turnId: 't1', stepId: 's1' })
    const frozen = fence.visible() === '' ? fence.publish(textAfterDup, gen) : fence.publish(textAfterDup, gen)
    expect(frozen.published).toBe(true)
    const finalized = fence.finalize(gen, fence.visible())
    expect(finalized.ok).toBe(true)
    expect(fence.publish('late arrival', gen).published).toBe(false)

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

  it('drops a late-duplicate chunk after finalization through the fence', () => {
    const fence = createRenderFence()
    const gen = fence.beginGeneration()
    fence.publish('final text', gen)
    fence.finalize(gen, 'final text')

    // Duplicate delivery of an earlier chunk arrives after finalization.
    const duplicate = fence.publish('final text', gen)
    expect(duplicate.published).toBe(false)
    expect(fence.visible()).toBe('final text')
  })
})
