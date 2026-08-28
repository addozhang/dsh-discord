/**
 * Fail-closed integrity gate over a binding store (design.md §10). Storage
 * records are validated against the strict zod schema on every access:
 * malformed or NEWER-format records make the key read as corrupt, and every
 * Discord-triggered write refuses — the record is never replaced, repaired,
 * or emptied by the adapter. Backend durability failures surface as plain
 * values so callers can retry or alert without a crash crossing the dispatch
 * loop.
 */

import type { ZodType } from 'zod'
import type { BindOptions, BindingStore, BindOutcome } from './bindings.js'

export interface RawRecordAccess {
  /** Raw (unvalidated) record access for integrity diagnosis. */
  get(key: string): unknown
}

export type Diagnosis =
  | { state: 'missing' }
  | { state: 'ok' }
  | { state: 'corrupt'; issues: string[] }

export type FailClosedOutcome<V> =
  | BindOutcome<V>
  | { ok: false; error: 'state-corrupt' }
  | { ok: false; error: 'durable-write-failed'; cause: unknown }

export interface FailClosedBindingStore<V extends { revision: number }> {
  get(key: string): V | undefined
  diagnose(key: string): Diagnosis
  bind(key: string, record: Omit<V, 'revision'>, options?: BindOptions): Promise<FailClosedOutcome<V>>
  release(key: string, options: { expectedRevision: number }): Promise<FailClosedOutcome<V>>
}

export function createFailClosedBindingStore<V extends { revision: number }>(
  inner: BindingStore<V>,
  schema: ZodType<V>,
  raw: RawRecordAccess,
): FailClosedBindingStore<V> {
  function diagnose(key: string): Diagnosis {
    const record = raw.get(key)
    if (record === undefined || record === null) return { state: 'missing' }
    const parsed = schema.safeParse(record)
    if (parsed.success) return { state: 'ok' }
    return {
      state: 'corrupt',
      issues: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`),
    }
  }

  function guard(key: string): 'state-corrupt' | undefined {
    return diagnose(key).state === 'corrupt' ? 'state-corrupt' : undefined
  }

  async function durable<V2>(operation: () => Promise<V2>): Promise<V2 | FailClosedOutcome<never>> {
    try {
      return await operation()
    } catch (cause: unknown) {
      return { ok: false, error: 'durable-write-failed', cause }
    }
  }

  return {
    get(key) {
      // Read-path integrity: a corrupt or newer-format record never reaches
      // the business layer typed as a validated V. Callers that need the
      // reason ask `diagnose(key)` explicitly.
      if (guard(key) === 'state-corrupt') return undefined
      return inner.get(key)
    },
    diagnose,
    async bind(key, record, options) {
      if (guard(key) === 'state-corrupt') return { ok: false, error: 'state-corrupt' }
      const result = await durable(() => inner.bind(key, record, options))
      return result as FailClosedOutcome<V>
    },
    async release(key, options) {
      if (guard(key) === 'state-corrupt') return { ok: false, error: 'state-corrupt' }
      const result = await durable(() => inner.release(key, options))
      return result as FailClosedOutcome<V>
    },
  }
}
