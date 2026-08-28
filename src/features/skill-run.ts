/**
 * `/skill run <skill> [input]` (design.md §13, task 10.4). Skill availability
 * comes from the DSH catalog; operator-only skills refuse ordinary members.
 * A passing check submits the CANONICAL slash invocation (`/<skill> <args>`)
 * through the queued session prompt — skills ride the same at-most-once
 * queue as ordinary thread messages, never a side channel.
 */

import type { AccessDecision } from '../policy/authorization.js'

export interface DshSkillPort {
  listSkills(): Promise<
    | { outcome: 'completed'; skills: ReadonlyArray<{ id: string; name: string; operatorOnly: boolean }> }
    | { outcome: 'failed' }
    | { outcome: 'unknown' }
  >
}

export interface SkillPromptSubmit {
  submit(request: { sessionId: string; requestId: string; prompt: string }): Promise<{ outcome: 'queued'; position: number }>
}

export type SkillRunResult =
  | { outcome: 'queued' }
  | { outcome: 'failed' }
  | { outcome: 'refused'; reason: 'skill-not-found' | 'operator-only-skill' | 'empty-skill' }

export async function runSkill(
  port: DshSkillPort,
  submit: SkillPromptSubmit,
  request: {
    decision: AccessDecision
    sessionId: string
    requestId: string
    /** Canonical skill id the user typed after /skill run. */
    skillInput: string
    args: readonly string[]
  },
): Promise<SkillRunResult> {
  const skillId = request.skillInput.trim()
  if (skillId === '') return { outcome: 'refused', reason: 'empty-skill' }

  const catalog = await port.listSkills()
  if (catalog.outcome !== 'completed') return { outcome: 'failed' }

  const skill = catalog.skills.find(candidate => candidate.id === skillId)
  if (skill === undefined) return { outcome: 'refused', reason: 'skill-not-found' }
  const isOperator = request.decision.allowed && request.decision.level === 'host-operator'
  if (skill.operatorOnly && !isOperator) {
    return { outcome: 'refused', reason: 'operator-only-skill' }
  }

  const canonical = `/${skillId}${request.args.length === 0 ? '' : ` ${request.args.join(' ')}`}`
  await submit.submit({ sessionId: request.sessionId, requestId: request.requestId, prompt: canonical })
  return { outcome: 'queued' }
}
