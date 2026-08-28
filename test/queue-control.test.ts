/**
 * Queue control tests (8.6): `/queue list` renders the session's pending
 * inbox snapshot in queue order, and `/queue remove` removes exactly one
 * pending item. Failures surface as sanitized values; an unknown removal
 * outcome is preserved for reconciliation rather than claimed as success.
 */

import { describe, expect, it, vi } from 'vitest'

import { listQueue, removeQueueItem, type DshQueuePort } from '../src/features/queue-control.js'

function port(snapshot: () => ReturnType<DshQueuePort['snapshot']>, remove?: DshQueuePort['remove']) {
  const snapshotFn = vi.fn((_request: { sessionId: string }): ReturnType<DshQueuePort['snapshot']> => snapshot())
  const removeFn = vi.fn((_request: { sessionId: string; itemId: string }): ReturnType<DshQueuePort['remove']> => (remove ? remove({ sessionId: _request.sessionId, itemId: _request.itemId }) : Promise.resolve({ outcome: 'completed', removed: true })))
  const queue: DshQueuePort = { snapshot: snapshotFn, remove: removeFn }
  return { queue, snapshotFn, removeFn }
}

describe('/queue list', () => {
  it('renders the snapshot in queue order with positions', async () => {
    const { queue, snapshotFn } = port(() => Promise.resolve({
      outcome: 'completed',
      items: [
        { itemId: 'q2', summary: 'second', requestedBy: 'discord:m-2' },
        { itemId: 'q1', summary: 'first', requestedBy: 'discord:m-1' },
      ],
    }))

    const view = await listQueue(queue, { sessionId: 'sess-1' })
    expect(view).toEqual({
      outcome: 'ok',
      items: [
        { itemId: 'q2', position: 1, summary: 'second' },
        { itemId: 'q1', position: 2, summary: 'first' },
      ],
    })
    expect(snapshotFn.mock.calls[0]?.[0]).toEqual({ sessionId: 'sess-1' })
  })

  it('renders an empty queue as a valid empty list', async () => {
    const { queue } = port(() => Promise.resolve({ outcome: 'completed', items: [] }))
    expect(await listQueue(queue, { sessionId: 's' })).toEqual({ outcome: 'ok', items: [] })
  })

  it('sanitizes snapshot failures', async () => {
    const rejected = port(() => Promise.resolve({ outcome: 'rejected', reason: 'session-not-found' }))
    expect(await listQueue(rejected.queue, { sessionId: 's' })).toEqual({ outcome: 'failed', reason: 'queue-unavailable' })

    const unknown = port(() => Promise.resolve({ outcome: 'unknown' }))
    expect(await listQueue(unknown.queue, { sessionId: 's' })).toEqual({ outcome: 'failed', reason: 'queue-unknown' })
  })
})

describe('/queue remove', () => {
  it('removes one owned pending item', async () => {
    const { queue, removeFn } = port(
      () => Promise.resolve({ outcome: 'completed', items: [] }),
      () => Promise.resolve({ outcome: 'completed', removed: true }),
    )
    const result = await removeQueueItem(queue, { sessionId: 'sess-1', itemId: 'q2' })
    expect(result).toEqual({ outcome: 'removed' })
    expect(removeFn.mock.calls[0]?.[0]).toEqual({ sessionId: 'sess-1', itemId: 'q2' })
  })

  it('reports an item that is already gone', async () => {
    const { queue } = port(
      () => Promise.resolve({ outcome: 'completed', items: [] }),
      () => Promise.resolve({ outcome: 'completed', removed: false }),
    )
    expect(await removeQueueItem(queue, { sessionId: 'sess-1', itemId: 'gone' }))
      .toEqual({ outcome: 'not-found' })
  })

  it('preserves unknown removal outcomes for reconciliation', async () => {
    const { queue } = port(
      () => Promise.resolve({ outcome: 'completed', items: [] }),
      () => Promise.resolve({ outcome: 'unknown' }),
    )
    expect(await removeQueueItem(queue, { sessionId: 'sess-1', itemId: 'q1' }))
      .toEqual({ outcome: 'unknown' })
  })

  it('sanitizes removal rejections', async () => {
    const { queue } = port(
      () => Promise.resolve({ outcome: 'completed', items: [] }),
      () => Promise.resolve({ outcome: 'rejected', reason: 'item-not-owned' }),
    )
    expect(await removeQueueItem(queue, { sessionId: 'sess-1', itemId: 'q1' }))
      .toEqual({ outcome: 'failed' })
  })
})
