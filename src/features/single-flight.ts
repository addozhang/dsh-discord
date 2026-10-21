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
        running = false
        if (dirty) {
          dirty = false
          // Next microtask: never re-enter the caller's finally chain
          // synchronously.
          void Promise.resolve().then(() => { start() })
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
