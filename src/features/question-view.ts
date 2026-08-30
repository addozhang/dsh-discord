/**
 * Question control rendering (design.md §8, task 14.1). One pending ask()
 * batch renders as one string select per question — Discord's min/max values
 * carry the multi-select semantics — plus a Submit button when the five-row
 * budget allows (a full batch auto-submits when its last answer lands). Every
 * custom_id is an opaque registry key: rpc ids, question ids, session, and
 * labels never ride the Discord wire. Option values are the host's own
 * labels, validated against the batch before any answer is recorded.
 */

import type { ComponentRegistry } from '../discord/components.js'
import { DISCORD_SUPPRESS_NOTIFICATIONS_FLAG } from '../policy/disclosure.js'
import { suppressMentionSyntax } from '../policy/suppress.js'
import {
  MAX_CUSTOM_LENGTH,
  MAX_LABEL_LENGTH,
  type QuestionBatch,
  type QuestionItemView,
} from './question-store.js'

/** Discord interactive-component ids (action row = 1, button = 2, string select = 3). */
const ACTION_ROW = 1
const BUTTON = 2
const STRING_SELECT = 3
const BUTTON_STYLE_PRIMARY = 1

/** The reserved select value that routes a question to the custom-text modal. */
export const CUSTOM_ANSWER_VALUE = '__custom__'

export interface QuestionViewInput {
  registry: ComponentRegistry
  batch: QuestionBatch
}

export interface QuestionSelectComponent {
  type: typeof STRING_SELECT
  custom_id: string
  options: Array<{ label: string; value: string; description?: string | undefined }>
  min_values: number
  max_values: number
  placeholder?: string | undefined
}

export interface QuestionButtonComponent {
  type: typeof BUTTON
  style: typeof BUTTON_STYLE_PRIMARY
  label: string
  custom_id: string
}

export interface QuestionRow {
  type: typeof ACTION_ROW
  components: Array<QuestionSelectComponent | QuestionButtonComponent>
}

export interface QuestionViewPayload {
  content: string
  flags: typeof DISCORD_SUPPRESS_NOTIFICATIONS_FLAG
  components: QuestionRow[]
}

function boundedQuestionText(text: string): string {
  const neutralized = suppressMentionSyntax(text)
  return neutralized.length <= MAX_LABEL_LENGTH ? neutralized : `${neutralized.slice(0, MAX_LABEL_LENGTH)}…`
}

function selectFor(registry: ComponentRegistry, batch: QuestionBatch, question: QuestionItemView): QuestionSelectComponent {
  const options = (question.options ?? []).map(option => ({
    label: option.label,
    value: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  }))
  const customLabel = `Other — tell us in your own words`
  options.push({ label: customLabel, value: CUSTOM_ANSWER_VALUE })
  return {
    type: STRING_SELECT,
    custom_id: registry.register({
      questionRpcId: batch.questionRpcId,
      action: 'select',
      questionId: question.id,
      expiresAtMs: batch.expiresAtMs,
    }),
    options,
    min_values: 1,
    max_values: question.multiSelect ? Math.min(options.length, 25) : 1,
    ...(question.header === undefined ? {} : { placeholder: boundedQuestionText(question.header) }),
  }
}

/**
 * Render one pending question batch. Selects carry a trailing "Other…"
 * option (value `__custom__`) whose selection opens the custom-text modal —
 * see question-routing's modal flow. Registry contexts expose
 * `{ questionRpcId, action: 'select' | 'submit', questionId?, expiresAtMs }`.
 */
export function renderQuestionControls(input: QuestionViewInput): QuestionViewPayload {
  const { registry, batch } = input
  const rows: QuestionRow[] = batch.questions.map(question => ({
    type: ACTION_ROW,
    components: [selectFor(registry, batch, question)],
  }))

  if (batch.questions.length < 5) {
    rows.push({
      type: ACTION_ROW,
      components: [{
        type: BUTTON,
        style: BUTTON_STYLE_PRIMARY,
        label: 'Submit answers',
        custom_id: registry.register({
          questionRpcId: batch.questionRpcId,
          action: 'submit',
          expiresAtMs: batch.expiresAtMs,
        }),
      }],
    })
  }

  const header = batch.questions.length === 1
    ? boundedQuestionText(batch.questions[0]?.question ?? 'Questions')
    : `${String(batch.questions.length)} questions need answers`
  return {
    content: `${header} (answers stay editable until you submit; custom text up to ${String(MAX_CUSTOM_LENGTH)} characters)`,
    flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG,
    components: rows,
  }
}
