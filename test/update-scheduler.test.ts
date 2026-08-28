/**
 * Update scheduler tests (11.3): rapid chunks coalesce into one flush per
 * interval, never more than one edit is in flight, identical content does not
 * re-flush, and disposal stops everything.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createUpdateScheduler } from '../src/stream/update-scheduler.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('update scheduler', () => {
  it('coalesces a burst into one flush carrying the latest content', async () => {
    const flushed: string[] = []
    const scheduler = createUpdateScheduler({ minIntervalMs: 800, onFlush: (content) => { flushed.push(content); return Promise.resolve() } })

    for (let index = 0; index < 100; index += 1) {
      scheduler.schedule(`chunk ${String(index)}`)
    }
    await vi.advanceTimersByTimeAsync(799)
    expect(flushed).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(flushed).toEqual(['chunk 99'])
    scheduler.dispose()
  })

  it('never runs two flushes concurrently; the next content flushes after', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const flushed: string[] = []

    const scheduler = createUpdateScheduler({
      minIntervalMs: 100,
      onFlush: async (content) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        if (content === 'first') await firstGate
        flushed.push(content)
        inFlight -= 1
      },
    })

    scheduler.schedule('first')
    await vi.advanceTimersByTimeAsync(100)
    expect(flushed).toEqual([])

    scheduler.schedule('second')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(flushed).toEqual([]) // still waiting on the in-flight first flush

    releaseFirst()
    await vi.advanceTimersByTimeAsync(200)
    expect(flushed).toEqual(['first', 'second'])
    expect(maxInFlight).toBe(1)
    scheduler.dispose()
  })

  it('skips the flush when content did not change', async () => {
    const flushed: string[] = []
    const scheduler = createUpdateScheduler({ minIntervalMs: 100, onFlush: (content) => { flushed.push(content); return Promise.resolve() } })

    scheduler.schedule('same')
    await vi.advanceTimersByTimeAsync(100)
    scheduler.schedule('same')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(flushed).toEqual(['same'])
    scheduler.dispose()
  })

  it('stops flushing after disposal', async () => {
    const flushed: string[] = []
    const scheduler = createUpdateScheduler({ minIntervalMs: 100, onFlush: (content) => { flushed.push(content); return Promise.resolve() } })

    scheduler.dispose()
    scheduler.schedule('never')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(flushed).toEqual([])
  })
})
