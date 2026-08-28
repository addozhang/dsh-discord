/**
 * Pending interaction reconciliation (design.md §9/§11 steps 3 and 10, task
 * 15.7). At startup each pending interaction is judged against the Host's
 * replayed pending baseline and generation. A replayed request keeps its
 * controls; a resolution observed from another client retires them; a Host
 * generation change with the interaction missing from the new baseline
 * expires them fail-closed — the adapter never claims an answer was applied.
 * The sweep accepts a disposal probe and stops touching anything the moment
 * it turns false.
 */

export interface InteractionRecord {
  rpcId: string
  kind: 'approval' | 'question'
  state: 'pending' | 'submitting' | 'resolved' | 'unresolved' | 'expired'
  /** The Host generation the interaction was created under. */
  seenGeneration: number
  /** Outcome observed from a `resolved` frame, if any. */
  remoteOutcome?: 'allowed-once' | 'rejected' | 'answered' | 'cancelled' | undefined
}

export interface InteractionFacts {
  hostGeneration: number
  /** rpcIds the Host still reports pending (the mux replay baseline). */
  pendingBaseline: ReadonlySet<string>
}

export type InteractionAction =
  | { rpcId: string; action: 'keep' }
  | { rpcId: string; action: 'retire'; reason: 'resolved-elsewhere'; outcome: InteractionRecord['remoteOutcome'] }
  | { rpcId: string; action: 'expire'; reason: 'host-generation-change' }

export interface InteractionPlan {
  actions: InteractionAction[]
}

/** Pure planning: given records and facts, decide each interaction's fate. */
export function planInteractionReconciliation(
  records: readonly InteractionRecord[],
  facts: InteractionFacts,
): InteractionPlan {
  const actions: InteractionAction[] = records.map((record) => {
    if (record.remoteOutcome !== undefined) {
      return { rpcId: record.rpcId, action: 'retire' as const, reason: 'resolved-elsewhere' as const, outcome: record.remoteOutcome }
    }
    const replayed = facts.pendingBaseline.has(record.rpcId)
    if (replayed && facts.hostGeneration === record.seenGeneration) {
      return { rpcId: record.rpcId, action: 'keep' as const }
    }
    if (facts.hostGeneration !== record.seenGeneration && !replayed) {
      return { rpcId: record.rpcId, action: 'expire' as const, reason: 'host-generation-change' as const }
    }
    return { rpcId: record.rpcId, action: 'retire' as const, reason: 'resolved-elsewhere' as const, outcome: undefined }
  })
  return { actions }
}

export interface InteractionReconcileDeps {
  /** Retires the rendered controls for one interaction. */
  disable(rpcId: string): Promise<void>
  /** Disposal probe: false stops the sweep between records. */
  shouldContinue?: () => boolean | undefined
}

export interface InteractionSweepResult {
  kept: string[]
  retired: string[]
  expired: string[]
  aborted: boolean
}

/**
 * Apply the plan: retire and expire disable the controls; keep leaves them
 * alone. The sweep stops between records the moment disposal wins.
 */
export async function sweepInteractionReconciliation(
  deps: InteractionReconcileDeps,
  records: readonly InteractionRecord[],
  facts: InteractionFacts,
): Promise<InteractionSweepResult> {
  const plan = planInteractionReconciliation(records, facts)
  const result: InteractionSweepResult = { kept: [], retired: [], expired: [], aborted: false }

  for (let index = 0; index < plan.actions.length; index += 1) {
    if (deps.shouldContinue?.() === false) {
      result.aborted = true
      return result
    }
    const action = plan.actions[index]
    if (action === undefined) continue
    if (action.action === 'keep') {
      result.kept.push(action.rpcId)
      continue
    }
    await deps.disable(action.rpcId)
    if (action.action === 'expire') result.expired.push(action.rpcId)
    else result.retired.push(action.rpcId)
  }

  return result
}
