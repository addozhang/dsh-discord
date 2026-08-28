/**
 * The per-thread render model (design.md §8, tasks 11.1 + 11.2). Each DSH
 * assistant message owns ONE logical Discord answer: preceding text deltas
 * coalesce into it, the authoritative `assistant/message` supersedes them, an
 * interruption keeps the visible prefix with a marker, and a later Step opens
 * another logical answer rather than overwriting an earlier one. Events for
 * unknown turns are dropped, never fatal — the reconciler owns recovery.
 */

export interface RenderAnswer {
  turnId: string
  stepId: string
  text: string
  authoritative: boolean
  interrupted: boolean
}

export interface RenderSnapshot {
  turnOpen: boolean
  turnId: string | undefined
  answers: RenderAnswer[]
}

export interface ThreadRenderModel {
  beginTurn(input: { turnId: string }): void
  endTurn(input: { turnId: string }): void
  beginStep(input: { turnId: string; stepId: string }): void
  appendDelta(input: { turnId: string; stepId: string; text: string }): void
  setAuthoritative(input: { turnId: string; stepId: string; text: string }): void
  interrupt(input: { turnId: string; stepId: string }): void
  snapshot(): RenderSnapshot
}

export function createThreadRenderModel(): ThreadRenderModel {
  let turnId: string | undefined
  let turnOpen = false
  const answers = new Map<string, RenderAnswer>()

  function answerKey(stepId: string): string {
    return `${turnId ?? ''}:${stepId}`
  }

  function ensureAnswer(stepId: string): RenderAnswer {
    const key = answerKey(stepId)
    let answer = answers.get(key)
    if (answer === undefined) {
      answer = { turnId: turnId ?? '', stepId, text: '', authoritative: false, interrupted: false }
      answers.set(key, answer)
    }
    return answer
  }

  return {
    beginTurn(input) {
      if (input.turnId === turnId && turnOpen) return
      turnId = input.turnId
      turnOpen = true
      // Answers belong to their turn: a new turn opens a fresh list.
      answers.clear()
    },
    endTurn(input) {
      if (input.turnId === turnId) turnOpen = false
    },
    beginStep(input) {
      if (input.turnId !== turnId) return
      ensureAnswer(input.stepId)
    },
    appendDelta(input) {
      if (input.turnId !== turnId) return
      const answer = ensureAnswer(input.stepId)
      if (answer.authoritative || answer.interrupted) return
      answer.text += input.text
    },
    setAuthoritative(input) {
      if (input.turnId !== turnId) return
      const answer = ensureAnswer(input.stepId)
      answer.text = input.text
      answer.authoritative = true
    },
    interrupt(input) {
      if (input.turnId !== turnId) return
      const answer = ensureAnswer(input.stepId)
      answer.interrupted = true
    },
    snapshot() {
      return { turnOpen, turnId, answers: [...answers.values()] }
    },
  }
}
