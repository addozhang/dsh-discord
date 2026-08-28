/**
 * The adapter's single cancellation root. Every timer, listener, and
 * abortable resource the plugin opens registers here, so Cordis-owned
 * disposal tears the whole runtime down in one effect and no callback can
 * ever run after the plugin unloads.
 */

export type Disposer = () => void

/** Minimal event target face the root's listener helper needs. */
export interface ListenerTarget {
  addEventListener(name: string, handler: () => void): unknown
  removeEventListener(name: string, handler: () => void): unknown
}

export class CancellationRoot {
  private disposedState = false
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly disposables: Disposer[] = []
  private readonly controller = new AbortController()

  /** The abort signal async work (streams, fetches) must observe. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Whether this root has been torn down; disposed roots refuse new work. */
  get disposed(): boolean {
    return this.disposedState
  }

  /** Run `callback` every `ms` until disposal; the timer never fires after. */
  setInterval(callback: () => void, ms: number): void {
    this.assertActive()
    const timer = setInterval(() => { callback() }, ms)
    this.pendingTimers.add(timer)
  }

  /** Run `callback` once after `ms` unless disposal happens first. */
  setTimeout(callback: () => void, ms: number): void {
    this.assertActive()
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer)
      callback()
    }, ms)
    this.pendingTimers.add(timer)
  }

  /** Observe `name` on `target` until disposal removes the listener. */
  listen(target: ListenerTarget, name: string, handler: () => void): void {
    this.assertActive()
    target.addEventListener(name, handler)
    this.disposables.push(() => { target.removeEventListener(name, handler) })
  }

  /** Register one disposer running at disposal (reverse registration order). */
  register(disposer: Disposer): void {
    this.assertActive()
    this.disposables.push(disposer)
  }

  /**
   * Tear everything down: clear timers, run disposers in reverse order,
   * abort the signal, and refuse all future work. Idempotent.
   */
  dispose(): void {
    if (this.disposedState) return
    this.disposedState = true
    for (const timer of this.pendingTimers) clearTimeout(timer)
    this.pendingTimers.clear()
    for (const disposer of [...this.disposables].reverse()) {
      try {
        disposer()
      } catch {
        // A failing disposer must not stop the remaining teardown; the root
        // is already marked disposed, so nothing can re-register.
      }
    }
    this.disposables.length = 0
    this.controller.abort()
  }

  private assertActive(): void {
    if (this.disposedState) {
      throw new TypeError('dsh-discord cancellation root is disposed; refusing new work')
    }
  }
}

/**
 * Install the plugin's cancellation root on its own Cordis fiber: the
 * returned root lives exactly as long as the plugin and is disposed through
 * the fiber's effect teardown.
 */
export function installCancellationRoot(ctx: {
  effect(execute: () => () => void, label?: string): unknown
}): CancellationRoot {
  const root = new CancellationRoot()
  ctx.effect(() => () => { root.dispose() }, 'dsh-discord cancellation root')
  return root
}
