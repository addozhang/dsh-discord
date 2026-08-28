/**
 * Question rendering tests (14.1): a pending question batch renders as one
 * string select per question — multi-select semantics via Discord min/max
 * values — with opaque registry custom_ids. Labels, question ids, and rpc
 * data never ride the wire. A Submit button exists only when the action-row
 * budget allows; a full five-question batch auto-submits on completion.
 */

import { describe, expect, it } from 'vitest'

import { createComponentRegistry, type ComponentRegistry } from '../src/discord/components.js'
import type { QuestionBatch } from '../src/features/question-store.js'
import {
  renderQuestionControls,
  type QuestionSelectComponent,
} from '../src/features/question-view.js'

function batch(overrides: Partial<QuestionBatch> = {}): QuestionBatch {
  return {
    questionRpcId: 'qrpc-MARKER-rpc',
    sessionId: 'sess-MARKER-session',
    threadId: 'thread-MARKER-thread',
    requestId: 'req-MARKER-request',
    actorUserId: 'user-owner',
    expiresAtMs: 60_000,
    questions: [
      { id: 'q1', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multiSelect: false },
      { id: 'q2', question: 'Which languages?', options: [{ label: 'TypeScript' }, { label: 'Rust' }], multiSelect: true },
    ],
    ...overrides,
  }
}

function setup() {
  let n = 0
  const registry: ComponentRegistry = createComponentRegistry({ idFactory: () => {
    n += 1
    return `opaque-${String(n)}`
  } })
  return { registry }
}

describe('question controls rendering', () => {
  it('renders one select per question with multi-select min/max semantics', () => {
    const { registry } = setup()
    const view = renderQuestionControls({ registry, batch: batch() })

    const selects = view.components.flatMap(row => row.components).filter((component): component is QuestionSelectComponent => component.type === 3)
    expect(selects).toHaveLength(2)

    const [single, multi] = selects
    expect(single?.min_values).toBe(1)
    expect(single?.max_values).toBe(1)
    expect(multi?.min_values).toBe(1)
    // two offered labels plus the trailing "Other…" custom affordance
    expect(multi?.max_values).toBe(3)

    const options = single?.options ?? []
    expect(options.map(option => option.label)).toEqual(['Postgres', 'SQLite', expect.stringMatching(/^Other/u)])
    expect(options.slice(0, 2).map(option => option.value)).toEqual(['Postgres', 'SQLite'])
  })

  it('carries option descriptions into the select options', () => {
    const { registry } = setup()
    const view = renderQuestionControls({
      registry,
      batch: batch({
        questions: [{
          id: 'q1',
          question: 'Deploy?',
          options: [{ label: 'Now', description: 'minutes from now' }],
          multiSelect: false,
        }],
      }),
    })

    const select = view.components.flatMap(row => row.components).find((component): component is QuestionSelectComponent => component.type === 3)
    expect(select?.options).toHaveLength(2)
    const [now, other] = select?.options ?? []
    expect(now).toEqual({ label: 'Now', value: 'Now', description: 'minutes from now' })
    expect(other?.value).toBe('__custom__')
    expect(other?.label.startsWith('Other')).toBe(true)
  })

  it('keeps rpc, session, request, and question data out of the custom_ids', () => {
    const { registry } = setup()
    const view = renderQuestionControls({ registry, batch: batch() })

    for (const component of view.components.flatMap(row => row.components)) {
      expect(component.custom_id).toMatch(/^dc:[A-Za-z0-9-]+$/u)
      expect(component.custom_id).not.toContain('MARKER')
      expect(component.custom_id).not.toContain('Postgres')
    }
  })

  it('round-trips the select through the registry to the question identity', () => {
    const { registry } = setup()
    const view = renderQuestionControls({ registry, batch: batch() })

    const firstSelect = view.components[0]?.components[0]
    const resolution = registry.resolve(firstSelect?.custom_id ?? '', 0)
    expect(resolution).toEqual({
      found: true,
      context: { questionRpcId: 'qrpc-MARKER-rpc', action: 'select', questionId: 'q1', expiresAtMs: 60_000 },
    })
  })

  it('includes a Submit button when the row budget allows', () => {
    const { registry } = setup()
    const view = renderQuestionControls({ registry, batch: batch() })

    const buttons = view.components.flatMap(row => row.components).filter(component => component.type === 2)
    expect(buttons.map(button => button.label)).toEqual(['Submit answers'])

    const submit = buttons[0]
    const resolution = registry.resolve(submit?.custom_id ?? '', 0)
    expect(resolution).toEqual({
      found: true,
      context: { questionRpcId: 'qrpc-MARKER-rpc', action: 'submit', expiresAtMs: 60_000 },
    })
  })

  it('omits the Submit button for a full five-question batch', () => {
    const { registry } = setup()
    const view = renderQuestionControls({
      registry,
      batch: batch({
        questions: Array.from({ length: 5 }, (_, index) => ({
          id: `q${String(index)}`,
          question: `Q${String(index)}`,
          options: [{ label: 'yes' }, { label: 'no' }],
          multiSelect: false,
        })),
      }),
    })

    const rows = view.components
    expect(rows).toHaveLength(5)
    expect(view.components.flatMap(row => row.components).filter(component => component.type === 2)).toHaveLength(0)
  })
})
