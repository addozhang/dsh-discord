/**
 * Typing lifecycle tests (11.9): start fires immediately then keepalives on
 * the interval; an owning interaction pauses the keepalive; completion,
 * cancellation, and failure stop it; disposal is terminal and idempotent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTypingLifecycle } from '../src/stream/typing.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function setup() {
  const trigger = vi.fn()
  const lifecycle = createTypingLifecycle({ trigger, intervalMs: 7_000 })
  return { trigger, lifecycle }
}

describe('typing lifecycle', () => {
  it('fires immediately on start and keepalives on the interval', async () => {
    const { trigger, lifecycle } = setup()
    lifecycle.start()
    expect(trigger).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(7_000)
    expect(trigger).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(14_000)
    expect(trigger).toHaveBeenCalledTimes(4)
    lifecycle.stop()
  })

  it('pauses during an interaction and resumes after', async () => {
    const { trigger, lifecycle } = setup()
    lifecycle.start()
    lifecycle.pause('interaction')
    const count = trigger.mock.calls.length
    await vi.advanceTimersByTimeAsync(21_000)
    expect(trigger).toHaveBeenCalledTimes(count)

    lifecycle.resume()
    // Resume fires immediately, then keepalives on the interval.
    expect(trigger).toHaveBeenCalledTimes(count + 1)
    await vi.advanceTimersByTimeAsync(7_000)
    expect(trigger).toHaveBeenCalledTimes(count + 2)
    lifecycle.stop()
  })

  it('stops on completion, cancellation, and failure alike', async () => {
    for (const reason of ['completed', 'cancelled', 'failed'] as const) {
      const { trigger, lifecycle } = setup()
      lifecycle.start()
      lifecycle.stop(reason)
      const count = trigger.mock.calls.length
      await vi.advanceTimersByTimeAsync(21_000)
      expect(trigger).toHaveBeenCalledTimes(count)
    }
  })

  it('is idempotent: double stop and start-after-stop are no-ops', async () => {
    const { trigger, lifecycle } = setup()
    lifecycle.start()
    lifecycle.stop()
    lifecycle.stop()
    lifecycle.start()
    const count = trigger.mock.calls.length
    await vi.advanceTimersByTimeAsync(21_000)
    expect(trigger).toHaveBeenCalledTimes(count)
  })

  it('disposal is terminal', async () => {
    const { trigger, lifecycle } = setup()
    lifecycle.start()
    lifecycle.dispose()
    lifecycle.start()
    const count = trigger.mock.calls.length
    await vi.advanceTimersByTimeAsync(21_000)
    expect(trigger).toHaveBeenCalledTimes(count)
  })
})
