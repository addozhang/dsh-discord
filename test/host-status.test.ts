/**
 * `/host status` tests (10.5): connectivity/version metadata only, sanitized
 * failures, and an ABSOLUTE refusal of process management — the embedded
 * adapter never starts, stops, restarts, or upgrades its own host.
 */

import { describe, expect, it, vi } from 'vitest'

import { hostStatus, planProcessAction, type DshHostPort } from '../src/features/host-status.js'

describe('/host status', () => {
  it('reports connectivity and version', async () => {
    const status = vi.fn((): ReturnType<DshHostPort['status']> =>
      Promise.resolve({ outcome: 'completed', connected: true, version: '0.1.1-rc.2' }))
    const view = await hostStatus({ status })
    expect(view).toEqual({ outcome: 'ok', connected: true, version: '0.1.1-rc.2' })
  })

  it('reports a disconnected host without inventing a version', async () => {
    const status = vi.fn((): ReturnType<DshHostPort['status']> =>
      Promise.resolve({ outcome: 'completed', connected: false, version: undefined }))
    expect(await hostStatus({ status })).toEqual({ outcome: 'ok', connected: false, version: undefined })
  })

  it('sanitizes failures', async () => {
    const failed: DshHostPort = { status: () => Promise.resolve({ outcome: 'failed' }) }
    expect(await hostStatus(failed)).toEqual({ outcome: 'failed', reason: 'host-status-unavailable' })

    const unknown: DshHostPort = { status: () => Promise.resolve({ outcome: 'unknown' }) }
    expect(await hostStatus(unknown)).toEqual({ outcome: 'failed', reason: 'host-status-unknown' })
  })
})

describe('process management refusal', () => {
  it('refuses every host process action with an explanation', async () => {
    for (const action of ['restart', 'stop', 'upgrade', 'start'] as const) {
      const result = await planProcessAction({ action })
      expect(result).toEqual({
        outcome: 'refused',
        reason: 'process-management-unavailable',
        response: 'ephemeral',
      })
    }
  })

  it('never invokes a process surface to refuse', async () => {
    const processControl = vi.fn()
    const result = await planProcessAction({ action: 'restart' }, { processControl })
    expect(result.outcome).toBe('refused')
    expect(processControl).not.toHaveBeenCalled()
  })
})
