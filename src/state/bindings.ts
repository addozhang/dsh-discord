/**
 * Revision-fenced bindings over one durable record each (design.md §10).
 * The store serializes claims per key with a process-local chain, then
 * re-checks the fence at the write slot — so an async writer that snapshotted
 * an older revision always loses to the live writer, and a failed claim never
 * partially mutates the record. Channel and thread bindings share this one
 * mechanism; only their record shapes differ.
 */

import type { ChannelBinding, ThreadBinding } from './records.js'

/** Minimal durable face the store needs (the domain's KvTable provides it). */
export interface BindingTable<V> {
  get(key: string): V | undefined
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
}

export type BindOutcome<V> =
  | { ok: true; binding: V }
  | { ok: false; error: 'already-bound' | 'stale-revision' | 'not-bound' }

export interface BindOptions {
  /** Fence: the caller's observed revision; undefined only for a fresh bind. */
  expectedRevision?: number | undefined
  /** Test/diagnostic hook run at the claim slot before the durable write. */
  beforeWrite?: () => Promise<void> | void
}

export interface BindingStore<V extends { revision: number }> {
  get(key: string): V | undefined
  bind(key: string, record: Omit<V, 'revision'>, options?: BindOptions): Promise<BindOutcome<V>>
  release(key: string, options: { expectedRevision: number }): Promise<BindOutcome<V>>
  /** Run one operation serialized behind this key's claim chain. */
  withKey<T>(key: string, op: () => Promise<T>): Promise<T>
}

const noBeforeWrite = (): void => {}

export function createBindingStore<V extends { revision: number }>(table: BindingTable<V>): BindingStore<V> {
  const chains = new Map<string, Promise<unknown>>()

  function enqueue<T>(key: string, op: () => Promise<T>): Promise<T> {
    const tail = chains.get(key) ?? Promise.resolve()
    const run = tail.then(op, op)
    // A failed claim never poisons later claims on the same key.
    chains.set(key, run.then(() => undefined, () => undefined))
    return run
  }

  async function bindAtSlot(key: string, record: Omit<V, 'revision'>, options: BindOptions): Promise<BindOutcome<V>> {
    const hook = options.beforeWrite ?? noBeforeWrite
    await Promise.resolve().then(hook)
    const current = table.get(key)

    if (options.expectedRevision === undefined) {
      if (current !== undefined) return { ok: false, error: 'already-bound' }
      const binding = { ...record, revision: 1 } as V
      await table.put(key, binding)
      return { ok: true, binding }
    }

    if (current === undefined || current.revision !== options.expectedRevision) {
      return { ok: false, error: 'stale-revision' }
    }
    const binding = { ...record, revision: options.expectedRevision + 1 } as V
    await table.put(key, binding)
    return { ok: true, binding }
  }

  return {
    get: key => table.get(key),
    bind(key, record, options = {}) {
      return enqueue(key, () => bindAtSlot(key, record, options))
    },
    release(key, { expectedRevision }) {
      return enqueue(key, async (): Promise<BindOutcome<V>> => {
        const current = table.get(key)
        if (current === undefined) return { ok: false, error: 'not-bound' }
        if (current.revision !== expectedRevision) return { ok: false, error: 'stale-revision' }
        await table.delete(key)
        return { ok: true, binding: current }
      })
    },
    withKey: (key, op) => enqueue(key, op),
  }
}

/** Convenience alias for the channel-binding table's store. */
export type ChannelBindingStore = BindingStore<ChannelBinding>

/** Convenience alias for the thread-binding table's store. */
export type ThreadBindingStore = BindingStore<ThreadBinding>
