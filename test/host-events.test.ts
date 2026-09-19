/**
 * Host event router translation tests (turn-progress-discord-sync 2.1/2.2).
 *
 * The 0.1.6-alpha.2 wire carries journal frames in two carrier shapes,
 * captured on the real machine (diagnosis.md, runs 2–3):
 *
 * - snapshot windows: `{type:'snapshot', records:[{type:'event', event:{…}}]}`
 * - live records:     `{type:'event', event:{type, seq, time, data}}` — a
 *   SINGLE record under `event`, no `records` array — and the host only
 *   pushes live records at all when the follow request asks for assistant
 *   streaming.
 */

import { describe, expect, it } from 'vitest'

import { createHostEventRouter, type HostSessionFollowFace, type TrackSeedOptions } from '../src/dsh/host-events.js'

interface Harness {
  followRequests: Array<Record<string, unknown>>
  /** Push wire frames into the open follow stream. */
  deliver(frames: unknown[]): void
  /** Open the consumer stream, track `sess-1` (optionally seeded), collect for `ms`, abort. */
  collect(ms: number, seed?: TrackSeedOptions): Promise<unknown[]>
}

function createHarness(): Harness {
  const followRequests: Array<Record<string, unknown>> = []
  let pending: unknown[] = []
  let wake: (() => void) | undefined
  const face: HostSessionFollowFace = {
    follow(request: Record<string, unknown>, signal: AbortSignal): AsyncIterable<unknown> {
      followRequests.push(request)
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              if (pending.length > 0) return { value: pending.shift(), done: false }
              if (signal.aborted) return { value: undefined, done: true }
              await new Promise<void>(resolve => {
                wake = resolve
                signal.addEventListener('abort', () => { resolve() }, { once: true })
              })
              if (pending.length > 0) return { value: pending.shift(), done: false }
              return { value: undefined, done: true }
            },
          }
        },
      }
    },
    control(): AsyncIterable<unknown> {
      return {
        [Symbol.asyncIterator]() {
          return { next: () => Promise.resolve({ value: undefined, done: true } as IteratorResult<unknown>) }
        },
      }
    },
  } as HostSessionFollowFace
  const router = createHostEventRouter(face)
  return {
    followRequests,
    deliver(frames: unknown[]): void {
      pending = [...pending, ...frames]
      wake?.()
    },
    async collect(ms: number, seed?: TrackSeedOptions): Promise<unknown[]> {
      const collected: unknown[] = []
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const frame of router.stream(controller.signal)) collected.push(frame)
        } catch { /* aborted */ }
      })()
      // Mirror compose's order: the consumer stream opens first, then the
      // session-acquisition sites track.
      await new Promise(resolve => { setTimeout(resolve, 5) })
      router.track('sess-1', seed)
      await new Promise(resolve => { setTimeout(resolve, ms) })
      controller.abort()
      await new Promise(resolve => { setTimeout(resolve, 10) })
      return collected
    },
  }
}

describe('host event router: 0.1.6 carrier translation', () => {
  it('translates live single-record event frames (no records array)', async () => {
    const h = createHarness()
    const collecting = h.collect(30)
    h.deliver([
      { type: 'event', event: { type: 'tool/call', seq: 7, time: 1, data: { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } } },
    ])
    const frames = await collecting
    const events = frames.filter(f => (f as { type?: string }).type === 'session/event')
    expect(events).toEqual([{
      type: 'session/event',
      sessionId: 'sess-1',
      event: { type: 'tool/call', data: { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
      carrier: 'live',
      seq: 7,
    }])
  })

  it('translates snapshot windows with the double envelope', async () => {
    const h = createHarness()
    const collecting = h.collect(30)
    h.deliver([
      { type: 'snapshot', records: [{ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } }] },
    ])
    const frames = await collecting
    expect(frames).toContainEqual({
      type: 'session/event',
      sessionId: 'sess-1',
      event: { type: 'turn/start', data: { turn: 1 } },
      carrier: 'snapshot',
      seq: 1,
    })
  })

  it('accepts flat snapshot records defensively', async () => {
    const h = createHarness()
    const collecting = h.collect(30)
    h.deliver([
      { type: 'snapshot', records: [{ type: 'step/start', seq: 2, data: { turn: 1, step: 1 } }] },
    ])
    const frames = await collecting
    expect(frames).toContainEqual({
      type: 'session/event',
      sessionId: 'sess-1',
      event: { type: 'step/start', data: { turn: 1, step: 1 } },
      carrier: 'snapshot',
      seq: 2,
    })
  })

  it('dedupes by seq across live and snapshot carriers', async () => {
    const h = createHarness()
    const collecting = h.collect(40)
    h.deliver([
      { type: 'event', event: { type: 'turn/start', seq: 4, time: 1, data: { turn: 1 } } },
      { type: 'snapshot', records: [
        { type: 'event', event: { type: 'turn/start', seq: 4, time: 1, data: { turn: 1 } } },
        { type: 'event', event: { type: 'turn/end', seq: 5, time: 1, data: { turn: 1, reason: { kind: 'completed' } } } },
      ] },
    ])
    const frames = (await collecting).filter(f => (f as { type?: string }).type === 'session/event') as Array<{ event?: { type?: string } }>
    const types = frames.map(f => f.event?.type)
    expect(types).toEqual(['turn/start', 'turn/end'])
  })

  it('requests assistant streaming (live-tail activator, alpha.2)', async () => {
    const h = createHarness()
    const collecting = h.collect(20)
    h.deliver([])
    await collecting
    expect(h.followRequests.length).toBeGreaterThanOrEqual(1)
    for (const request of h.followRequests) {
      expect(request['assistantStream']).toBe(true)
    }
  })

  it('announces subscription before events for a tracked session', async () => {
    const h = createHarness()
    const collecting = h.collect(30)
    h.deliver([
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } },
    ])
    const frames = await collecting
    expect(frames[0]).toEqual({ type: 'session/subscribed', sessionId: 'sess-1' })
  })
})

describe('host event router: replay fence (replay-fence-and-user-input)', () => {
  it('drops snapshot records at or below a seeded floor', async () => {
    const h = createHarness()
    const collecting = h.collect(40, { floor: 5 })
    h.deliver([
      { type: 'snapshot', records: [
        { type: 'event', event: { type: 'turn/start', seq: 4, time: 1, data: { turn: 1 } } },
        { type: 'event', event: { type: 'turn/end', seq: 5, time: 1, data: { turn: 1 } } },
      ] },
    ])
    const frames = await collecting
    expect(frames.filter(f => (f as { type?: string }).type === 'session/event')).toEqual([])
  })

  it('delivers snapshot records above the floor', async () => {
    const h = createHarness()
    const collecting = h.collect(40, { floor: 5 })
    h.deliver([
      { type: 'snapshot', records: [
        { type: 'event', event: { type: 'turn/start', seq: 6, time: 1, data: { turn: 2 } } },
      ] },
    ])
    const frames = await collecting
    const events = frames.filter(f => (f as { type?: string }).type === 'session/event')
    expect(events).toEqual([{
      type: 'session/event',
      sessionId: 'sess-1',
      event: { type: 'turn/start', data: { turn: 2 } },
      carrier: 'snapshot',
      seq: 6,
    }])
  })

  it('swallows the first opening snapshot whole for legacy bindings, then delivers live', async () => {
    const h = createHarness()
    const collecting = h.collect(50, { suppressOpeningSnapshot: true })
    h.deliver([
      // The legacy thread already rendered this history: nothing may deliver.
      { type: 'snapshot', records: [
        { type: 'event', event: { type: 'turn/start', seq: 10, time: 1, data: { turn: 1 } } },
        { type: 'event', event: { type: 'turn/end', seq: 11, time: 1, data: { turn: 1 } } },
      ] },
    ])
    await new Promise(resolve => { setTimeout(resolve, 10) })
    h.deliver([
      // Later live records (post-watermark) deliver normally — the swallow
      // must not become a permanent floor.
      { type: 'event', event: { type: 'turn/start', seq: 12, time: 1, data: { turn: 2 } } },
    ])
    const frames = (await collecting).filter(f => (f as { type?: string }).type === 'session/event') as Array<{ seq?: number }>
    expect(frames.map(f => f.seq)).toEqual([12])
  })
})
