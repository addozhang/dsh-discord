/**
 * Uncertain prompt admission reconciliation (design.md §11 step 6, task
 * 15.5). An intent parked in `unknown` is resolved by evidence, never by
 * resubmission: a durable history entry whose `user/message.source.rpcId`
 * equals the submitted request ID proves DSH accepted the prompt, and the
 * live queue snapshot still holding the pending item proves it too. Without
 * evidence — or with probes that could not complete — the intent stays
 * unknown and the user's explicit retry mints a NEW intent, exactly as the
 * submission flow promises.
 */

export interface IntentEvidenceInput {
  messageId: string
  sessionId: string
  requestId: string
}

export type EvidenceProbe = (sessionId: string, requestId: string) => Promise<'present' | 'absent' | 'unknown'>

export interface IntentReconcileDeps {
  resolve(messageId: string, outcome: 'succeeded' | 'failed' | 'unknown', atMs: number): Promise<void>
  historyEvidence: EvidenceProbe
  queueEvidence: EvidenceProbe
  nowMs: () => number
}

export interface IntentReconcileInput {
  intents: readonly IntentEvidenceInput[]
  /** Bound per sweep; leftovers wait for the next one. */
  maxIntents: number
}

export interface IntentReconcileResult {
  proven: string[]
  unresolved: string[]
}

export async function reconcileIntents(deps: IntentReconcileDeps, input: IntentReconcileInput): Promise<IntentReconcileResult> {
  const proven: string[] = []
  const unresolved: string[] = []

  for (const intent of input.intents.slice(0, input.maxIntents)) {
    const inHistory = await deps.historyEvidence(intent.sessionId, intent.requestId)
    if (inHistory === 'present') {
      await deps.resolve(intent.messageId, 'succeeded', deps.nowMs())
      proven.push(intent.messageId)
      continue
    }

    const inQueue = await deps.queueEvidence(intent.sessionId, intent.requestId)
    if (inQueue === 'present') {
      await deps.resolve(intent.messageId, 'succeeded', deps.nowMs())
      proven.push(intent.messageId)
      continue
    }

    // Absent or unverifiable: leave the intent exactly as it is. No
    // resubmission — the user's explicit retry mints a new intent.
    unresolved.push(intent.messageId)
  }

  return { proven, unresolved }
}
