/**
 * Single-writable-Thread ownership tests (6.5). One DSH Session maps to at
 * most one writable Discord Thread: the owner record is a single record keyed
 * by session id, a second writable claim conflicts (never an implicit
 * takeover), the same thread re-claiming is idempotent (recovery), and only
 * the owning thread can release ownership.
 */

import { describe, expect, it } from 'vitest'

import { createKvTableStub } from './helpers/kv-table.js'
import { createSessionOwnerStore } from '../src/state/session-owners.js'

const SESSION = 'sess-1'
const THREAD_A = 'thread-a'
const THREAD_B = 'thread-b'

describe('session owner store', () => {
  it('claims an unowned session for a thread', async () => {
    const store = createSessionOwnerStore(createKvTableStub())
    const result = await store.claim({ sessionId: SESSION, threadId: THREAD_A, guildId: 'g', claimedAtMs: 10 })
    expect(result).toMatchObject({ outcome: 'claimed', record: { threadId: THREAD_A } })
  })

  it('conflicts a second writable thread without any implicit takeover', async () => {
    const store = createSessionOwnerStore(createKvTableStub())
    await store.claim({ sessionId: SESSION, threadId: THREAD_A, guildId: 'g', claimedAtMs: 10 })

    const second = await store.claim({ sessionId: SESSION, threadId: THREAD_B, guildId: 'g', claimedAtMs: 20 })
    expect(second).toMatchObject({ outcome: 'conflict', record: { threadId: THREAD_A } })
  })

  it('treats a re-claim by the owning thread as idempotent recovery', async () => {
    const store = createSessionOwnerStore(createKvTableStub())
    await store.claim({ sessionId: SESSION, threadId: THREAD_A, guildId: 'g', claimedAtMs: 10 })

    const replay = await store.claim({ sessionId: SESSION, threadId: THREAD_A, guildId: 'g', claimedAtMs: 20 })
    expect(replay.outcome).toBe('duplicate')
    if (replay.outcome === 'duplicate') {
      expect(replay.record.claimedAtMs).toBe(10)
    }
  })

  it('releases only for the owning thread and frees the session', async () => {
    const store = createSessionOwnerStore(createKvTableStub())
    await store.claim({ sessionId: SESSION, threadId: THREAD_A, guildId: 'g', claimedAtMs: 10 })

    const wrong = await store.release({ sessionId: SESSION, threadId: THREAD_B })
    expect(wrong).toEqual({ ok: false, error: 'not-owner' })
    expect(store.get(SESSION)?.threadId).toBe(THREAD_A)

    const released = await store.release({ sessionId: SESSION, threadId: THREAD_A })
    expect(released.ok).toBe(true)
    expect(store.get(SESSION)).toBeUndefined()

    const freed = await store.claim({ sessionId: SESSION, threadId: THREAD_B, guildId: 'g', claimedAtMs: 30 })
    expect(freed.outcome).toBe('claimed')
  })

  it('reports not-owner when releasing an unowned session', async () => {
    const store = createSessionOwnerStore(createKvTableStub())
    const result = await store.release({ sessionId: SESSION, threadId: THREAD_A })
    expect(result).toEqual({ ok: false, error: 'not-owner' })
  })

  it('serializes concurrent claims so exactly one thread wins', async () => {
    const store = createSessionOwnerStore(createKvTableStub())
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = store.claim({
      sessionId: SESSION,
      threadId: THREAD_A,
      guildId: 'g',
      claimedAtMs: 10,
      beforeClaim: () => firstGate,
    })
    const second = store.claim({ sessionId: SESSION, threadId: THREAD_B, guildId: 'g', claimedAtMs: 20 })

    releaseFirst()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.outcome).toBe('claimed')
    expect(secondResult.outcome).toBe('conflict')
  })
})
