/**
 * The 0.1.6 host event bridge: fans the per-session `session/follow`
 * journals plus the host-wide `session/control` stream into the single
 * frame stream the live renderer consumes (the rc.2 `apiProxy.events.mux`
 * global stream no longer exists).
 *
 * Frame vocabulary is preserved verbatim (`session/event`,
 * `session/subscribed`, `session/queue`), so `src/stream/live.ts` and its
 * tests are untouched by the host-side rebase. Two deliberate exclusions:
 *
 * - `snapshot` opening windows ARE translated through the same seq
 *   watermark as live events: the turn often completes between prompt
 *   admission and our follow subscription, so the opening window is the
 *   ONLY carrier of those records. The watermark (last delivered seq per
 *   session) keeps re-subscription replays idempotent.
 * - approval/question request frames are NOT synthesized here: the 0.1.6
 *   host routes asks through the composed-approval model, which the
 *   ask-wiring migration wires separately.
 */

/** Narrow follow face over one durable session journal. */
export interface HostSessionFollowFace {
  follow(request: {
    address: { kind: 'session'; sessionId: string }
    assistantStream?: true
  }, signal: AbortSignal): AsyncIterable<unknown>
  control(signal: AbortSignal): AsyncIterable<unknown>
}

export interface HostEventRouterOptions {
  log?: (event: string, detail?: unknown) => void
}

interface FrameQueue {
  push(frame: unknown): void
  close(): void
}

/** Build the push-side of the single consumer queue. */
function createFrameQueue(): FrameQueue & { iterate(signal: AbortSignal): AsyncIterable<unknown> } {
  const buffered: unknown[] = []
  let notify: (() => void) | undefined
  let closed = false
  const queue: FrameQueue = {
    push(frame) {
      if (closed) return
      buffered.push(frame)
      const wake = notify
      notify = undefined
      wake?.()
    },
    close() {
      closed = true
      const wake = notify
      notify = undefined
      wake?.()
    },
  }
  return {
    ...queue,
    iterate(signal) {
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (;;) {
              if (signal.aborted) return
              while (buffered.length > 0) {
                // shift() cannot miss: the length guard ran first.
                yield buffered.shift()
              }
              if (closed) return
              await new Promise<void>(resolve => {
                notify = resolve
                const abort = () => {
                  notify = undefined
                  resolve()
                }
                signal.addEventListener('abort', abort, { once: true })
              })
            }
          } finally {
            queue.close()
          }
        },
      }
    },
  }
}

/** Defensive record probe: the wire is untrusted regardless of declared types. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Defensive text extraction from a queued message's JSON content parts. */
function queueItemSummary(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const typed = part as { type?: unknown; text?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') texts.push(typed.text)
  }
  return texts.join(' ').slice(0, 200)
}

/**
 * The fan-in router. `track(sessionId)` is idempotent and safe to call from
 * every session-acquisition site (create, adopt, resume, prompt); each
 * tracked session owns one follow loop whose frames join the shared queue.
 */
export function createHostEventRouter(
  services: HostSessionFollowFace,
  options: HostEventRouterOptions = {},
): {
  track(sessionId: string): void
  stream(signal: AbortSignal): AsyncIterable<unknown>
} {
  const log = options.log
  const tracked = new Map<string, AbortController>()
  /** Last delivered durable seq per session: the replay-dedupe watermark. */
  const watermark = new Map<string, number>()
  let consumer: FrameQueue | undefined
  let rootSignal: AbortSignal | undefined

  const startLoop = (sessionId: string, attempt = 0): void => {
    const per = new AbortController()
    tracked.set(sessionId, per)
    void (async () => {
      try {
        consumer?.push({ type: 'session/subscribed', sessionId })
        for await (const raw of services.follow({ address: { kind: 'session', sessionId } }, per.signal)) {
          if (!isRecord(raw)) continue
          const frame = raw
          // Both the opening snapshot and live journal entries carry the
          // same {type, data, seq} record envelope the rc.2 mux delivered;
          // the seq watermark keeps replayed windows idempotent.
          if (frame['type'] === 'event' || frame['type'] === 'snapshot') {
            const records = (raw as { records?: unknown }).records
            if (!Array.isArray(records)) continue
            const through = watermark.get(sessionId) ?? 0
            let delivered = through
            for (const record of records) {
              // Journal records arrive double-wrapped: {type:'event',
              // event:{type, seq, time, data}} — the wire event rides the
              // `event` key. Accept the flat shape defensively too.
              const candidate = record as { type?: unknown; data?: unknown; seq?: unknown; event?: unknown } | null
              if (candidate === null || typeof candidate !== 'object') continue
              const inner = typeof candidate.event === 'object' && candidate.event !== null
                ? candidate.event as { type?: unknown; data?: unknown; seq?: unknown }
                : candidate
              if (typeof inner.type !== 'string') continue
              if (typeof inner.seq === 'number') {
                if (inner.seq <= through) continue
                if (inner.seq > delivered) delivered = inner.seq
              }
              consumer?.push({
                type: 'session/event',
                sessionId,
                event: { type: inner.type, data: (typeof inner.data === 'object' && inner.data !== null ? inner.data : {}) as Record<string, unknown> },
              })
            }
            if (delivered > through) watermark.set(sessionId, delivered)
          } else if (frame['type'] === 'assistant-stream') {
            // Live assistant deltas ride the dedicated stream frames; the
            // renderer's durable events already carry the message texts.
            continue
          }
        }
      } catch (cause) {
        if (!per.signal.aborted) {
          log?.('discord_host_follow_threw', { sessionId, cause: String(cause) })
        }
      } finally {
        if (tracked.get(sessionId) === per) tracked.delete(sessionId)
        // A follow stream may END normally once its snapshot is delivered
        // (a cold session has no live agent to follow): without a
        // re-subscribe, every later turn is invisible until the next
        // process restart replays the journal. Re-arm with backoff.
        if (!per.signal.aborted) {
          const delayMs = Math.min(30_000, 1_000 * 2 ** attempt)
          setTimeout(() => {
            if (!per.signal.aborted && !tracked.has(sessionId)) {
              log?.('discord_host_follow_resubscribed', { sessionId, delayMs })
              startLoop(sessionId, attempt + 1)
            }
          }, delayMs)
        }
      }
    })()
  }

  const startControlLoop = (signal: AbortSignal): void => {
    void (async () => {
      try {
        for await (const raw of services.control(signal)) {
          if (!isRecord(raw)) continue
          const frame = raw
          if (frame['type'] === 'queue' && typeof frame['sessionId'] === 'string') {
            const rawItems = Array.isArray(frame['items']) ? frame['items'] as unknown[] : []
            const items = rawItems
              .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item['id'] === 'string')
              .map(item => ({
                id: item['id'] as string,
                summary: queueItemSummary(isRecord(item['message']) ? item['message']['content'] : undefined),
              }))
            consumer?.push({
              type: 'session/queue',
              sessionId: frame['sessionId'],
              items,
            })
          }
          // baseline / jobs / projection frames carry no live-render state.
        }
      } catch (cause) {
        if (!signal.aborted) {
          log?.('discord_host_control_threw', { cause: String(cause) })
        }
      }
    })()
  }

  return {
    track(sessionId) {
      if (sessionId === '' || tracked.has(sessionId)) return
      if (rootSignal?.aborted) return
      startLoop(sessionId)
    },
    stream(signal) {
      rootSignal = signal
      const queue = createFrameQueue()
      consumer = queue
      // Re-arm every already-tracked session against the new consumer.
      for (const [sessionId, per] of [...tracked.entries()]) {
        per.abort()
        tracked.delete(sessionId)
        startLoop(sessionId)
      }
      startControlLoop(signal)
      return queue.iterate(signal)
    },
  }
}
