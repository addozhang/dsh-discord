/**
 * Discord delivery reconciliation (design.md §11 step 7, task 15.6). An
 * outbound delivery parked in an unknown state is resolved by evidence: one
 * bounded GET against Discord — present proves delivery, a confirmed 404
 * proves failure — and an unreachable probe leaves the record unknown for a
 * later sweep. The reconciliation deps carry no send face: recovery never
 * resends, it only settles what already happened.
 */

export interface DeliveryLookupInput {
  deliveryId: string
  channelId: string
  messageId: string
}

export interface DeliveryReconcileDeps {
  resolve(deliveryId: string, outcome: 'succeeded' | 'failed' | 'unknown', atMs: number): Promise<void>
  messageProbe(channelId: string, messageId: string): Promise<'present' | 'missing' | 'unknown'>
  nowMs: () => number
}

export interface DeliveryReconcileInput {
  deliveries: readonly DeliveryLookupInput[]
  /** Bound per sweep; leftovers wait for the next one. */
  maxLookups: number
}

export interface DeliveryReconcileResult {
  delivered: string[]
  failed: string[]
  unresolved: string[]
}

export async function reconcileDeliveries(deps: DeliveryReconcileDeps, input: DeliveryReconcileInput): Promise<DeliveryReconcileResult> {
  const delivered: string[] = []
  const failed: string[] = []
  const unresolved: string[] = []

  for (const record of input.deliveries.slice(0, input.maxLookups)) {
    const probe = await deps.messageProbe(record.channelId, record.messageId)
    if (probe === 'present') {
      await deps.resolve(record.deliveryId, 'succeeded', deps.nowMs())
      delivered.push(record.deliveryId)
      continue
    }
    if (probe === 'missing') {
      await deps.resolve(record.deliveryId, 'failed', deps.nowMs())
      failed.push(record.deliveryId)
      continue
    }
    unresolved.push(record.deliveryId)
  }

  return { delivered, failed, unresolved }
}
