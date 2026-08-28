/**
 * Inbound intent records (design.md §10). The stable Discord message identity
 * plus the normalized payload hash are claimed atomically before any DSH
 * call, so every later delivery of the same message either reuses the record
 * (same-ID/same-hash) or fails closed (same-ID/different-hash — a tampered or
 * ambiguous replay). Unknown outcomes are recorded and retained, never
 * silently rewritten.
 */

import { createHash } from 'node:crypto'

/** Canonical JSON: recursively sorted keys, so hash equality is structural. */
function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableValue(item)).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** SHA-256 over the canonical JSON of the normalized payload. */
export function hashPayload(payload: unknown): Promise<string> {
  return Promise.resolve(createHash('sha256').update(stableValue(payload)).digest('hex'))
}

export type IntentState = 'claimed' | 'succeeded' | 'failed' | 'unknown'

export interface InboundIntentRecord {
  contentHash: string
  state: IntentState
  claimedAtMs: number
  resolvedAtMs?: number | undefined
}

export interface ClaimRequest {
  messageId: string
  contentHash: string
  claimedAtMs: number
  /** Test/diagnostic hook run inside the serialized claim slot. */
  beforeClaim?: () => Promise<void> | void
}

export type ClaimOutcome =
  | { outcome: 'claimed' }
  | { outcome: 'duplicate'; record: InboundIntentRecord }
  | { outcome: 'conflict'; record: InboundIntentRecord }

export type ResolveOutcome = 'succeeded' | 'failed' | 'unknown'

/** Minimal durable face (the domain's KvTable provides it). */
export interface IntentTable {
  get(messageId: string): InboundIntentRecord | undefined
  put(messageId: string, record: InboundIntentRecord): Promise<void>
}

export interface IntentStore {
  get(messageId: string): InboundIntentRecord | undefined
  claim(request: ClaimRequest): Promise<ClaimOutcome>
  resolve(messageId: string, outcome: ResolveOutcome, atMs: number): Promise<void>
}

const noBeforeClaim = (): void => {}

export function createIntentStore(table: IntentTable): IntentStore {
  const chains = new Map<string, Promise<unknown>>()

  function enqueue<T>(messageId: string, op: () => Promise<T>): Promise<T> {
    const tail = chains.get(messageId) ?? Promise.resolve()
    const run = tail.then(op, op)
    chains.set(messageId, run.then(() => undefined, () => undefined))
    return run
  }

  return {
    get: messageId => table.get(messageId),
    claim(request) {
      return enqueue(request.messageId, async (): Promise<ClaimOutcome> => {
        const hook = request.beforeClaim ?? noBeforeClaim
        await Promise.resolve().then(hook)
        const existing = table.get(request.messageId)
        if (existing !== undefined) {
          // Same identity, different content: refuse rather than guess.
          if (existing.contentHash !== request.contentHash) {
            return { outcome: 'conflict', record: existing }
          }
          return { outcome: 'duplicate', record: existing }
        }
        const record: InboundIntentRecord = {
          contentHash: request.contentHash,
          state: 'claimed',
          claimedAtMs: request.claimedAtMs,
        }
        await table.put(request.messageId, record)
        return { outcome: 'claimed' }
      })
    },
    resolve(messageId, outcome, atMs) {
      return enqueue(messageId, async () => {
        const existing = table.get(messageId)
        if (existing === undefined) return
        await table.put(messageId, { ...existing, state: outcome, resolvedAtMs: atMs })
      })
    },
  }
}
