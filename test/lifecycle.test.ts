/**
 * Lifecycle tests for the plugin's single cancellation root: every timer,
 * listener, and abortable resource the adapter ever opens is registered
 * under one root whose disposal is owned by Cordis, and no callback runs
 * after disposal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CancellationRoot, installCancellationRoot } from '../src/lifecycle.js'
import { apply } from '../src/index.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('cancellation root', () => {
  it('runs timers until disposal and never after', () => {
    const root = new CancellationRoot()
    const fired: number[] = []
    root.setInterval(() => { fired.push(fired.length + 1) }, 100)

    vi.advanceTimersByTime(250)
    expect(fired).toEqual([1, 2])

    root.dispose()
    vi.advanceTimersByTime(1000)
    expect(fired).toEqual([1, 2])
  })

  it('clears a pending timeout on disposal without running it', () => {
    const root = new CancellationRoot()
    const fn = vi.fn()
    root.setTimeout(fn, 100)
    root.dispose()
    vi.advanceTimersByTime(1000)
    expect(fn).not.toHaveBeenCalled()
  })

  it('detaches listeners on disposal and stops notifying them', () => {
    const root = new CancellationRoot()
    const handler = vi.fn()
    const target = new EventTarget()
    root.listen(target, 'tick', handler)

    target.dispatchEvent(new Event('tick'))
    expect(handler).toHaveBeenCalledTimes(1)

    root.dispose()
    target.dispatchEvent(new Event('tick'))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('aborts its signal on disposal', () => {
    const root = new CancellationRoot()
    expect(root.signal.aborted).toBe(false)
    root.dispose()
    expect(root.signal.aborted).toBe(true)
  })

  it('refuses new registrations after disposal', () => {
    const root = new CancellationRoot()
    root.dispose()
    expect(() => { root.setTimeout(() => {}, 100); }).toThrow(/disposed/)
    expect(() => { root.register(() => {}); }).toThrow(/disposed/)
    expect(() => { root.listen(new EventTarget(), 'tick', () => {}); }).toThrow(/disposed/)
  })

  it('runs registered disposers in reverse order exactly once', () => {
    const root = new CancellationRoot()
    const order: string[] = []
    root.register(() => { order.push('first') })
    root.register(() => { order.push('second') })
    root.dispose()
    root.dispose()
    expect(order).toEqual(['second', 'first'])
  })

  it('dispose is idempotent and leaves the signal aborted', () => {
    const root = new CancellationRoot()
    root.dispose()
    expect(() => { root.dispose(); }).not.toThrow()
    expect(root.disposed).toBe(true)
    expect(root.signal.aborted).toBe(true)
  })
})

describe('cordis-owned disposal', () => {
  it('apply installs one cancellation root torn down by the fiber', () => {
    const effects: { execute: () => unknown; label: string | undefined }[] = []
    const ctx = {
      get: (serviceName: string) => ({
        apiProxy: { sessions: {}, workspace: {}, events: {}, host: {} },
        credentials: { resolve: () => {}, describe: () => {}, set: () => {}, unset: () => {} },
        settings: { register: () => {} },
        storageDomain: { open: () => {} },
        connection: { rpc: { handle: () => () => {} } },
      })[serviceName],
      inject: vi.fn(),
      logger: { debug: vi.fn() },
      effect: (execute: () => unknown, label?: string) => { effects.push({ execute, label }) },
    }
    apply(ctx as never)
    // The cancellation root plus the composed runtime teardown.
    expect(effects.length).toBeGreaterThanOrEqual(1)
    expect(effects[0]?.label).toContain('cancellation root')
  })

  it('installCancellationRoot returns the live root and disposes it through the effect', () => {
    let disposer: () => unknown = () => {}
    const ctx = {
      effect: (execute: () => unknown) => { disposer = execute() as () => unknown },
    }
    const root = installCancellationRoot(ctx as never)
    expect(root.disposed).toBe(false)
    disposer()
    expect(root.disposed).toBe(true)
  })
})
