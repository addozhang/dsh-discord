/**
 * Inbound intent tests (6.3). The stable Discord message identity plus the
 * normalized payload hash are claimed atomically BEFORE any DSH call:
 * same-ID/same-hash replays reuse the record, same-ID/different-hash replays
 * conflict and fail closed, and concurrent claims of one message never open
 * two execution windows.
 */

import { describe, expect, it } from 'vitest'

import { createKvTableStub } from './helpers/kv-table.js'
import { createIntentStore, hashPayload } from '../src/state/intents.js'

const MESSAGE = '222222222222222222'
const HASH = 'hash-1'

function payload(extra: Record<string, unknown> = {}) {
  return { content: 'ship it', mentionedBot: true, ...extra }
}

describe('payload hashing', () => {
  it('is deterministic and key-order independent', async () => {
    const a = await hashPayload({ b: 1, a: [2, { z: 3, y: 4 }] })
    const b = await hashPayload({ a: [2, { y: 4, z: 3 }], b: 1 })
    expect(a).toBe(b)
  })

  it('separates different payloads', async () => {
    const a = await hashPayload(payload())
    const b = await hashPayload(payload({ content: 'different' }))
    expect(a).not.toBe(b)
  })
})

describe('intent store', () => {
  it('claims an unseen message', async () => {
    const store = createIntentStore(createKvTableStub())
    const result = await store.claim({ messageId: MESSAGE, contentHash: HASH, claimedAtMs: 100 })
    expect(result.outcome).toBe('claimed')
  })

  it('reports same-ID/same-hash replay as a duplicate of the original claim', async () => {
    const store = createIntentStore(createKvTableStub())
    await store.claim({ messageId: MESSAGE, contentHash: HASH, claimedAtMs: 100 })
    const replay = await store.claim({ messageId: MESSAGE, contentHash: HASH, claimedAtMs: 200 })
    expect(replay.outcome).toBe('duplicate')
    if (replay.outcome === 'duplicate') {
      expect(replay.record.claimedAtMs).toBe(100)
    }
  })

  it('fails same-ID/different-hash replay closed as a conflict', async () => {
    const store = createIntentStore(createKvTableStub())
    await store.claim({ messageId: MESSAGE, contentHash: HASH, claimedAtMs: 100 })
    const conflict = await store.claim({ messageId: MESSAGE, contentHash: 'hash-2', claimedAtMs: 200 })
    expect(conflict).toMatchObject({ outcome: 'conflict', record: { contentHash: HASH } })
    // The stored intent is untouched by the conflicting replay.
    expect(store.get(MESSAGE)?.claimedAtMs).toBe(100)
  })

  it('reuses the record even after a terminal outcome', async () => {
    const store = createIntentStore(createKvTableStub())
    await store.claim({ messageId: MESSAGE, contentHash: HASH, claimedAtMs: 100 })
    await store.resolve(MESSAGE, 'succeeded', 300)
    const replay = await store.claim({ messageId: MESSAGE, contentHash: HASH, claimedAtMs: 400 })
    expect(replay.outcome).toBe('duplicate')
    if (replay.outcome === 'duplicate') {
      expect(replay.record.state).toBe('succeeded')
    }
  })

  it('never opens two execution windows for one message under concurrency', async () => {
    const store = createIntentStore(createKvTableStub())
    let releaseSecond!: () => void
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })

    const firstClaim = store.claim({
      messageId: MESSAGE,
      contentHash: HASH,
      claimedAtMs: 100,
      beforeClaim: () => new Promise<void>((resolve) => {
        // Hold the first claim in-flight, then let it finish only after the
        // second claim has already been attempted: the second must observe
        // the serialized order, not interleave.
        setTimeout(resolve, 0)
        releaseSecond()
      }),
    })
    const secondClaim = store.claim({ messageId: MESSAGE, contentHash: HASH, claimedAtMs: 150 })

    const [first, second] = await Promise.all([firstClaim, secondClaim])
    expect(first.outcome).toBe('claimed')
    expect(second.outcome).toBe('duplicate')
    void secondGate
  })

  it('resolves outcomes without deleting the record', async () => {
    const store = createIntentStore(createKvTableStub())
    await store.claim({ messageId: MESSAGE, contentHash: HASH, claimedAtMs: 100 })
    await store.resolve(MESSAGE, 'unknown', 250)
    const record = store.get(MESSAGE)
    expect(record).toMatchObject({ state: 'unknown', resolvedAtMs: 250 })
    // Unknown outcomes are retained until explicit user resolution (6.6).
    expect(record?.state).toBe('unknown')
  })
})
