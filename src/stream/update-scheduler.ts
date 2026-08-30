/**
 * The streaming update scheduler (design.md §8, task 11.3). Rapid chunks
 * coalesce: content is remembered as "latest" and one flush per interval
 * carries it to Discord — and because a flush may be an in-flight REST edit,
 * the scheduler serializes: while a flush runs, new content only waits; the
 * next flush fires only when both the interval elapsed AND the content
 * changed. A failed flush is observed HERE (the scheduler runs detached, so
 * its rejection would otherwise be unhandled), reported through
 * `onFlushError`, and retried on the next schedule.
 */

export interface UpdateScheduler {
  schedule(content: string): void
  dispose(): void
}

export function createUpdateScheduler(options: {
  minIntervalMs: number
  onFlush(content: string): Promise<void>
  /** Observes a failed flush; unset, failures are still contained silently. */
  onFlushError?: (cause: unknown) => void
}): UpdateScheduler {
  let disposed = false
  let latest: string | undefined
  let lastFlushed: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushing = false

  function scheduleNext(now: string | undefined): void {
    if (disposed || now === undefined || now === lastFlushed) return
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void runFlush()
    }, options.minIntervalMs)
  }

  async function runFlush(): Promise<void> {
    if (disposed || flushing) return
    const content = latest
    if (content === undefined || content === lastFlushed) return
    flushing = true
    try {
      await options.onFlush(content)
      lastFlushed = content
    } catch (cause) {
      // The flush runs detached (void runFlush()), so this catch is the only
      // thing standing between a failing delivery and a process-killing
      // unhandled rejection. lastFlushed stays put: the next schedule retries.
      options.onFlushError?.(cause)
    } finally {
      flushing = false
      // Content that arrived during the flush gets its own interval now.
      scheduleNext(latest)
    }
  }

  return {
    schedule(content) {
      if (disposed) return
      latest = content
      scheduleNext(content)
    },
    dispose() {
      disposed = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}
