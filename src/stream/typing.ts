/**
 * The typing keepalive lifecycle (design.md §8, task 11.9). Typing starts
 * when a Turn produces work and refreshes on an interval; an owning
 * interaction pauses it (the interaction owns attention); completion,
 * cancellation, and failure all stop it; disposal is terminal — no trigger
 * can fire after the plugin tears the surface down.
 */

export type TypingStopReason = 'completed' | 'cancelled' | 'failed' | 'disposed'
export type TypingPauseReason = 'interaction'

export interface TypingLifecycle {
  start(): void
  pause(reason: TypingPauseReason): void
  resume(): void
  stop(reason?: TypingStopReason): void
  dispose(): void
}

export function createTypingLifecycle(options: {
  trigger: () => void | Promise<void>
  intervalMs: number
  /** Observes a failed trigger; the interval keeps the indicator honest. */
  onFailure?: (cause: unknown) => void
}): TypingLifecycle {
  let state: 'idle' | 'running' | 'paused' | 'stopped' = 'idle'
  let timer: ReturnType<typeof setInterval> | undefined

  const fire = (): void => {
    // The trigger runs detached (fire-and-forget by contract); without this
    // catch a rejecting trigger (e.g. a credential resolution failure) would
    // be an unhandled rejection and kill the process.
    void Promise.resolve(options.trigger()).catch((cause: unknown) => {
      options.onFailure?.(cause)
    })
  }

  function clearTimer(): void {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  return {
    start() {
      if (state !== 'idle') return
      state = 'running'
      fire()
      timer = setInterval(fire, options.intervalMs)
    },
    pause(reason) {
      void reason
      if (state !== 'running') return
      state = 'paused'
      clearTimer()
    },
    resume() {
      if (state !== 'paused') return
      state = 'running'
      fire()
      timer = setInterval(fire, options.intervalMs)
    },
    stop(reason = 'completed') {
      void reason
      if (state === 'stopped') return
      state = 'stopped'
      clearTimer()
    },
    dispose() {
      this.stop('disposed')
    },
  }
}
