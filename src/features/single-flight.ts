/**
 * Trailing-edge single flight (review C-2). Command registration is
 * triggered by settings changes, and a trigger that lands while a pass is
 * in flight carries NEW state (a guild was added or removed): dropping it
 * meant the guild's commands were silently never registered — or stale
 * ones lingered — until the next unrelated trigger. The flight re-runs
 * once after the in-flight pass whenever a trigger arrived meanwhile;
 * concurrent triggers coalesce into that single re-run.
 */
export interface TrailingSingleFlightOptions {
  onThrew?: (cause: unknown) => void
}

export function createTrailingSingleFlight(
  run: () => Promise<void>,
  options: TrailingSingleFlightOptions = {},
): () => void {
  let running = false
  let dirty = false

  const start = (): void => {
    running = true
    void (async () => {
      try {
        await run()
      } catch (cause: unknown) {
        options.onThrew?.(cause)
      } finally {
        if (dirty) {
          dirty = false
          // Re-arm SYNCHRONOUSLY: start() sets running=true before any
          // await, so a trigger landing in a microtask gap after this
          // finally still sees running and coalesces (PR review: a gap
          // let a second pass start beside the queued one).
          running = true
          start()
        } else {
          running = false
        }
      }
    })()
  }

  return () => {
    if (running) {
      dirty = true
      return
    }
    start()
  }
}
