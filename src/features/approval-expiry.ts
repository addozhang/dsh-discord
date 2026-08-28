/**
 * Approval expiry sweep (design.md §8, task 13.4). An approval whose deadline
 * passes while still pending fails closed: the sweep claims it atomically —
 * losing to any concurrent click — submits `rejected` through the record's
 * rpcId, and marks the Discord controls expired only AFTER the outcome is
 * recorded. When DSH does not confirm the rejection, the record keeps an
 * explicit unresolved state and the controls stay live: nothing is claimed
 * as answered, and the user's own click remains the retry path (the sweep
 * never auto-retries).
 */

import type { DshApprovalRespondPort } from './approval-routing.js'
import type { ApprovalStore } from './approval-store.js'

/** Face that retires the rendered Allow once / Reject controls. */
export interface ExpiredControls {
  disable(approvalId: string): Promise<void>
}

export interface ApprovalExpiryDeps {
  store: ApprovalStore
  port: DshApprovalRespondPort
  controls: ExpiredControls
  nowMs: () => number
}

export interface ExpirySweepResult {
  /** Approval ids this sweep rejected and retired. */
  handled: string[]
}

export async function sweepExpiredApprovals(deps: ApprovalExpiryDeps): Promise<ExpirySweepResult> {
  const nowMs = deps.nowMs()
  const handled: string[] = []

  for (const record of deps.store.listPendingExpired(nowMs)) {
    // Atomic claim: a click that beat the sweep owns the answer instead.
    const claim = await deps.store.claim(record.approvalId)
    if (claim.outcome !== 'claimed') continue

    const submitted = await deps.port.respond({
      rpcId: record.rpcId,
      sessionId: record.sessionId,
      approvalId: record.approvalId,
      outcome: 'rejected',
    })

    if (submitted.outcome === 'confirmed') {
      await deps.store.markResolved(record.approvalId, 'rejected', deps.nowMs())
      // Controls expire only after the outcome is on the record.
      await deps.controls.disable(record.approvalId)
      handled.push(record.approvalId)
      continue
    }
    await deps.store.markUnresolved(record.approvalId, deps.nowMs())
    handled.push(record.approvalId)
  }

  return { handled }
}
