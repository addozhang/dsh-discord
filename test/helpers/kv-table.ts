/**
 * Minimal in-memory KvTable stub matching the `@deepseek-ai/dsh-storage-domain`
 * `KvTable` contract closely enough for binding-store tests: synchronous
 * memory reads and per-table write serialization.
 */

import { vi } from 'vitest'

export interface KvTableStub<V> {
  get(key: string): V | undefined
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
}

export function createKvTableStub<V>(): KvTableStub<V> & { snapshot(): Map<string, V> } {
  const map = new Map<string, V>()
  return {
    get: key => map.get(key),
    put: (key, value) => {
      map.set(key, value)
      return Promise.resolve()
    },
    delete: key => Promise.resolve(map.delete(key)),
    snapshot: () => new Map(map),
  }
}

/** Convenience spy table for tests that need write observation. */
export function spiedTable<V>(table: KvTableStub<V>): KvTableStub<V> {
  return {
    get: key => table.get(key),
    put: vi.fn((key: string, value: V) => table.put(key, value)),
    delete: vi.fn((key: string) => table.delete(key)),
  }
}
