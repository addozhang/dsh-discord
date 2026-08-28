/**
 * Render fence tests (11.4): late chunks from a superseded generation can
 * never overwrite newer output, and once a generation is finalized NOTHING —
 * not even a newer generation — mutates the terminal content.
 */

import { describe, expect, it } from 'vitest'

import { createRenderFence } from '../src/stream/render-fence.js'

describe('render fence', () => {
  it('publishes content for the current generation', () => {
    const fence = createRenderFence()
    fence.beginGeneration()
    const result = fence.publish('hello', fence.current())
    expect(result).toEqual({ published: true, visible: 'hello' })
  })

  it('drops publishes from a stale generation', () => {
    const fence = createRenderFence()
    const oldGen = fence.beginGeneration()
    fence.publish('newer', oldGen)

    fence.beginGeneration()
    const stale = fence.publish('late chunk', oldGen)
    expect(stale).toEqual({ published: false, visible: 'newer' })
  })

  it('finalizes the current generation and freezes the content', () => {
    const fence = createRenderFence()
    const gen = fence.beginGeneration()
    fence.publish('partial', gen)

    const finalized = fence.finalize(gen, 'the final answer')
    expect(finalized.ok).toBe(true)
    expect(fence.visible()).toBe('the final answer')

    // Post-finalize publishes are dropped even at the same generation.
    expect(fence.publish('late chunk', gen)).toEqual({ published: false, visible: 'the final answer' })
  })

  it('refuses a finalize from a stale generation', () => {
    const fence = createRenderFence()
    const oldGen = fence.beginGeneration()
    fence.publish('newer', oldGen)
    fence.beginGeneration()

    const result = fence.finalize(oldGen, 'stale final')
    expect(result).toEqual({ ok: false, error: 'stale-generation' })
    expect(fence.visible()).toBe('newer')
  })

  it('refuses a second finalize (terminal is terminal)', () => {
    const fence = createRenderFence()
    const gen = fence.beginGeneration()
    expect(fence.finalize(gen, 'first').ok).toBe(true)
    expect(fence.finalize(gen, 'second')).toEqual({ ok: false, error: 'already-final' })
    expect(fence.visible()).toBe('first')
  })
})
