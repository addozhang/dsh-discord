/**
 * Approval expiry tests (13.4): with a fake clock, an approval whose deadline
 * passes while still pending is atomically claimed and rejected at DSH, and
 * its Discord controls are marked expired only AFTER the outcome is recorded.
 * A failed rejection never expires the controls and never claims success —
 * the record stays in an explicit unresolved state for the user to retry.
 */

import { describe, expect, it, vi } from 'vitest'

import type { ApprovalRecord } from '../src/features/approval-store.js'
import { createApprovalStore, type ApprovalTable } from '../src/features/approval-store.js'
import type { DshApprovalRespondPort } from '../src/features/approval-routing.js'
import { sweepExpiredApprovals, type ExpiredControls } from '../src/features/approval-expiry.js'

function memoryTable(): ApprovalTable {
  const rows = new Map<string, ApprovalRecord>()
  return {
    get: key => rows.get(key),
    put: (key, record) => {
      rows.set(key, record)
      return Promise.resolve()
    },
  }
}

function setup() {
  const store = createApprovalStore(memoryTable())
  const calls: string[] = []
  const respond = vi.fn((_input: Parameters<DshApprovalRespondPort['respond']>[0]): ReturnType<DshApprovalRespondPort['respond']> => {
    calls.push('respond')
    return Promise.resolve({ outcome: 'confirmed' })
  })
  const port: DshApprovalRespondPort = { respond }
  const disable = vi.fn(() => {
    calls.push('disable')
    return Promise.resolve()
  })
  const controls: ExpiredControls = { disable }
  const record = {
    approvalId: 'appr-1',
    sessionId: 'sess-1',
    threadId: 'thread-1',
    requestId: 'req-1',
    rpcId: 'rpc-1',
    actorUserId: 'user-owner',
    toolName: 'bash',
    reason: undefined,
    expiresAtMs: 1_000,
    state: 'pending',
  } satisfies ApprovalRecord
  store.open(record)

  const sweep = (nowMs: number) => sweepExpiredApprovals({ store, port, controls, nowMs: () => nowMs })

  return { store, respond, disable, controls, calls, sweep }
}

describe('approval expiry sweep', () => {
  it('claims an expired pending approval, rejects it, then expires the controls in that order', async () => {
    const { respond, store, calls, sweep } = setup()

    const result = await sweep(1_500)

    expect(result.handled).toEqual(['appr-1'])
    expect(respond).toHaveBeenCalledWith({ rpcId: 'rpc-1', sessionId: 'sess-1', approvalId: 'appr-1', outcome: 'rejected' })
    expect(store.get('appr-1')).toEqual(expect.objectContaining({ state: 'resolved', resolvedOutcome: 'rejected' }))
    expect(calls).toEqual(['respond', 'disable'])
  })

  it('leaves approvals that are still within their deadline untouched', async () => {
    const { respond, disable, store, sweep } = setup()

    const result = await sweep(999)

    expect(result.handled).toEqual([])
    expect(respond).not.toHaveBeenCalled()
    expect(disable).not.toHaveBeenCalled()
    expect(store.get('appr-1')?.state).toBe('pending')
  })

  it('never races a click that already claimed the approval', async () => {
    const { store, respond, disable, sweep } = setup()
    await store.claim('appr-1')

    const result = await sweep(1_500)

    expect(result.handled).toEqual([])
    expect(respond).not.toHaveBeenCalled()
    expect(disable).not.toHaveBeenCalled()
  })

  it('retains an unresolved state without expiring controls when DSH does not confirm', async () => {
    const { respond, store, disable, sweep } = setup()
    respond.mockReturnValueOnce(Promise.resolve({ outcome: 'unknown' }))

    const result = await sweep(1_500)

    expect(result.handled).toEqual(['appr-1'])
    expect(store.get('appr-1')?.state).toBe('unresolved')
    expect(disable).not.toHaveBeenCalled()
  })

  it('does not auto-retry an unresolved approval on later sweeps', async () => {
    const { respond, sweep } = setup()
    respond.mockReturnValueOnce(Promise.resolve({ outcome: 'unknown' }))
    await sweep(1_500)

    const second = await sweep(2_500)

    expect(second.handled).toEqual([])
    expect(respond).toHaveBeenCalledTimes(1)
  })

  it('skips an expired approval that a user already resolved', async () => {
    const { store, respond, sweep } = setup()
    await store.claim('appr-1')
    await store.markResolved('appr-1', 'allowed-once', 1_100)

    const result = await sweep(1_500)

    expect(result.handled).toEqual([])
    expect(respond).not.toHaveBeenCalled()
  })
})
