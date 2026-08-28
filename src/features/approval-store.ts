/**
 * Pending approval records and ownership validation (design.md §6/§8, tasks
 * 13.2/13.3). One record binds every ownership fact — Session, Discord
 * Thread, the owning adapter-submitted request ID, the DSH rpcId, the
 * approval ID, and the originating Discord user — and is the ONLY source of
 * respond data: the wire carries an opaque key, so nothing can be spoofed
 * through a click. Opening is idempotent per approval ID (the mux replays
 * still-pending requests on reconnect), and Milestone 1 authorization is
 * exactly the originating user on the owning thread — administrators
 * included are denied.
 */

export type ApprovalState = 'pending' | 'submitting' | 'resolved' | 'unresolved'

export type ApprovalOutcome = 'allowed-once' | 'rejected'

export interface ApprovalRecord {
  approvalId: string
  sessionId: string
  /** The owning Discord thread; clicks from any other thread are denied. */
  threadId: string
  /** The owning adapter-submitted turn's durable request ID. */
  requestId: string
  /** The answerable server-request rpcId the response must echo. */
  rpcId: string
  /** The Discord user who submitted the owning turn. */
  actorUserId: string
  toolName: string
  reason?: string | undefined
  expiresAtMs: number
  state: ApprovalState
  resolvedOutcome?: ApprovalOutcome | undefined
  resolvedAtMs?: number | undefined
}

/** Minimal durable face (the domain's KvTable provides it). */
export interface ApprovalTable {
  get(approvalId: string): ApprovalRecord | undefined
  put(approvalId: string, record: ApprovalRecord): Promise<void>
}

export interface ApprovalStore {
  get(approvalId: string): ApprovalRecord | undefined
  /** Register a pending approval; a replay keeps the original record. */
  open(record: ApprovalRecord): void
  /**
   * Atomically claim the approval for submission: pending (or an explicit
   * user retry after unresolved) flips to submitting exactly once per
   * serialized key; submitting and resolved records never re-claim.
   */
  claim(approvalId: string): Promise<
    | { outcome: 'claimed'; record: ApprovalRecord }
    | { outcome: 'not-claimable'; record: ApprovalRecord }
    | { outcome: 'unknown' }
  >
  /** Record a DSH-confirmed outcome; terminal. */
  markResolved(approvalId: string, outcome: ApprovalOutcome, atMs: number): Promise<void>
  /** Retain the record in an explicit unresolved state when DSH is silent. */
  markUnresolved(approvalId: string, atMs: number): Promise<void>
  /** Pending records whose deadline has passed, for the expiry sweep (13.4). */
  listPendingExpired(atMs: number): ApprovalRecord[]
}

/** Per-key serialization: operations on one approval never interleave. */
function serialized<T>(chains: Map<string, Promise<unknown>>, key: string, op: () => Promise<T>): Promise<T> {
  const tail = chains.get(key) ?? Promise.resolve()
  const run = tail.then(op, op)
  chains.set(key, run.then(() => undefined, () => undefined))
  return run
}

/**
 * How long a terminal approval record lingers in the id index past its
 * deadline before listing prunes it — the resolved-interaction retention
 * semantics of design.md §10 (7 days), applied to the store's own index.
 */
const RESOLVED_INTERACTION_RETENTION_MS = 7 * 24 * 60 * 60_000

export function createApprovalStore(table: ApprovalTable): ApprovalStore {
  const chains = new Map<string, Promise<unknown>>()
  /** In-memory id index; enumeration reads through and prunes itself. */
  const knownIds = new Set<string>()

  function snapshot(): ApprovalRecord[] {
    const records: ApprovalRecord[] = []
    for (const approvalId of knownIds) {
      const record = table.get(approvalId)
      if (record === undefined) {
        knownIds.delete(approvalId)
        continue
      }
      records.push(record)
    }
    return records
  }

  function prunePastRetention(nowMs: number): void {
    for (const record of snapshot()) {
      const settled = record.state === 'resolved' || record.state === 'unresolved'
      if (settled && nowMs - record.expiresAtMs > RESOLVED_INTERACTION_RETENTION_MS) {
        knownIds.delete(record.approvalId)
      }
    }
  }

  function mutate(approvalId: string, change: (record: ApprovalRecord) => ApprovalRecord): Promise<ApprovalRecord | undefined> {
    return serialized(chains, approvalId, async () => {
      const existing = table.get(approvalId)
      if (existing === undefined) return undefined
      const next = change(existing)
      await table.put(approvalId, next)
      return next
    })
  }

  return {
    get: approvalId => table.get(approvalId),
    open(record) {
      const existing = table.get(record.approvalId)
      if (existing !== undefined) return
      knownIds.add(record.approvalId)
      void table.put(record.approvalId, record)
    },
    claim(approvalId) {
      return serialized(chains, approvalId, async () => {
        const existing = table.get(approvalId)
        if (existing === undefined) return { outcome: 'unknown' as const }
        // An unresolved record still demands an answer; a fresh explicit
        // click is that answer. Everything else is settled or in flight.
        const claimable = existing.state === 'pending' || existing.state === 'unresolved'
        if (!claimable) return { outcome: 'not-claimable' as const, record: existing }
        const claimed: ApprovalRecord = { ...existing, state: 'submitting' }
        await table.put(approvalId, claimed)
        return { outcome: 'claimed' as const, record: claimed }
      })
    },
    markResolved(approvalId, outcome, atMs) {
      return mutate(approvalId, record => ({
        ...record,
        state: 'resolved',
        resolvedOutcome: outcome,
        resolvedAtMs: atMs,
      })).then(() => undefined)
    },
    markUnresolved(approvalId, atMs) {
      return mutate(approvalId, record => ({ ...record, state: 'unresolved', resolvedAtMs: atMs }))
        .then(() => undefined)
    },
    listPendingExpired(atMs) {
      prunePastRetention(atMs)
      const expired: ApprovalRecord[] = []
      for (const record of snapshot()) {
        if (record.state === 'pending' && atMs >= record.expiresAtMs) expired.push(record)
      }
      return expired
    },
  }
}

export interface ApprovalClick {
  userId: string
  threadId: string
  /** Present for context only: administrators hold no approval privilege. */
  isAdministrator?: boolean | undefined
}

export type ApprovalDecision =
  | {
      allowed: true
      /** Respond data built solely from the record, for apiProxy.respond. */
      respond: { rpcId: string; sessionId: string; approvalId: string }
      requestId: string
    }
  | { allowed: false; reason: 'not-owner' }

/**
 * Milestone 1 approval authorization: the originating user on the owning
 * thread, point. Administrative or moderator standing grants nothing.
 */
export function authorizeApprovalClick(record: ApprovalRecord, click: ApprovalClick): ApprovalDecision {
  if (click.userId !== record.actorUserId || click.threadId !== record.threadId) {
    return { allowed: false, reason: 'not-owner' }
  }
  return {
    allowed: true,
    respond: { rpcId: record.rpcId, sessionId: record.sessionId, approvalId: record.approvalId },
    requestId: record.requestId,
  }
}
