/**
 * Approval click routing (design.md §8, tasks 13.2/13.3). One pipeline per
 * component click: resolve the opaque custom_id, validate ownership, claim
 * the record atomically, submit exactly one DSH response, and settle the
 * record from what DSH actually confirmed. Losers of a race, stale controls,
 * and denials never reach DSH; an unconfirmed submit parks the approval in
 * an explicit unresolved state — it is never reported as answered.
 */

import type { ComponentRegistry } from '../discord/components.js'
import { authorizeApprovalClick, type ApprovalOutcome, type ApprovalStore } from './approval-store.js'

/** The DSH respond face: the answerable server-request echo (approvals.d.ts). */
export interface DshApprovalRespondPort {
  respond(input: {
    rpcId: string
    sessionId: string
    approvalId: string
    outcome: ApprovalOutcome
  }): Promise<
    | { outcome: 'confirmed' }
    | { outcome: 'rejected'; reason: string }
    | { outcome: 'unknown' }
  >
}

export interface ApprovalRoutingDeps {
  registry: ComponentRegistry
  store: ApprovalStore
  port: DshApprovalRespondPort
  nowMs: () => number
}

export interface ApprovalClickInput {
  customId: string
  userId: string
  threadId: string
}

export type ApprovalClickOutcome =
  | { outcome: 'submitted'; action: 'allow' | 'reject' }
  | { outcome: 'already-resolved' }
  | { outcome: 'denied' }
  | { outcome: 'unknown-control' }
  | { outcome: 'unresolved' }

/** Registry contexts carry only these two facts plus their expiry. */
function parseContext(context: Record<string, unknown>): { approvalId: string; action: 'allow' | 'reject' } | undefined {
  const approvalId = context['approvalId']
  const action = context['action']
  if (typeof approvalId !== 'string' || (action !== 'allow' && action !== 'reject')) return undefined
  return { approvalId, action }
}

export async function handleApprovalClick(
  deps: ApprovalRoutingDeps,
  click: ApprovalClickInput,
): Promise<ApprovalClickOutcome> {
  const resolution = deps.registry.resolve(click.customId, deps.nowMs())
  if (!resolution.found) return { outcome: 'unknown-control' }
  const context = parseContext(resolution.context)
  if (context === undefined) return { outcome: 'unknown-control' }

  const record = deps.store.get(context.approvalId)
  if (record === undefined) return { outcome: 'unknown-control' }

  const decision = authorizeApprovalClick(record, click)
  if (!decision.allowed) return { outcome: 'denied' }

  const claim = await deps.store.claim(context.approvalId)
  if (claim.outcome !== 'claimed') return { outcome: 'already-resolved' }

  const outcome: ApprovalOutcome = context.action === 'allow' ? 'allowed-once' : 'rejected'
  // A port that THROWS (distinct from an unknown outcome) is still an
  // unconfirmed submit: park unresolved so the expiry sweep and the user's
  // own retry stay available — never leave the approval in submitting.
  let submitted: Awaited<ReturnType<typeof deps.port.respond>>
  try {
    submitted = await deps.port.respond({
      rpcId: decision.respond.rpcId,
      sessionId: decision.respond.sessionId,
      approvalId: decision.respond.approvalId,
      outcome,
    })
  } catch {
    await deps.store.markUnresolved(context.approvalId, deps.nowMs())
    return { outcome: 'unresolved' }
  }

  if (submitted.outcome === 'confirmed') {
    await deps.store.markResolved(context.approvalId, outcome, deps.nowMs())
    return { outcome: 'submitted', action: context.action }
  }
  await deps.store.markUnresolved(context.approvalId, deps.nowMs())
  return { outcome: 'unresolved' }
}
