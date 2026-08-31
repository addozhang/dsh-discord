/**
 * `/model` tests (10.2 + 10.3 + 16.35): show reads the session's live model
 * directory; the selection mutation is restricted to the explicit global
 * Host-operator allowlist (Guild administrators are denied), validates the
 * provider, model, and reasoning effort against the live catalog before
 * calling DSH, and reports EXACTLY what DSH proved — the response proves the
 * session switch; the Host-default persistence attempt is never claimed as
 * an observed outcome.
 */

import { describe, expect, it, vi } from 'vitest'

import { applyModelSelection, showModels, type DshModelPort } from '../src/features/model-control.js'

const OPERATOR = { allowed: true, level: 'host-operator' } as const
const GUILD_ADMIN = { allowed: true, level: 'workspace-administrator' } as const

function makePort(overrides: {
  models?: DshModelPort['models']
  select?: DshModelPort['selectModel']
} = {}): DshModelPort {
  return {
    models: overrides.models ?? ((): ReturnType<DshModelPort['models']> =>
      Promise.resolve({
        outcome: 'completed',
        models: {
          current: { provider: 'deepseek', model: 'ds-v3' },
          routable: true,
          groups: [
            {
              id: 'deepseek',
              name: 'DeepSeek',
              models: [
                { id: 'ds-v3', name: 'V3', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'medium', name: 'Medium' }] } },
                { id: 'ds-r1', name: 'R1' },
              ],
            },
          ],
          failures: [],
        },
      })),
    selectModel: overrides.select ?? ((): ReturnType<DshModelPort['selectModel']> =>
      Promise.resolve({ outcome: 'completed', selected: { provider: 'deepseek', model: 'ds-v3' } })),
  }
}

describe('/model show', () => {
  it('returns the session directory for the router to render', async () => {
    const view = await showModels(makePort(), { sessionId: 'sess-1' })
    expect(view.outcome).toBe('completed')
    if (view.outcome === 'completed') {
      expect(view.models.current).toEqual({ provider: 'deepseek', model: 'ds-v3' })
      expect(view.models.groups[0]?.models).toHaveLength(2)
    }
  })

  it('passes through failed and unknown directory reads', async () => {
    expect((await showModels(makePort({ models: () => Promise.resolve({ outcome: 'failed' }) }), { sessionId: 's' })).outcome).toBe('failed')
    expect((await showModels(makePort({ models: () => Promise.resolve({ outcome: 'unknown' }) }), { sessionId: 's' })).outcome).toBe('unknown')
  })
})

describe('/model select (applyModelSelection)', () => {
  const request = {
    sessionId: 'sess-1',
    provider: 'deepseek',
    model: 'ds-v3',
  }

  it('denies a Guild administrator: only Host operators may switch', async () => {
    const result = await applyModelSelection(makePort(), { ...request, decision: GUILD_ADMIN })
    expect(result).toEqual({ outcome: 'refused', reason: 'not-host-operator' })
  })

  it('admits an authorized member when the operator restriction is dropped (16.42)', async () => {
    const result = await applyModelSelection(makePort(), {
      ...request,
      decision: { allowed: true, level: 'member' },
      requireHostOperator: false,
    })
    expect(result).toEqual({ outcome: 'applied', selected: { provider: 'deepseek', model: 'ds-v3' } })
  })

  it('still refuses a denied decision even with the restriction dropped', async () => {
    const result = await applyModelSelection(makePort(), {
      ...request,
      decision: { allowed: false, reason: 'denied' },
      requireHostOperator: false,
    })
    expect(result).toEqual({ outcome: 'refused', reason: 'not-host-operator' })
  })

  it('refuses an unknown provider or model before any DSH mutation', async () => {
    const select = vi.fn()
    const port = makePort({ select: select as unknown as DshModelPort['selectModel'] })
    expect(await applyModelSelection(port, { ...request, decision: OPERATOR, provider: 'nope' }))
      .toEqual({ outcome: 'refused', reason: 'model-not-in-catalog' })
    expect(await applyModelSelection(port, { ...request, decision: OPERATOR, model: 'nope' }))
      .toEqual({ outcome: 'refused', reason: 'model-not-in-catalog' })
    expect(select).not.toHaveBeenCalled()
  })

  it('refuses a reasoning effort the model does not advertise', async () => {
    const result = await applyModelSelection(makePort(), { ...request, decision: OPERATOR, reasoningEffort: 'max' })
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-reasoning-effort' })
  })

  it('applies a valid selection and forwards the reasoning effort', async () => {
    let seen: Parameters<DshModelPort['selectModel']>[0] | undefined
    const port = makePort({
      select: request0 => {
        seen = request0
        return Promise.resolve({ outcome: 'completed', selected: { provider: 'deepseek', model: 'ds-v3', reasoningEffort: 'medium' } })
      },
    })
    const result = await applyModelSelection(port, { ...request, decision: OPERATOR, reasoningEffort: 'medium' })
    expect(result).toEqual({
      outcome: 'applied',
      selected: { provider: 'deepseek', model: 'ds-v3', reasoningEffort: 'medium' },
    })
    expect(seen?.reasoningEffort).toBe('medium')
  })

  it('omits the reasoning field entirely when no effort is chosen', async () => {
    let seen: Record<string, unknown> | undefined
    const port = makePort({
      select: request0 => {
        seen = { ...request0 }
        return Promise.resolve({ outcome: 'completed', selected: { provider: 'deepseek', model: 'ds-v3' } })
      },
    })
    await applyModelSelection(port, { ...request, decision: OPERATOR })
    expect('reasoningEffort' in (seen ?? {})).toBe(false)
  })

  it('passes DSH rejections and unknown outcomes through unchanged', async () => {
    expect(await applyModelSelection(makePort({ select: () => Promise.resolve({ outcome: 'rejected', reason: 'agent-busy' }) }), { ...request, decision: OPERATOR }))
      .toEqual({ outcome: 'rejected', reason: 'agent-busy' })
    expect(await applyModelSelection(makePort({ select: () => Promise.resolve({ outcome: 'unknown' }) }), { ...request, decision: OPERATOR }))
      .toEqual({ outcome: 'unknown' })
  })
})
