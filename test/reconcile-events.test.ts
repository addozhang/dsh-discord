/**
 * History replay tests (15.3): after a reconnect, bounded history pages are
 * the durable recovery source (DSH 0.1.1-rc.2 ignores mux `since`). Events
 * past the committed watermark are delivered in ascending order exactly once,
 * duplicates of events already delivered live are skipped by id, and the
 * per-session watermark advances only after the delivery bookkeeping
 * resolves. Pages arrive newest-first from the port; replay folds them
 * oldest-first (15.4) under a strict page budget that surfaces incomplete
 * recovery instead of fetching forever.
 */

import { describe, expect, it, vi } from 'vitest'

import { replayHistory, type EventHistoryPort, type HistoryPage } from '../src/features/reconcile-events.js'

function page(events: Array<[number, string]>, hasMore = false): HistoryPage {
  return { events: events.map(([seq, id]) => ({ seq, id })), hasMore }
}

function setup(pages: HistoryPage[], watermark: number | undefined, liveSeen: ReadonlySet<string> = new Set()) {
  const queue = [...pages]
  const history = vi.fn((_sessionId: string, _beforeSeq: number | undefined): Promise<HistoryPage> =>
    Promise.resolve(queue.shift() ?? { events: [], hasMore: false }))
  const historyPort: EventHistoryPort = { history }
  const log: string[] = []
  const deliver = vi.fn((event: { seq: number; id: string }): Promise<'recorded' | 'duplicate'> => {
    log.push(`deliver:${event.id}`)
    return Promise.resolve(liveSeen.has(event.id) ? 'duplicate' : 'recorded')
  })
  const commits: number[] = []
  const watermarkStore = {
    watermark: (_sessionId: string) => watermark,
    commit: vi.fn((_sessionId: string, seq: number): Promise<void> => {
      log.push(`commit:${String(seq)}`)
      commits.push(seq)
      return Promise.resolve()
    }),
  }
  const deps = { historyPort, deliver: { deliver }, watermarkStore }
  return { deps, history, deliver, commits, log, watermarkStore }
}

describe('history replay', () => {
  it('replays the missed page past the committed watermark in ascending order', async () => {
    const { deps, commits } = setup(
      [page([[6, 'e6'], [7, 'e7'], [8, 'e8']])],
      5,
    )

    const result = await replayHistory(deps, { sessionId: 'sess-1' })

    expect(result.delivered).toEqual(['e6', 'e7', 'e8'])
    expect(result.committedThrough).toBe(8)
    expect(commits).toEqual([6, 7, 8])
    expect(result.incomplete).toBe(false)
  })

  it('skips duplicate live events by id but still advances the watermark', async () => {
    const { deps } = setup(
      [page([[6, 'e6'], [7, 'e7'], [8, 'e8']])],
      5,
      new Set(['e7']),
    )

    const result = await replayHistory(deps, { sessionId: 'sess-1', liveSeen: new Set(['e7']) })

    expect(result.delivered).toEqual(['e6', 'e8'])
    expect(result.committedThrough).toBe(8)
  })

  it('delivers nothing when the watermark already covers the history', async () => {
    const { deps, deliver } = setup(
      [page([[6, 'e6'], [7, 'e7'], [8, 'e8']])],
      8,
    )

    const result = await replayHistory(deps, { sessionId: 'sess-1' })

    expect(result.delivered).toEqual([])
    expect(result.committedThrough).toBeUndefined()
    expect(deliver).not.toHaveBeenCalled()
  })

  it('commits the watermark only after the delivery bookkeeping resolves', async () => {
    const { watermarkStore, log } = setup(
      [page([[6, 'e6'], [7, 'e7']])],
      5,
    )
    const deliver = vi.fn((event: { seq: number; id: string }): Promise<'recorded'> => {
      log.push(`deliver:${event.id}`)
      return Promise.resolve('recorded' as const)
    })

    await replayHistory(
      {
        historyPort: { history: vi.fn().mockResolvedValue(page([[6, 'e6'], [7, 'e7']])) },
        deliver: { deliver },
        watermarkStore,
      },
      { sessionId: 'sess-1' },
    )

    expect(log).toEqual(['deliver:e6', 'commit:6', 'deliver:e7', 'commit:7'])
  })
})

describe('multi-page replay with bounds (15.4)', () => {
  function multiPageDeps(deliverFn: (event: { seq: number; id: string }) => Promise<'recorded' | 'duplicate'>) {
    const history = vi.fn()
      .mockResolvedValueOnce(page([[9, 'e9']], true))
      .mockResolvedValueOnce(page([[6, 'e6'], [7, 'e7'], [8, 'e8']]))
    return {
      deps: {
        historyPort: { history } as EventHistoryPort,
        deliver: { deliver: deliverFn },
        watermarkStore: { watermark: () => 5, commit: vi.fn(() => Promise.resolve()) },
      },
      history,
    }
  }

  it('walks newest-first pages and folds them oldest-first deterministically', async () => {
    const { deps } = multiPageDeps(() => Promise.resolve('recorded' as const))

    const result = await replayHistory(deps, { sessionId: 'sess-1' })

    expect(result.delivered).toEqual(['e6', 'e7', 'e8', 'e9'])
    expect(result.committedThrough).toBe(9)
    expect(result.incomplete).toBe(false)
  })

  it('stops at the page budget and reports incomplete recovery', async () => {
    const { deps, history } = multiPageDeps(() => Promise.resolve('recorded' as const))

    const result = await replayHistory(deps, { sessionId: 'sess-1', maxPages: 1 })

    expect(result.delivered).toEqual(['e9'])
    expect(result.committedThrough).toBe(9)
    expect(result.incomplete).toBe(true)
    expect(history).toHaveBeenCalledTimes(1)
  })
})
