/**
 * Approval click routing tests (13.3): a click resolves through the opaque
 * registry, validates ownership, claims the pending approval atomically, and
 * submits exactly one DSH response. Concurrent clicks and stale controls are
 * idempotent — only one answer ever reaches DSH — and an unconfirmed submit
 * parks the record in an explicit unresolved state instead of claiming
 * success.
 */

import { describe, expect, it, vi } from 'vitest'

import { createComponentRegistry, type ComponentRegistry } from '../src/discord/components.js'
import type { ApprovalRecord } from '../src/features/approval-store.js'
import { createApprovalStore, type ApprovalTable } from '../src/features/approval-store.js'
import { handleApprovalClick, type DshApprovalRespondPort } from '../src/features/approval-routing.js'

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
  let n = 0
  const registry: ComponentRegistry = createComponentRegistry({ idFactory: () => {
    n += 1
    return `opaque-${String(n)}`
  } })
  const store = createApprovalStore(memoryTable())
  const respond = vi.fn((_input: Parameters<DshApprovalRespondPort['respond']>[0]): ReturnType<DshApprovalRespondPort['respond']> =>
    Promise.resolve({ outcome: 'confirmed' }))
  const port: DshApprovalRespondPort = { respond }
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

  const allowId = registry.register({ approvalId: 'appr-1', action: 'allow', expiresAtMs: 1_000 })
  const rejectId = registry.register({ approvalId: 'appr-1', action: 'reject', expiresAtMs: 1_000 })

  const click = (customId: string, over: { userId?: string; threadId?: string } = {}) => handleApprovalClick(
    { registry, store, port, nowMs: () => 0 },
    { customId, userId: over.userId ?? 'user-owner', threadId: over.threadId ?? 'thread-1' },
  )

  return { registry, store, respond, port, record, allowId, rejectId, click }
}

describe('approval click routing', () => {
  it('submits allowed-once from the record and resolves it', async () => {
    const { click, respond, store } = setup()

    await expect(click('dc:opaque-1')).resolves.toEqual({ outcome: 'submitted', action: 'allow' })
    expect(respond).toHaveBeenCalledWith({ rpcId: 'rpc-1', sessionId: 'sess-1', approvalId: 'appr-1', outcome: 'allowed-once' })
    expect(store.get('appr-1')).toEqual(expect.objectContaining({ state: 'resolved', resolvedOutcome: 'allowed-once' }))
  })

  it('submits rejected for the Reject control', async () => {
    const { click, respond } = setup()

    await expect(click('dc:opaque-2')).resolves.toEqual({ outcome: 'submitted', action: 'reject' })
    expect(respond.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ outcome: 'rejected' }))
  })

  it('answers a concurrent double click once and already-resolved for the loser', async () => {
    const { click, respond } = setup()

    const [first, second] = await Promise.all([click('dc:opaque-1'), click('dc:opaque-1')])

    expect(respond).toHaveBeenCalledTimes(1)
    expect([first, second].map(result => result.outcome).sort()).toEqual(['already-resolved', 'submitted'])
  })

  it('handles a stale click on an already-resolved control idempotently', async () => {
    const { click, respond } = setup()
    await click('dc:opaque-1')

    await expect(click('dc:opaque-1')).resolves.toEqual({ outcome: 'already-resolved' })
    expect(respond).toHaveBeenCalledTimes(1)
  })

  it('answers an unknown or expired control without touching DSH', async () => {
    const { click, respond, store } = setup()

    await expect(click('dc:missing')).resolves.toEqual({ outcome: 'unknown-control' })
    expect(respond).not.toHaveBeenCalled()
    expect(store.get('appr-1')?.state).toBe('pending')
  })

  it('denies a non-owner before claiming and leaves the control pending', async () => {
    const { click, respond, store } = setup()

    await expect(click('dc:opaque-1', { userId: 'user-other' })).resolves.toEqual({ outcome: 'denied' })
    expect(respond).not.toHaveBeenCalled()
    expect(store.get('appr-1')?.state).toBe('pending')
  })

  it('records an explicit unresolved state when DSH does not confirm', async () => {
    const { click, respond, store } = setup()
    respond.mockReturnValueOnce(Promise.resolve({ outcome: 'unknown' }))

    await expect(click('dc:opaque-1')).resolves.toEqual({ outcome: 'unresolved' })
    expect(store.get('appr-1')?.state).toBe('unresolved')
    expect(respond).toHaveBeenCalledTimes(1)
  })

  it('parks unresolved when the respond port throws, keeping the retry available', async () => {
    const { click, respond, store } = setup()
    respond.mockImplementationOnce(() => Promise.reject(new Error('port blew up')))

    await expect(click('dc:opaque-1')).resolves.toEqual({ outcome: 'unresolved' })
    expect(store.get('appr-1')?.state).toBe('unresolved')

    // The explicit retry path stays open once the port recovers.
    await expect(click('dc:opaque-1')).resolves.toEqual({ outcome: 'submitted', action: 'allow' })
    expect(store.get('appr-1')?.state).toBe('resolved')
  })

  it('lets an explicit retry re-submit after an unresolved outcome', async () => {
    const { click, respond } = setup()
    respond.mockReturnValueOnce(Promise.resolve({ outcome: 'unknown' }))
    await click('dc:opaque-1')

    await expect(click('dc:opaque-1')).resolves.toEqual({ outcome: 'submitted', action: 'allow' })
    expect(respond).toHaveBeenCalledTimes(2)
  })
})
