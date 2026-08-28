/**
 * `/skill run` tests (10.4): the skill catalog gates availability —
 * operator-only skills refuse ordinary members — and a passing check submits
 * the CANONICAL slash invocation through the queued session prompt, never as
 * a separate DSH channel.
 */

import { describe, expect, it, vi } from 'vitest'

import { runSkill, type DshSkillPort } from '../src/features/skill-run.js'

const MEMBER = { allowed: true, level: 'member' } as const
const OPERATOR = { allowed: true, level: 'host-operator' } as const

function catalogPort(skills: Array<{ id: string; name: string; operatorOnly: boolean }>): DshSkillPort {
  return {
    listSkills: () => Promise.resolve({ outcome: 'completed', skills }),
  }
}

describe('/skill run', () => {
  it('queues the canonical slash invocation for an available skill', async () => {
    const submit = vi.fn((_request: { sessionId: string; requestId: string; prompt: string }): Promise<{ outcome: 'queued'; position: number }> =>
      Promise.resolve({ outcome: 'queued', position: 1 }))
    const result = await runSkill(
      catalogPort([{ id: 'review', name: 'Code Review', operatorOnly: false }]),
      { submit },
      {
        decision: MEMBER,
        sessionId: 'sess-1',
        requestId: 'm-1',
        skillInput: 'review',
        args: ['src/auth.ts'],
      },
    )
    expect(result).toMatchObject({ outcome: 'queued' })
    expect(submit.mock.calls[0]?.[0]).toEqual({
      sessionId: 'sess-1',
      requestId: 'm-1',
      prompt: '/review src/auth.ts',
    })
  })

  it('refuses an unknown skill before any prompt', async () => {
    const submit = vi.fn((_request: { sessionId: string; requestId: string; prompt: string }): Promise<{ outcome: 'queued'; position: number }> => Promise.resolve({ outcome: 'queued', position: 1 }))
    const result = await runSkill(
      catalogPort([]),
      { submit },
      { decision: MEMBER, sessionId: 's', requestId: 'm', skillInput: 'ghost', args: [] },
    )
    expect(result).toEqual({ outcome: 'refused', reason: 'skill-not-found' })
    expect(submit).not.toHaveBeenCalled()
  })

  it("refuses operator-only skills for members but allows operators", async () => {
    const submit = vi.fn((_request: { sessionId: string; requestId: string; prompt: string }): Promise<{ outcome: 'queued'; position: number }> => Promise.resolve({ outcome: 'queued', position: 1 }))
    const port = catalogPort([{ id: 'deploy', name: 'Deploy', operatorOnly: true }])

    const member = await runSkill(port, { submit }, { decision: MEMBER, sessionId: 's', requestId: 'm', skillInput: 'deploy', args: [] })
    expect(member).toEqual({ outcome: 'refused', reason: 'operator-only-skill' })

    const operator = await runSkill(port, { submit }, { decision: OPERATOR, sessionId: 's', requestId: 'm2', skillInput: 'deploy', args: [] })
    expect(operator.outcome).toBe('queued')
  })

  it('sanitizes an unavailable catalog', async () => {
    const failed: DshSkillPort = { listSkills: () => Promise.resolve({ outcome: 'failed' }) }
    const result = await runSkill(failed, { submit: vi.fn() }, { decision: MEMBER, sessionId: 's', requestId: 'm', skillInput: 'x', args: [] })
    expect(result).toEqual({ outcome: 'failed' })
  })

  it('rejects empty skill input without a prompt', async () => {
    const submit = vi.fn((_request: { sessionId: string; requestId: string; prompt: string }): Promise<{ outcome: 'queued'; position: number }> => Promise.resolve({ outcome: 'queued', position: 1 }))
    const result = await runSkill(
      catalogPort([{ id: 'review', name: 'Code Review', operatorOnly: false }]),
      { submit },
      { decision: MEMBER, sessionId: 's', requestId: 'm', skillInput: '  ', args: [] },
    )
    expect(result).toEqual({ outcome: 'refused', reason: 'empty-skill' })
    expect(submit).not.toHaveBeenCalled()
  })
})
