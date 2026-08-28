/**
 * `/model` tests (10.2 + 10.3): show reads the catalog; select is restricted
 * to the explicit global Host-operator allowlist (Guild administrators are
 * denied), validates the reasoning effort against the catalog before calling
 * DSH, and reports EXACTLY what DSH proved — including the partial case where
 * the session selection succeeded but the host-default persistence did not.
 */

import { describe, expect, it, vi } from 'vitest'

import { showModelCatalog, selectModel, type DshModelPort } from '../src/features/model-control.js'

const OPERATOR = { allowed: true, level: 'host-operator' } as const
const GUILD_ADMIN = { allowed: true, level: 'workspace-administrator' } as const

function catalogPort(select?: DshModelPort['selectModel']): DshModelPort {
  return {
    catalog: () => Promise.resolve({
      outcome: 'completed',
      providers: [
        { provider: 'deepseek', models: [{ id: 'ds-v3', reasonings: ['off', 'medium'] }, { id: 'ds-r1', reasonings: [] }] },
      ],
    }),
    selectModel: select ?? ((): ReturnType<DshModelPort['selectModel']> =>
      Promise.resolve({ outcome: 'completed', sessionApplied: true, defaultPersisted: true })),
  }
}

describe('/model show', () => {
  it('renders the provider/model catalog', async () => {
    const view = await showModelCatalog(catalogPort(), { sessionId: 'sess-1' })
    expect(view.outcome).toBe('ok')
    if (view.outcome !== 'ok') return
    expect(view.providers[0]?.models.map(model => model.id)).toEqual(['ds-v3', 'ds-r1'])
  })

  it('sanitizes catalog failures', async () => {
    const failed: DshModelPort = { catalog: () => Promise.resolve({ outcome: 'failed' }), selectModel: () => Promise.resolve({ outcome: 'unknown' }) }
    expect(await showModelCatalog(failed, { sessionId: 's' })).toEqual({ outcome: 'failed', reason: 'model-catalog-unavailable' })

    const unknown: DshModelPort = { catalog: () => Promise.resolve({ outcome: 'unknown' }), selectModel: () => Promise.resolve({ outcome: 'unknown' }) }
    expect(await showModelCatalog(unknown, { sessionId: 's' })).toEqual({ outcome: 'failed', reason: 'model-catalog-unknown' })
  })
})

describe('/model select authorization', () => {
  it('allows the host operator', async () => {
    const select = vi.fn((): ReturnType<DshModelPort['selectModel']> =>
      Promise.resolve({ outcome: 'completed', sessionApplied: true, defaultPersisted: true }))
    const result = await selectModel(catalogPort(select), {
      decision: OPERATOR,
      sessionId: 'sess-1',
      modelId: 'ds-v3',
      reasoning: 'medium',
    })
    expect(result.outcome).toBe('applied-with-host-default')
  })

  it('denies a guild-only administrator before any DSH call', async () => {
    const select = vi.fn((): ReturnType<DshModelPort['selectModel']> =>
      Promise.resolve({ outcome: 'completed', sessionApplied: true, defaultPersisted: true }))
    const result = await selectModel(catalogPort(select), {
      decision: GUILD_ADMIN,
      sessionId: 'sess-1',
      modelId: 'ds-v3',
    })
    expect(result).toEqual({ outcome: 'refused', reason: 'not-host-operator' })
    expect(select).not.toHaveBeenCalled()
  })

  it('rejects an unknown model without calling DSH', async () => {
    const select = vi.fn((): ReturnType<DshModelPort['selectModel']> =>
      Promise.resolve({ outcome: 'completed', sessionApplied: true, defaultPersisted: true }))
    const result = await selectModel(catalogPort(select), {
      decision: OPERATOR,
      sessionId: 'sess-1',
      modelId: 'nope',
    })
    expect(result).toEqual({ outcome: 'refused', reason: 'model-not-in-catalog' })
    expect(select).not.toHaveBeenCalled()
  })

  it('rejects an invalid reasoning effort without calling DSH', async () => {
    const select = vi.fn((): ReturnType<DshModelPort['selectModel']> =>
      Promise.resolve({ outcome: 'completed', sessionApplied: true, defaultPersisted: true }))
    const result = await selectModel(catalogPort(select), {
      decision: OPERATOR,
      sessionId: 'sess-1',
      modelId: 'ds-r1',
      reasoning: 'medium',
    })
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-reasoning-effort' })
    expect(select).not.toHaveBeenCalled()
  })
})

describe('/model select outcome presentation (10.3)', () => {
  it('presents the host-default side effect when both effects landed', async () => {
    const result = await selectModel(catalogPort(), {
      decision: OPERATOR, sessionId: 's', modelId: 'ds-v3',
    })
    expect(result).toEqual({
      outcome: 'applied-with-host-default',
      sessionApplied: true,
      defaultPersisted: true,
    })
  })

  it('reports the partial failure: session applied, default persistence did not', async () => {
    const result = await selectModel(catalogPort(() =>
      Promise.resolve({ outcome: 'completed', sessionApplied: true, defaultPersisted: false })), {
      decision: OPERATOR, sessionId: 's', modelId: 'ds-v3',
    })
    expect(result).toEqual({
      outcome: 'partial-session-only',
      sessionApplied: true,
      defaultPersisted: false,
    })
  })

  it('maps DSH rejection and unknown outcomes without claiming success', async () => {
    const rejected = catalogPort(() => Promise.resolve({ outcome: 'rejected', reason: 'model-unavailable' }))
    expect(await selectModel(rejected, { decision: OPERATOR, sessionId: 's', modelId: 'ds-v3' }))
      .toEqual({ outcome: 'rejected' })

    const unknown = catalogPort(() => Promise.resolve({ outcome: 'unknown' }))
    expect(await selectModel(unknown, { decision: OPERATOR, sessionId: 's', modelId: 'ds-v3' }))
      .toEqual({ outcome: 'unknown' })
  })
})
