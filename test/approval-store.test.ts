/**
 * Approval ownership tests (13.2): every pending approval binds the owning
 * Session, Discord Thread, adapter-submitted request ID, DSH rpcId, approval
 * ID, and the originating Discord user of that Turn. Only that user may
 * answer in Milestone 1 — other members AND administrators are denied
 * ephemerally and the approval stays pending. The respond payload is built
 * only from the record, never from the wire.
 */

import { describe, expect, it } from 'vitest'

import type { ApprovalRecord } from '../src/features/approval-store.js'
import { authorizeApprovalClick, createApprovalStore } from '../src/features/approval-store.js'

function ownershipRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
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
    ...overrides,
  }
}

function memoryTable() {
  const rows = new Map<string, ApprovalRecord>()
  return {
    get: (key: string) => rows.get(key),
    put: (key: string, record: ApprovalRecord) => {
      rows.set(key, record)
      return Promise.resolve()
    },
  }
}

describe('approval ownership', () => {
  it('binds session, thread, request, rpc, approval, and originating user on one record', () => {
    const store = createApprovalStore(memoryTable())
    const record = ownershipRecord()
    store.open(record)

    expect(store.get('appr-1')).toEqual(record)
  })

  it('authorizes the originating user on the owning thread and exposes the record-bound respond data', () => {
    const decision = authorizeApprovalClick(ownershipRecord(), { userId: 'user-owner', threadId: 'thread-1' })

    expect(decision).toEqual({
      allowed: true,
      respond: { rpcId: 'rpc-1', sessionId: 'sess-1', approvalId: 'appr-1' },
      requestId: 'req-1',
    })
  })

  it('denies another member on the same thread and leaves the approval pending', () => {
    const store = createApprovalStore(memoryTable())
    const record = ownershipRecord()
    store.open(record)

    const decision = authorizeApprovalClick(record, { userId: 'user-other', threadId: 'thread-1' })
    expect(decision).toEqual({ allowed: false, reason: 'not-owner' })
    expect(store.get('appr-1')?.state).toBe('pending')
  })

  it('denies an administrator acting for the originating user', () => {
    const decision = authorizeApprovalClick(ownershipRecord(), {
      userId: 'user-admin',
      threadId: 'thread-1',
      isAdministrator: true,
    })
    expect(decision).toEqual({ allowed: false, reason: 'not-owner' })
  })

  it('denies the originating user clicking from an unrelated thread', () => {
    const decision = authorizeApprovalClick(ownershipRecord(), { userId: 'user-owner', threadId: 'thread-other' })
    expect(decision).toEqual({ allowed: false, reason: 'not-owner' })
  })

  it('keeps one record per approval id when the host replays the request', () => {
    const store = createApprovalStore(memoryTable())
    store.open(ownershipRecord())
    store.open(ownershipRecord({ rpcId: 'rpc-replayed' }))

    expect(store.get('appr-1')?.rpcId).toBe('rpc-1')
  })
})

describe('atomic approval claim (13.3)', () => {
  it('claims a pending approval exactly once under concurrency', async () => {
    const store = createApprovalStore(memoryTable())
    store.open(ownershipRecord())

    const [first, second] = await Promise.all([store.claim('appr-1'), store.claim('appr-1')])

    expect(first.outcome).toBe('claimed')
    expect(second).toMatchObject({ outcome: 'not-claimable', record: { state: 'submitting' } })
    expect(store.get('appr-1')?.state).toBe('submitting')
  })

  it('never re-claims a resolved approval', async () => {
    const store = createApprovalStore(memoryTable())
    store.open(ownershipRecord())
    await store.claim('appr-1')
    await store.markResolved('appr-1', 'allowed-once', 10)

    await expect(store.claim('appr-1')).resolves.toMatchObject({
      outcome: 'not-claimable',
      record: { state: 'resolved', resolvedOutcome: 'allowed-once' },
    })
  })

  it('reports unknown for a claim on an untracked approval id', async () => {
    const store = createApprovalStore(memoryTable())
    await expect(store.claim('missing')).resolves.toEqual({ outcome: 'unknown' })
  })
})
