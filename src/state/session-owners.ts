/**
 * The unique logical owner record for writable Session bindings (design.md
 * §6, §10). One record per session id — the record itself IS the ownership,
 * so uniqueness falls out of the key. Claims serialize per session; a second
 * writable thread conflicts without any implicit takeover, the owning thread
 * re-claiming is idempotent (crash/recovery), and only the owner can release.
 */

export interface SessionOwnerRecord {
  threadId: string
  guildId: string
  claimedAtMs: number
}

export interface SessionOwnerTable {
  get(sessionId: string): SessionOwnerRecord | undefined
  put(sessionId: string, record: SessionOwnerRecord): Promise<void>
  delete(sessionId: string): Promise<boolean>
}

export interface ClaimOwnershipRequest {
  sessionId: string
  threadId: string
  guildId: string
  claimedAtMs: number
  /** Test/diagnostic hook run inside the serialized claim slot. */
  beforeClaim?: () => Promise<void> | void
}

export type ClaimOwnershipOutcome =
  | { outcome: 'claimed'; record: SessionOwnerRecord }
  | { outcome: 'duplicate'; record: SessionOwnerRecord }
  | { outcome: 'conflict'; record: SessionOwnerRecord }

export type ReleaseOutcome =
  | { ok: true }
  | { ok: false; error: 'not-owner' }

export interface SessionOwnerStore {
  get(sessionId: string): SessionOwnerRecord | undefined
  claim(request: ClaimOwnershipRequest): Promise<ClaimOwnershipOutcome>
  release(request: { sessionId: string; threadId: string }): Promise<ReleaseOutcome>
}

const noBeforeClaim = (): void => {}

export function createSessionOwnerStore(table: SessionOwnerTable): SessionOwnerStore {
  const chains = new Map<string, Promise<unknown>>()

  function enqueue<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
    const tail = chains.get(sessionId) ?? Promise.resolve()
    const run = tail.then(op, op)
    chains.set(sessionId, run.then(() => undefined, () => undefined))
    return run
  }

  return {
    get: sessionId => table.get(sessionId),
    claim(request) {
      return enqueue(request.sessionId, async (): Promise<ClaimOwnershipOutcome> => {
        const hook = request.beforeClaim ?? noBeforeClaim
        await Promise.resolve().then(hook)
        const existing = table.get(request.sessionId)
        if (existing !== undefined) {
          const record: SessionOwnerRecord = existing
          return existing.threadId === request.threadId
            ? { outcome: 'duplicate', record }
            : { outcome: 'conflict', record }
        }
        const record: SessionOwnerRecord = {
          threadId: request.threadId,
          guildId: request.guildId,
          claimedAtMs: request.claimedAtMs,
        }
        await table.put(request.sessionId, record)
        return { outcome: 'claimed', record }
      })
    },
    release(request) {
      return enqueue(request.sessionId, async (): Promise<ReleaseOutcome> => {
        const existing = table.get(request.sessionId)
        if (existing === undefined || existing.threadId !== request.threadId) {
          return { ok: false, error: 'not-owner' }
        }
        await table.delete(request.sessionId)
        return { ok: true }
      })
    },
  }
}
