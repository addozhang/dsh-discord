/**
 * Revision-fenced binding tests (6.2). Each binding is one record whose
 * revision increments on every accepted write; claims serialize per key, a
 * write carrying an outdated revision is refused and leaves the record
 * untouched, and the stale async commit scenario — snapshot old revision,
 * another writer advances, stale writer commits — always loses.
 */

import { describe, expect, it } from 'vitest'

import { createKvTableStub } from './helpers/kv-table.js'
import { createBindingStore, renderWatermarkSeed } from '../src/state/bindings.js'
import type { ChannelBinding } from '../src/state/records.js'

const KEY = 'app:1:guild:2:channel:3'

function baseRecord(): Omit<ChannelBinding, 'revision'> {
  return { workspaceId: 'ws-1', boundBy: 'user-1', boundAtMs: 1_000 }
}

describe('revision-fenced bindings', () => {
  it('binds a fresh channel at revision 1 and reads it back', async () => {
    const store = createBindingStore<ChannelBinding>(createKvTableStub<ChannelBinding>())
    const result = await store.bind(KEY, baseRecord())
    expect(result).toMatchObject({ ok: true, binding: { workspaceId: 'ws-1', revision: 1 } })
    expect(store.get(KEY)?.revision).toBe(1)
  })

  it('rebinds with the current revision and increments it', async () => {
    const store = createBindingStore<ChannelBinding>(createKvTableStub<ChannelBinding>())
    const first = await store.bind(KEY, baseRecord())
    if (!first.ok) throw new Error('expected bind')

    const rebind = await store.bind(KEY, { ...baseRecord(), workspaceId: 'ws-2', boundAtMs: 2_000 }, {
      expectedRevision: first.binding.revision,
    })
    expect(rebind).toMatchObject({ ok: true, binding: { workspaceId: 'ws-2', revision: 2 } })
  })

  it('refuses an implicit overwrite of an existing binding', async () => {
    const store = createBindingStore<ChannelBinding>(createKvTableStub<ChannelBinding>())
    await store.bind(KEY, baseRecord())

    const second = await store.bind(KEY, baseRecord())
    expect(second).toEqual({ ok: false, error: 'already-bound' })
    expect(store.get(KEY)?.workspaceId).toBe('ws-1')
  })

  it('refuses a stale-revision commit and leaves the record untouched', async () => {
    const store = createBindingStore<ChannelBinding>(createKvTableStub<ChannelBinding>())
    await store.bind(KEY, baseRecord())
    const staleSnapshot = store.get(KEY)
    expect(staleSnapshot?.revision).toBe(1)

    await store.bind(KEY, { ...baseRecord(), workspaceId: 'ws-2' }, { expectedRevision: 1 })

    const stale = await store.bind(KEY, { ...baseRecord(), workspaceId: 'ws-3' }, {
      expectedRevision: staleSnapshot?.revision,
    })
    expect(stale).toEqual({ ok: false, error: 'stale-revision' })
    expect(store.get(KEY)?.workspaceId).toBe('ws-2')
    expect(store.get(KEY)?.revision).toBe(2)
  })

  it('refuses a stale commit that races the live writer (async commit loses)', async () => {
    const store = createBindingStore<ChannelBinding>(createKvTableStub<ChannelBinding>())
    const first = await store.bind(KEY, baseRecord())
    if (!first.ok) throw new Error('expected bind')

    let releaseWriter!: () => void
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve })

    const liveWriter = store.bind(KEY, { ...baseRecord(), workspaceId: 'ws-live' }, {
      expectedRevision: 1,
      beforeWrite: () => writerGate,
    })
    const staleWriter = store.bind(KEY, { ...baseRecord(), workspaceId: 'ws-stale' }, {
      expectedRevision: 1,
    })

    releaseWriter()
    const [liveResult, staleResult] = await Promise.all([liveWriter, staleWriter])
    expect(liveResult).toMatchObject({ ok: true, binding: { workspaceId: 'ws-live', revision: 2 } })
    expect(staleResult).toEqual({ ok: false, error: 'stale-revision' })
    expect(store.get(KEY)?.workspaceId).toBe('ws-live')
  })

  it('releases with the current revision and reports missing keys', async () => {
    const store = createBindingStore<ChannelBinding>(createKvTableStub<ChannelBinding>())
    const missing = await store.release(KEY, { expectedRevision: 1 })
    expect(missing).toEqual({ ok: false, error: 'not-bound' })

    const first = await store.bind(KEY, baseRecord())
    if (!first.ok) throw new Error('expected bind')

    const staleRelease = await store.release(KEY, { expectedRevision: 99 })
    expect(staleRelease).toEqual({ ok: false, error: 'stale-revision' })
    expect(store.get(KEY)).toBeDefined()

    const released = await store.release(KEY, { expectedRevision: 1 })
    expect(released.ok).toBe(true)
    expect(store.get(KEY)).toBeUndefined()
  })

  it('serializes claims per key: interleaved binds apply in enqueue order', async () => {
    const store = createBindingStore<ChannelBinding>(createKvTableStub<ChannelBinding>())
    const results = await Promise.all([
      store.bind(KEY, { ...baseRecord(), workspaceId: 'ws-a' }),
      store.bind(KEY, { ...baseRecord(), workspaceId: 'ws-b' }, { expectedRevision: 1 }),
      store.bind(KEY, { ...baseRecord(), workspaceId: 'ws-c' }, { expectedRevision: 2 }),
    ])
    expect(results.map(result => result.ok)).toEqual([true, true, true])
    expect(store.get(KEY)?.workspaceId).toBe('ws-c')
    expect(store.get(KEY)?.revision).toBe(3)
  })
})

describe('render watermark seeding (replay-fence-and-user-input)', () => {
  const base = { sessionId: 's1', workspaceId: 'ws1', revision: 1, createdBy: 'u1', createdAtMs: 1_000 }

  it('floors the watermark from a persisted renderedSeq', () => {
    expect(renderWatermarkSeed({ ...base, renderedSeq: 42 }, 5_000)).toEqual({ floor: 42 })
  })

  it('suppresses the first opening snapshot for pre-feature bindings from an earlier process', () => {
    expect(renderWatermarkSeed({ ...base }, 5_000)).toEqual({ suppressOpeningSnapshot: true })
  })

  it('seeds nothing for a binding created in-process (fresh resume thread renders full history)', () => {
    expect(renderWatermarkSeed({ ...base, createdAtMs: 6_000 }, 5_000)).toBeUndefined()
  })

  it('a persisted watermark wins even on legacy-looking timestamps', () => {
    expect(renderWatermarkSeed({ ...base, renderedSeq: 0 }, 5_000)).toEqual({ floor: 0 })
  })
})
