/**
 * `/queue list` and `/queue remove <item>` (design.md §13, task 8.6). The
 * list renders the session's pending inbox in queue order with stable
 * positions; removal targets exactly one item. Every DSH outcome maps to a
 * value, and unknown removal outcomes stay unknown — reconciliation, not
 * optimism, decides whether the item is really gone.
 */

export interface DshQueuePort {
  snapshot(request: { sessionId: string }): Promise<
    | { outcome: 'completed'; items: Array<{ itemId: string; summary: string; requestedBy: string }> }
    | { outcome: 'rejected'; reason: string }
    | { outcome: 'unknown' }
  >
  remove(request: { sessionId: string; itemId: string }): Promise<
    | { outcome: 'completed'; removed: boolean }
    | { outcome: 'rejected'; reason: string }
    | { outcome: 'unknown' }
  >
}

export type QueueListView =
  | { outcome: 'ok'; items: Array<{ itemId: string; position: number; summary: string }> }
  | { outcome: 'failed'; reason: 'queue-unavailable' | 'queue-unknown' }

export async function listQueue(queue: DshQueuePort, request: { sessionId: string }): Promise<QueueListView> {
  const snapshot = await queue.snapshot({ sessionId: request.sessionId })
  if (snapshot.outcome === 'rejected') return { outcome: 'failed', reason: 'queue-unavailable' }
  if (snapshot.outcome === 'unknown') return { outcome: 'failed', reason: 'queue-unknown' }
  return {
    outcome: 'ok',
    items: snapshot.items.map((item, index) => ({
      itemId: item.itemId,
      position: index + 1,
      summary: item.summary,
    })),
  }
}

export type QueueRemoveResult =
  | { outcome: 'removed' }
  | { outcome: 'not-found' }
  | { outcome: 'failed' }
  | { outcome: 'unknown' }

export async function removeQueueItem(
  queue: DshQueuePort,
  request: { sessionId: string; itemId: string },
): Promise<QueueRemoveResult> {
  const removed = await queue.remove({ sessionId: request.sessionId, itemId: request.itemId })
  if (removed.outcome === 'completed') {
    return removed.removed ? { outcome: 'removed' } : { outcome: 'not-found' }
  }
  if (removed.outcome === 'unknown') return { outcome: 'unknown' }
  return { outcome: 'failed' }
}
