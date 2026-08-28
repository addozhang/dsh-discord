/**
 * History replay after reconnect (design.md §11 steps 4–7, tasks 15.3/15.4).
 * Because DSH 0.1.1-rc.2 ignores `events.mux.since`, durable history reads —
 * not the live stream — are the recovery source. Per active session the
 * replay walks bounded history pages, folds events past the committed
 * watermark oldest-first, skips events whose live delivery is already known,
 * and advances the watermark strictly after the delivery bookkeeping for that
 * event resolves. The page budget bounds recovery work; hitting it yields an
 * explicitly incomplete result rather than an unbounded fetch loop.
 */

export interface HistoryEvent {
  seq: number
  id: string
}

/** One history page: events ascending within the page, newest page first. */
export interface HistoryPage {
  events: HistoryEvent[]
  hasMore: boolean
}

export interface EventHistoryPort {
  /** `beforeSeq === undefined` reads the newest page; older pages chain down. */
  history(sessionId: string, beforeSeq: number | undefined): Promise<HistoryPage>
}

export interface ReplayDeliverPort {
  /** Deliver one missed event; the return is the delivery bookkeeping. */
  deliver(event: HistoryEvent): Promise<'recorded' | 'duplicate'>
}

export interface ReplayWatermarkStore {
  watermark(sessionId: string): number | undefined
  commit(sessionId: string, seq: number): Promise<void>
}

export interface ReplayDeps {
  historyPort: EventHistoryPort
  deliver: ReplayDeliverPort
  watermarkStore: ReplayWatermarkStore
}

export interface ReplayInput {
  sessionId: string
  /** Ids already delivered live across the reconnect gap. */
  liveSeen?: ReadonlySet<string> | undefined
  /** Page budget; recovery reports incomplete past this instead of looping. */
  maxPages?: number | undefined
}

export interface ReplayResult {
  delivered: string[]
  committedThrough?: number | undefined
  incomplete: boolean
}

const DEFAULT_MAX_PAGES = 3

export async function replayHistory(deps: ReplayDeps, input: ReplayInput): Promise<ReplayResult> {
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES
  const watermark = deps.watermarkStore.watermark(input.sessionId)
  const delivered: string[] = []
  let committedThrough: number | undefined = undefined

  // Newest page first; each older page continues below the lowest seq seen.
  let beforeSeq: number | undefined = undefined
  let pending: HistoryEvent[] = []
  let incomplete = false

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await deps.historyPort.history(input.sessionId, beforeSeq)
    const fresh = page.events.filter(event => event.seq > (watermark ?? Number.NEGATIVE_INFINITY))
    pending = [...fresh, ...pending]
    beforeSeq = page.events.length > 0 ? page.events[0]?.seq : beforeSeq
    if (!page.hasMore) {
      pending = pending.filter(event => event.seq > (watermark ?? Number.NEGATIVE_INFINITY))
      break
    }
    if (pageIndex === maxPages - 1) incomplete = true
  }

  // Fold oldest-first, committing only after the bookkeeping resolves.
  // Events already delivered live across the gap (their id is in liveSeen)
  // skip the deliver call entirely but still advance the watermark: the
  // live path owns their bookkeeping.
  for (const event of pending) {
    if (input.liveSeen?.has(event.id) === true) {
      await deps.watermarkStore.commit(input.sessionId, event.seq)
      committedThrough = event.seq
      continue
    }
    const bookkeeping = await deps.deliver.deliver(event)
    if (bookkeeping === 'recorded') delivered.push(event.id)
    await deps.watermarkStore.commit(input.sessionId, event.seq)
    committedThrough = event.seq
  }

  return { delivered, committedThrough, incomplete }
}
