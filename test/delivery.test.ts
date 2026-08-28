/**
 * Per-route delivery tests: sends and edits to one Discord route serialize in
 * FIFO order, distinct routes proceed concurrently, every op carries a nonce
 * delivery identity that cannot be reused while known, and a failing op never
 * wedges its route.
 */

import { describe, expect, it, vi } from 'vitest'

import { createRouteQueues } from '../src/discord/delivery.js'

describe('route queues', () => {
  it('serializes ops on one route in enqueue order', async () => {
    const routes = createRouteQueues()
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = routes.enqueue('channel:1', async () => {
      events.push('first:start')
      await firstGate
      events.push('first:end')
    }, { nonce: 'n1' })
    const second = routes.enqueue('channel:1', () => {
      events.push('second:start')
      return Promise.resolve()
    }, { nonce: 'n2' })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])

    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('runs distinct routes concurrently', async () => {
    const routes = createRouteQueues()
    const events: string[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })

    const a = routes.enqueue('channel:A', async () => {
      await gateA
      events.push('a')
    }, { nonce: 'na' })
    const b = routes.enqueue('channel:B', () => {
      events.push('b')
      return Promise.resolve()
    }, { nonce: 'nb' })

    await Promise.resolve()
    expect(events).toEqual(['b'])
    releaseA()
    await Promise.all([a, b])
    expect(events).toEqual(['b', 'a'])
  })

  it('rejects reusing a nonce while the original op is still known', () => {
    const routes = createRouteQueues()
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })

    void routes.enqueue('channel:1', () => gate, { nonce: 'dup' })
    expect(() => routes.enqueue('channel:1', () => Promise.resolve(), { nonce: 'dup' })).toThrow(/nonce/)

    releaseFirst()
  })

  it('allows a nonce again only after its op settles', async () => {
    const routes = createRouteQueues()
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = routes.enqueue('channel:1', () => gate, { nonce: 'reuse-me' })
    releaseFirst()
    await first

    const second = routes.enqueue('channel:1', () => Promise.resolve('done'), { nonce: 'reuse-me' })
    await expect(second).resolves.toBe('done')
  })

  it('continues serving a route after a failing op', async () => {
    const routes = createRouteQueues()
    const failing = routes.enqueue('channel:1', () => {
      return Promise.reject(new Error('discord 500'))
    }, { nonce: 'bad' })
    const following = routes.enqueue('channel:1', () => Promise.resolve('ok'), { nonce: 'good' })

    await expect(failing).rejects.toThrow('discord 500')
    await expect(following).resolves.toBe('ok')
  })

  it('delivers results and values untouched through the queue', async () => {
    const routes = createRouteQueues()
    const spy = vi.fn(() => Promise.resolve({ id: 'msg-1' }))
    const result = await routes.enqueue('channel:1', spy, { nonce: 'n' })
    expect(result).toEqual({ id: 'msg-1' })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
