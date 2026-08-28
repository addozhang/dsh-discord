/**
 * Fail-closed state integrity tests (6.7). Malformed or newer-format records
 * (zod-strict schemas reject unknown fields) make the affected key unusable:
 * reads report the corruption, and every Discord-triggered write refuses
 * WITHOUT replacing or repairing the record — repair is an explicit
 * administrative act. Backend durability failures surface as values, leaving
 * no partial state behind.
 */

import { describe, expect, it } from 'vitest'

import { createKvTableStub } from './helpers/kv-table.js'
import { createBindingStore } from '../src/state/bindings.js'
import { createFailClosedBindingStore } from '../src/state/fail-closed.js'
import type { ChannelBinding } from '../src/state/records.js'
import { ChannelBindingRecord } from '../src/state/records.js'

const KEY = 'app:1:guild:2:channel:3'

function baseRecord(): Omit<ChannelBinding, 'revision'> {
  return { workspaceId: 'ws-1', boundBy: 'user-1', boundAtMs: 1_000 }
}

function corruptTable(initial: Record<string, unknown>) {
  const table = createKvTableStub<ChannelBinding>()
  const raw = new Map<string, unknown>(Object.entries(initial))
  return {
    raw,
    get: (key: string) => raw.get(key) as ChannelBinding | undefined,
    put: (key: string, value: ChannelBinding) => {
      raw.set(key, value)
      return table.put(key, value)
    },
    delete: (key: string) => {
      raw.delete(key)
      return table.delete(key)
    },
  }
}

describe('fail-closed state integrity', () => {
  it('diagnoses missing, valid, and corrupt records', () => {
    const table = corruptTable({ [KEY]: { workspaceId: 'ws-1', revision: 1, boundBy: 'u', boundAtMs: 1 } })
    const inner = createBindingStore<ChannelBinding>(table)
    const store = createFailClosedBindingStore(inner, ChannelBindingRecord, table)

    expect(store.diagnose('missing-key')).toEqual({ state: 'missing' })
    expect(store.diagnose(KEY)).toEqual({ state: 'ok' })

    table.raw.set(KEY, { revision: 1 })
    const diagnosis = store.diagnose(KEY)
    expect(diagnosis.state).toBe('corrupt')
    if (diagnosis.state === 'corrupt') {
      expect(diagnosis.issues.length).toBeGreaterThan(0)
    }
  })

  it('refuses writes over a malformed record without replacing it', async () => {
    const malformed = { workspaceId: 'ws-x', boundBy: 'u', boundAtMs: 5 }
    const table = corruptTable({ [KEY]: malformed })
    const store = createFailClosedBindingStore(
      createBindingStore<ChannelBinding>(table),
      ChannelBindingRecord,
      table,
    )

    const bind = await store.bind(KEY, baseRecord(), { expectedRevision: 1 })
    expect(bind).toEqual({ ok: false, error: 'state-corrupt' })

    const release = await store.release(KEY, { expectedRevision: 1 })
    expect(release).toEqual({ ok: false, error: 'state-corrupt' })

    // The malformed record is untouched — never silently repaired or emptied.
    expect(table.raw.get(KEY)).toEqual(malformed)
  })

  it('treats newer-format records (unknown fields) as corrupt', async () => {
    const newer = { workspaceId: 'ws-1', revision: 2, boundBy: 'u', boundAtMs: 1, futureField: { v: 9 } }
    const table = corruptTable({ [KEY]: newer })
    const store = createFailClosedBindingStore(
      createBindingStore<ChannelBinding>(table),
      ChannelBindingRecord,
      table,
    )

    expect(store.diagnose(KEY).state).toBe('corrupt')
    const result = await store.bind(KEY, baseRecord(), { expectedRevision: 2 })
    expect(result).toEqual({ ok: false, error: 'state-corrupt' })
    expect(table.raw.get(KEY)).toEqual(newer)
  })

  it('lets healthy records flow through unchanged', async () => {
    const table = corruptTable({})
    const inner = createBindingStore<ChannelBinding>(table)
    const store = createFailClosedBindingStore(inner, ChannelBindingRecord, table)

    const bind = await store.bind(KEY, baseRecord())
    expect(bind).toMatchObject({ ok: true, binding: { revision: 1 } })
    const release = await store.release(KEY, { expectedRevision: 1 })
    expect(release.ok).toBe(true)
    expect(store.diagnose(KEY).state).toBe('missing')
  })

  it('surfaces backend write failures as values with no partial state', async () => {
    const table = createKvTableStub<ChannelBinding>()
    const failingTable = {
      get: (key: string) => table.get(key),
      put: () => Promise.reject(new Error('medium unplugged')),
      delete: () => Promise.reject(new Error('medium unplugged')),
    }
    const store = createFailClosedBindingStore(
      createBindingStore<ChannelBinding>(failingTable),
      ChannelBindingRecord,
      failingTable,
    )

    const bind = await store.bind(KEY, baseRecord())
    expect(bind).toMatchObject({ ok: false, error: 'durable-write-failed' })
    expect(table.get(KEY)).toBeUndefined()

    const seeded = await (async () => {
      // Seed a healthy record directly, then fail the delete.
      await table.put(KEY, { ...baseRecord(), revision: 1 })
      return store.release(KEY, { expectedRevision: 1 })
    })()
    expect(seeded).toMatchObject({ ok: false, error: 'durable-write-failed' })
    expect(table.get(KEY)?.revision).toBe(1)
  })
})
