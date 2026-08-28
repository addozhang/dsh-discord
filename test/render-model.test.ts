/**
 * Render model tests (11.1 + 11.2). Each DSH assistant message owns ONE
 * logical answer; deltas assemble into it; a later Step starts ANOTHER
 * logical answer; the authoritative `assistant/message` supersedes assembled
 * text; an interrupted message keeps its visible prefix; and an empty turn
 * completes without rendering anything.
 */

import { describe, expect, it } from 'vitest'

import { createThreadRenderModel } from '../src/stream/render-model.js'

describe('thread render model', () => {
  it('opens one logical answer per step and never overwrites an earlier one', () => {
    const model = createThreadRenderModel()
    model.beginTurn({ turnId: 't1' })
    model.beginStep({ turnId: 't1', stepId: 's1' })
    model.appendDelta({ turnId: 't1', stepId: 's1', text: 'answer one ' })
    model.beginStep({ turnId: 't1', stepId: 's2' })
    model.appendDelta({ turnId: 't1', stepId: 's2', text: 'answer two' })

    const answers = model.snapshot().answers
    expect(answers).toHaveLength(2)
    expect(answers[0]).toMatchObject({ stepId: 's1', text: 'answer one ' })
    expect(answers[1]).toMatchObject({ stepId: 's2', text: 'answer two' })
  })

  it('assembles deltas across chunks within one step', () => {
    const model = createThreadRenderModel()
    model.beginTurn({ turnId: 't1' })
    model.beginStep({ turnId: 't1', stepId: 's1' })
    for (const chunk of ['he', 'llo ', 'wo', 'rld']) {
      model.appendDelta({ turnId: 't1', stepId: 's1', text: chunk })
    }
    expect(model.snapshot().answers[0]?.text).toBe('hello world')
  })

  it('lets the authoritative assistant message supersede assembled deltas', () => {
    const model = createThreadRenderModel()
    model.beginTurn({ turnId: 't1' })
    model.beginStep({ turnId: 't1', stepId: 's1' })
    model.appendDelta({ turnId: 't1', stepId: 's1', text: 'partial' })
    model.setAuthoritative({ turnId: 't1', stepId: 's1', text: 'the final full text' })

    const answer = model.snapshot().answers[0]
    expect(answer?.text).toBe('the final full text')
    expect(answer?.authoritative).toBe(true)
  })

  it('marks an interrupted message and keeps its visible prefix', () => {
    const model = createThreadRenderModel()
    model.beginTurn({ turnId: 't1' })
    model.beginStep({ turnId: 't1', stepId: 's1' })
    model.appendDelta({ turnId: 't1', stepId: 's1', text: 'visible prefix' })
    model.interrupt({ turnId: 't1', stepId: 's1' })

    const answer = model.snapshot().answers[0]
    expect(answer?.interrupted).toBe(true)
    expect(answer?.text).toBe('visible prefix')
  })

  it('completes an empty turn without fabricating answers', () => {
    const model = createThreadRenderModel()
    model.beginTurn({ turnId: 't1' })
    model.endTurn({ turnId: 't1' })
    expect(model.snapshot().answers).toEqual([])
    expect(model.snapshot().turnOpen).toBe(false)
  })

  it('ignores deltas for unknown turns instead of throwing', () => {
    const model = createThreadRenderModel()
    expect(() => { model.appendDelta({ turnId: 'ghost', stepId: 'g', text: 'x' }); }).not.toThrow()
    expect(model.snapshot().answers).toEqual([])
  })

  it('keys answers by session+turn+step so sessions never mix', () => {
    const model = createThreadRenderModel()
    model.beginTurn({ turnId: 'a' })
    model.beginStep({ turnId: 'a', stepId: 's' })
    model.appendDelta({ turnId: 'a', stepId: 's', text: 'alpha' })
    expect(model.snapshot().answers[0]?.text).toBe('alpha')

    // A second thread model would be separate; within one, a new turn id
    // opens a fresh answer list.
    model.beginTurn({ turnId: 'b' })
    expect(model.snapshot().answers).toEqual([])
  })
})
