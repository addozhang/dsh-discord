/**
 * Live render wiring (Phase 1): the DSH events.mux stream drives per-thread
 * render state into Discord delivery. Each bound session thread owns one
 * runtime — render model, update scheduler, typing lifecycle, tool activity
 * surface, and the turn's head message. Frames for sessions with no bound
 * thread are dropped (reconciliation owns recovery, not the live path);
 * `assistant/message` finalizes exactly once with ordered continuations;
 * `turn/end` stops typing, releases the adapter-owned turn, and deletes the
 * turn's tool activity message.
 */

import { createThreadRenderModel, type ThreadRenderModel } from './render-model.js'
import { createUpdateScheduler, type UpdateScheduler } from './update-scheduler.js'
import { createTypingLifecycle, type TypingLifecycle } from './typing.js'
import { createToolActivitySurface, type ToolActivitySurface, type ToolRow } from './tool-view.js'
import { createAnswerFinalizer, type AnswerFinalizer } from './finalizer.js'
import { buildOutboundMessage } from './outbound.js'
import { toolCategoryIcon } from './icons.js'
import { shellCommandTitle } from './tool-view.js'
import { discordChannelNameKey, safeTitle } from '../policy/disclosure.js'
import type { DiscordVerbosity } from '../settings.js'

/** The mux frames the live path consumes (narrow, defensive shape). */
export type LiveFrame =
  | {
      type: 'session/event'
      sessionId: string
      event: { type: string; data: Record<string, unknown> }
      /** Journal seq of the carried record (absent on seq-less records). */
      seq?: number
      /** Which follow carrier delivered the record (replay-fence D4). */
      carrier?: 'snapshot' | 'live'
      view?: unknown
    }
  | { type: 'session/subscribed'; sessionId: string }
  | { type: 'session/queue'; sessionId: string; items: Array<{ id: string; summary: string }> }
  | { type: string }

/**
 * The Discord delivery face the live renderer needs. `unknown` on a send
 * means the request's application on Discord's side is unobservable (rest.ts
 * contract); the caller must never blind-resent such a send — the live path
 * pauses instead and lets the finalizer's single fresh send carry the text.
 */
export interface LiveDeliveryPort {
  send(request: { channelId: string; content: string }): Promise<
    | { outcome: 'completed'; messageId: string }
    | { outcome: 'unknown' }
    | { outcome: 'failed' }
  >
  edit(request: { channelId: string; messageId: string; content: string }): Promise<
    | { outcome: 'completed' }
    | { outcome: 'failed' }
  >
  delete(request: { channelId: string; messageId: string }): Promise<
    | { outcome: 'completed' }
    | { outcome: 'failed' }
  >
  typing(channelId: string): Promise<void>
  renameThread(request: { channelId: string; name: string }): Promise<
    | { outcome: 'completed' }
    | { outcome: 'failed' }
  >
}

export interface LiveRenderDeps {
  frames: (signal: AbortSignal) => AsyncIterable<unknown>
  threadForSession: (sessionId: string) => string | undefined
  delivery: LiveDeliveryPort
  /** Wire name of a thread, when resolvable; lets a restart skip no-op renames. */
  threadName?: (channelId: string) => Promise<string | undefined>
  updateIntervalMs: number
  typingIntervalMs: number
  /** Coalescing budget for tool-activity edits (default 1s). */
  activityCoalesceMs?: number
  verbosity?: DiscordVerbosity
  log?: (event: string, detail?: unknown) => void
  /** Queue snapshot cache (the /queue surface's data source). */
  onQueueSnapshot?: (sessionId: string, items: Array<{ id: string; summary: string }>) => void
  /** Localized interruption suffix, resolved live (language can change). */
  interruptedMarker?: () => string
  /**
   * Localized progress-phase copy, resolved live (language can change).
   * Unset: the status line is omitted and only tool rows render (the
   * pre-progress behavior).
   */
  progressCopy?: () => {
    thinking: string
    thinkingStep: (step: number) => string
    writing: string
    approvalWait: string
    turnSummary: (total: number, failed: number, breakdown: string) => string
  }
  /**
   * Localized user-echo copy, resolved live (language can change).
   * Unset: user/message records never echo (the pre-feature behavior).
   */
  userEchoCopy?: () => { label: string; nonText: string; truncated: string }
  /** Turn ownership release on turn/end; `info` carries the consumed watermark. */
  onTurnEnded?: (sessionId: string, info?: { threadId: string; renderedSeq: number }) => void
}

/** Coalescing budget for activity-message edits under parallel tools. */
const DEFAULT_ACTIVITY_COALESCE_MS = 1_000
/** Row budget: a presentation title is truncated before it reaches Discord. */
const ACTIVITY_TITLE_MAX = 80
/**
 * Echo budget for one user/message (replay-fence D6): history catch-up
 * mirrors, it does not replay wholesale — beyond this the text truncates
 * with a marker and the Session log remains the source of truth.
 */
const USER_ECHO_MAX = 500

/**
 * Wire-level live-path tracing (`DSH_DISCORD_TRACE=1` → stderr). Default
 * silent like the rest of the adapter; the live path's drops (unrecognized
 * frame shapes, unmatched sessions) are otherwise unobservable, which once
 * hid a real-Host shape mismatch from every gate (16.38).
 */
const TRACE = process.env['DSH_DISCORD_TRACE'] === '1'
function trace(...parts: unknown[]): void {
  if (TRACE) console.error('[dsh-discord:trace]', ...parts)
}

/**
 * The turn progress phase rendered as the status line's leading entry
 * (turn-progress-discord-sync): one editable line tracking what the agent
 * is doing right now, so a 30s+ turn is distinguishable from a hung bot.
 */
type ProgressPhase =
  | { kind: 'thinking'; step: number }
  | { kind: 'tool'; label: string; title: string | undefined }
  | { kind: 'writing' }
  | { kind: 'approval' }

interface ThreadRuntime {
  render: ThreadRenderModel
  tools: ToolActivitySurface
  typing: TypingLifecycle
  scheduler: UpdateScheduler | undefined
  /** The activity message's coalescing scheduler (row edits share one edit). */
  activityScheduler: UpdateScheduler | undefined
  finalizer: AnswerFinalizer | undefined
  headMessageId: string | undefined
  activityMessageId: string | undefined
  /**
   * The activity/status send currently in flight, resolving to the message
   * id it created. turn/end awaits it before deleting: a send that lands
   * after the cleanup read `activityMessageId` would otherwise orphan the
   * status message in the thread (the activity-side analog of 16.39).
   */
  activityFlush: Promise<string | undefined> | undefined
  /** Current turn progress phase; undefined outside an active turn. */
  progressPhase: ProgressPhase | undefined
  /** Phase suspended by an approval ask; restored when the ask settles. */
  phaseBeforeApproval: ProgressPhase | undefined
  /**
   * The head flush currently in flight, resolving to the landed head's
   * message id (or undefined when it did not land). The authoritative
   * finalize waits on it — settling the flush before reading
   * `headMessageId` — so the answer EDITS the flushed head instead of
   * racing it with a duplicate second message (16.39).
   */
  headFlush: Promise<string | undefined> | undefined
  /**
   * Step generation fence: bumped on every turn/step boundary. Flushes and
   * finalizers capture it at creation and never mutate the head across a
   * boundary — a late finalize from a superseded step must not re-point the
   * live head at its own (older) message.
   */
  stepSeq: number
  /** The current step's first send is unobservable; never blind-resend it. */
  headAttempted: boolean
  activityAttempted: boolean
  turnId: string | undefined
  /** Safe correlation for tool/result rows: the label stays the call's own. */
  toolNames: Map<string, string>
  /** Host-presented titles by callId (terminal command / call title). */
  toolTitles: Map<string, string>
  /** Last title this thread was renamed to (dedupes repeat projections). */
  lastTitle: string | undefined
  /**
   * Highest journal seq this thread has CONSUMED (delivered frames, switch
   * hit or not — a dropped record is still consumed): the runtime-side view
   * of the render watermark, persisted at turn boundaries (replay-fence D5).
   */
  lastSeq: number
  /**
   * Whether any live-carrier frame has been consumed yet. The initial
   * catch-up window (before this flips) is the only place Discord-originated
   * user input echoes — a fresh resume thread lacks those messages, a live
   * or re-connected thread already shows them as the user's own (D6).
   */
  caughtUp: boolean
}

const ANSWER_MARKER = (interrupted: boolean, marker: string): string => interrupted ? `\n\n${marker}` : ''

/** Pair-safe truncation: never split a surrogate pair at the boundary. */
function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** Extract the visible text of one assistant message (text blocks only). */
function assistantText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
    .map(block => block.text)
    .join('')
}

/** Extract one user message's text (text parts only, newline-joined). */
function userTextParts(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** The callId of a tool/result event (block-carried, defensive). */
function resultCallId(data: Record<string, unknown>): string | undefined {
  if (typeof data['callId'] === 'string') return data['callId']
  const message = data['message'] as { content?: Array<{ type?: unknown; toolCallId?: unknown }> } | undefined
  const block = Array.isArray(message?.content) ? message.content[0] : undefined
  return typeof block?.toolCallId === 'string' ? block.toolCallId : undefined
}

/**
 * The failure flag of a tool/result event. The rc.2 wire carried a top-level
 * `error`; the 0.1.6 journal marks failure on the result block (`isError`).
 */
function resultFailed(data: Record<string, unknown>): boolean {
  if (data['error'] !== undefined) return true
  const message = data['message'] as { content?: Array<{ isError?: unknown }> } | undefined
  const block = Array.isArray(message?.content) ? message.content[0] : undefined
  return block?.isError === true
}

/**
 * The Host presentation view's title for one tool event: a terminal call's
 * title IS the command; generic/diff cards title the call. Host-curated
 * disclosure — never raw arguments.
 */
function presentationTitle(frameView: unknown): string | undefined {
  if (typeof frameView !== 'object' || frameView === null) return undefined
  const view = (frameView as { view?: unknown }).view
  if (typeof view !== 'object' || view === null) return undefined
  const title = (view as { title?: unknown }).title
  return typeof title === 'string' && title !== '' ? title : undefined
}

export function startLiveRender(deps: LiveRenderDeps): {
  dispose(): void
  /** Approval-wait steering for the ask patches (turn-progress spec). */
  setApprovalWait(threadId: string, waiting: boolean): void
} {
  const verbosity = deps.verbosity ?? 'essential-tools'
  const runtimes = new Map<string, ThreadRuntime>()
  const state: { disposed: boolean } = { disposed: false }
  const controller = new AbortController()

  const runtimeFor = (threadId: string): ThreadRuntime => {
    let runtime = runtimes.get(threadId)
    if (runtime !== undefined) return runtime
    runtime = {
      render: createThreadRenderModel(),
      tools: createToolActivitySurface({ verbosity }),
      typing: createTypingLifecycle({
        trigger: () => deps.delivery.typing(threadId),
        intervalMs: deps.typingIntervalMs,
        onFailure: (cause) => { deps.log?.('discord_live_typing_threw', { threadId, cause: String(cause) }) },
      }),
      scheduler: undefined,
      activityScheduler: undefined,
      finalizer: undefined,
      headMessageId: undefined,
      activityMessageId: undefined,
      activityFlush: undefined,
      progressPhase: undefined,
      phaseBeforeApproval: undefined,
      headFlush: undefined,
      stepSeq: 0,
      headAttempted: false,
      activityAttempted: false,
      turnId: undefined,
      toolNames: new Map<string, string>(),
      toolTitles: new Map<string, string>(),
      lastTitle: undefined,
      lastSeq: 0,
      caughtUp: false,
    }
    runtimes.set(threadId, runtime)
    return runtime
  }

  /** Flush the current answer text: create the head once, then edit it. */
  function flushAnswer(threadId: string, runtime: ThreadRuntime): (content: string) => Promise<void> {
    const stepSeq = runtime.stepSeq
    return (content: string): Promise<void> => {
      if (runtime.stepSeq !== stepSeq) return Promise.resolve()
      const payload = buildOutboundMessage({ kind: 'assistant', content })
      const flush = (async (): Promise<string | undefined> => {
        if (runtime.headMessageId === undefined) {
          // An earlier send whose application was unobservable must never be
          // blind-resent (rest.ts contract): the stream pauses here and the
          // finalizer's single fresh send carries the answer instead.
          if (runtime.headAttempted) return undefined
          const sent = await deps.delivery.send({ channelId: threadId, content: payload.content })
          if (sent.outcome === 'completed') {
            runtime.headMessageId = sent.messageId
            return sent.messageId
          }
          if (sent.outcome === 'unknown') {
            runtime.headAttempted = true
            deps.log?.('discord_live_head_send_unknown', { threadId })
          }
          return undefined
        }
        await deps.delivery.edit({ channelId: threadId, messageId: runtime.headMessageId, content: payload.content })
        return runtime.headMessageId
      })()
      runtime.headFlush = flush
      return flush.then(() => undefined)
    }
  }

  function beginTurn(threadId: string, runtime: ThreadRuntime, turnId: string): void {
    runtime.render.beginTurn({ turnId })
    runtime.turnId = turnId
    runtime.headMessageId = undefined
    runtime.activityMessageId = undefined
    runtime.activityFlush = undefined
    runtime.headFlush = undefined
    runtime.headAttempted = false
    runtime.activityAttempted = false
    runtime.stepSeq += 1
    runtime.tools = createToolActivitySurface({ verbosity })
    runtime.toolNames = new Map<string, string>()
    runtime.toolTitles = new Map<string, string>()
    runtime.scheduler?.dispose()
    runtime.scheduler = createUpdateScheduler({
      minIntervalMs: deps.updateIntervalMs,
      onFlush: flushAnswer(threadId, runtime),
      onFlushError: (cause) => { deps.log?.('discord_live_flush_failed', { threadId, cause: String(cause) }) },
    })
    // The activity message's own coalescer: row changes share one edit per
    // interval, so parallel tools cannot exceed the channel's edit budget.
    runtime.activityScheduler?.dispose()
    runtime.activityScheduler = createUpdateScheduler({
      minIntervalMs: deps.activityCoalesceMs ?? DEFAULT_ACTIVITY_COALESCE_MS,
      onFlush: renderActivity(threadId, runtime),
      onFlushError: (cause) => { deps.log?.('discord_live_activity_flush_failed', { threadId, cause: String(cause) }) },
    })
    runtime.finalizer = undefined
    // The status line opens the turn in the thinking phase (spec
    // turn-progress: the message exists from turn/start, before any tool).
    runtime.progressPhase = { kind: 'thinking', step: 1 }
    runtime.phaseBeforeApproval = undefined
    // A fresh lifecycle per turn: start() no-ops on a stopped one, so a
    // second turn in the same thread would otherwise never type again.
    runtime.typing.dispose()
    runtime.typing = createTypingLifecycle({
      trigger: () => deps.delivery.typing(threadId),
      intervalMs: deps.typingIntervalMs,
      onFailure: (cause) => { deps.log?.('discord_live_typing_threw', { threadId, cause: String(cause) }) },
    })
    runtime.typing.start()
    runtime.activityScheduler.schedule(renderActivityContent(runtime))
  }

  /** The status line's phase entry (undefined when copy is not provided). */
  function progressPhaseLine(runtime: ThreadRuntime): string | undefined {
    const copy = deps.progressCopy?.()
    if (copy === undefined || runtime.progressPhase === undefined) return undefined
    const phase = runtime.progressPhase
    switch (phase.kind) {
      case 'thinking': return phase.step > 1 ? copy.thinkingStep(phase.step) : copy.thinking
      case 'tool': return `💻 ${truncateText(phase.title ?? phase.label, ACTIVITY_TITLE_MAX)}`
      case 'writing': return copy.writing
      case 'approval': return copy.approvalWait
    }
  }

  /**
   * The turn's collapsed one-line summary (decision 5): the durable trace a
   * finished turn leaves behind. Undefined when the turn ran no tools —
   * those keep the pure Q&A thread and the message is deleted instead.
   */
  function renderTurnSummary(rows: ToolRow[]): string | undefined {
    const copy = deps.progressCopy?.()
    if (copy === undefined || rows.length === 0) return undefined
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(row.label, (counts.get(row.label) ?? 0) + 1)
    const breakdown = truncateText([...counts.entries()].map(([label, n]) => `${label} ×${String(n)}`).join(' · '), 200)
    const failed = rows.filter(row => row.state === 'failed').length
    return copy.turnSummary(rows.length, failed, breakdown)
  }

  /** The activity message body: phase line, then one icon + title per call row. */
  function renderActivityContent(runtime: ThreadRuntime): string {
    const rows = runtime.tools.render()
    const rowLines = rows.map(row => {
      const title = truncateText(row.title ?? row.label, ACTIVITY_TITLE_MAX)
      const mark = row.state === 'succeeded' ? '✓ ' : row.state === 'failed' ? '✗ ' : ''
      return `> ${mark}${toolCategoryIcon(row.label)} ${title}`
    })
    const phaseLine = progressPhaseLine(runtime)
    return phaseLine === undefined ? rowLines.join('\n') : [phaseLine, ...rowLines].join('\n')
  }

  /** Render the tool rows into one bounded activity message (create once, edit after). */
  function renderActivity(threadId: string, runtime: ThreadRuntime): () => Promise<void> {
    return async () => {
      if (runtime.tools.render().length === 0 && progressPhaseLine(runtime) === undefined) return
      // The flush promise records the message id it created so turn/end's
      // cleanup can delete a send that is still in flight (orphan guard).
      const flush = (async (): Promise<string | undefined> => {
        // Tool titles are Host-presented free text (terminal commands): they
        // go through the same outbound builder as every other message path.
        const payload = buildOutboundMessage({ kind: 'tool', content: renderActivityContent(runtime) })
        if (runtime.activityMessageId === undefined) {
          if (runtime.activityAttempted) return undefined
          const sent = await deps.delivery.send({ channelId: threadId, content: payload.content })
          if (sent.outcome === 'completed') {
            runtime.activityMessageId = sent.messageId
            return sent.messageId
          }
          if (sent.outcome === 'unknown') {
            runtime.activityAttempted = true
            deps.log?.('discord_live_activity_send_unknown', { threadId })
          }
          return undefined
        }
        await deps.delivery.edit({ channelId: threadId, messageId: runtime.activityMessageId, content: payload.content })
        return undefined
      })()
      runtime.activityFlush = flush
      await flush
    }
  }

  /**
   * User-input echo (replay-fence D6): mirror one human `user/message` into
   * the thread as one quoted bot message. Filter matrix:
   * - `source.kind !== 'user'` (plugin/system injections): never renders,
   *   and none of its content is disclosed.
   * - Discord-originated input (`source.rpcId` = `discord:<messageId>`):
   *   already the user's own message in the thread — echoes only during a
   *   fresh runtime's initial catch-up (resume into a new thread); live
   *   frames and post-catch-up snapshots skip it.
   */
  function echoUserInput(
    threadId: string,
    runtime: ThreadRuntime,
    data: Record<string, unknown>,
    event: { carrier?: 'snapshot' | 'live' },
  ): void {
    const copy = deps.userEchoCopy?.()
    if (copy === undefined) return
    const source = data['source']
    if (typeof source !== 'object' || source === null) return
    const { kind, rpcId } = source as { kind?: unknown; rpcId?: unknown }
    if (kind !== 'user') return
    const fromDiscord = typeof rpcId === 'string' && rpcId.startsWith('discord:')
    if (fromDiscord && (event.carrier === 'live' || runtime.caughtUp)) return
    const text = userTextParts(data['content'])
    const body = text === ''
      ? copy.nonText
      : text.length <= USER_ECHO_MAX
        ? text
        : `${truncateText(text, USER_ECHO_MAX)} ${copy.truncated}`
    const quoted = body.split('\n').map(line => `> ${line}`).join('\n')
    const payload = buildOutboundMessage({ kind: 'user', content: `${copy.label}\n${quoted}` })
    void deps.delivery.send({ channelId: threadId, content: payload.content }).then(sent => {
      if (sent.outcome !== 'completed') {
        deps.log?.('discord_live_user_echo_failed', { threadId, outcome: sent.outcome })
      }
    }).catch((cause: unknown) => {
      deps.log?.('discord_live_user_echo_threw', { threadId, cause: String(cause) })
    })
  }

  function handleSessionEvent(
    sessionId: string,
    threadId: string,
    runtime: ThreadRuntime,
    event: { type: string; data: Record<string, unknown>; seq?: number; carrier?: 'snapshot' | 'live' },
    frameView: unknown,
  ): void {
    const data = event.data
    if (TRACE) trace('handleSessionEvent', event.type, 'keys:', Object.keys(data).join(','))
    // Watermark bookkeeping BEFORE any branch (replay-fence D5): a record
    // that falls through the switch is still consumed — the persisted
    // watermark must never claim less than what was delivered.
    if (typeof event.seq === 'number' && event.seq > runtime.lastSeq) runtime.lastSeq = event.seq
    if (event.carrier === 'live') runtime.caughtUp = true
    const turnId = typeof data['turn'] === 'number' ? String(data['turn']) : undefined
    const stepId = typeof data['step'] === 'number' ? String(data['step']) : undefined
    switch (event.type) {
      case 'user/message': {
        echoUserInput(threadId, runtime, data, event)
        return
      }
      case 'turn/start': {
        if (typeof turnId !== 'string') return
        beginTurn(threadId, runtime, turnId)
        return
      }
      case 'step/start': {
        if (turnId !== undefined && stepId !== undefined) runtime.render.beginStep({ turnId, stepId })
        // A new step opens a NEW logical answer message: the previous
        // step's completed head is never overwritten (stream-renderer spec).
        runtime.headMessageId = undefined
        runtime.headFlush = undefined
        runtime.headAttempted = false
        runtime.stepSeq += 1
        // A step boundary is a thinking boundary: the model is reasoning
        // about the previous step's results before the next tool call.
        // The journal's own step number is the display truth (stepSeq is a
        // generation fence that also bumps at the turn boundary).
        runtime.progressPhase = { kind: 'thinking', step: typeof data['step'] === 'number' ? data['step'] : runtime.stepSeq }
        // The previous step's finalize disposed the scheduler; a fresh one
        // carries the new step's chunk coalescing.
        runtime.scheduler?.dispose()
        runtime.scheduler = createUpdateScheduler({
          minIntervalMs: deps.updateIntervalMs,
          onFlush: flushAnswer(threadId, runtime),
          onFlushError: (cause) => { deps.log?.('discord_live_flush_failed', { threadId, cause: String(cause) }) },
        })
        runtime.activityScheduler?.schedule(renderActivityContent(runtime))
        return
      }
      case 'assistant/chunk': {
        if (runtime.scheduler === undefined || turnId === undefined || stepId === undefined) {
          trace('chunk dropped (no turn/step/scheduler)', event.type, turnId, stepId)
          return
        }
        const chunk = data['chunk'] as { type?: unknown; text?: unknown } | undefined
        if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') {
          trace('chunk not text-delta:', String(chunk?.type))
          return
        }
        runtime.render.appendDelta({ turnId, stepId, text: chunk.text })
        const snapshot = runtime.render.snapshot()
        const current = snapshot.answers.find(answer => answer.stepId === stepId)
        if (current !== undefined) runtime.scheduler.schedule(current.text)
        return
      }
      case 'assistant/message': {
        if (turnId === undefined || stepId === undefined) return
        const interrupted = data['interrupted'] === true
        const text = assistantText(data['message'])
        trace('assistant/message: extracted text length', text.length, 'interrupted:', interrupted)
        runtime.render.setAuthoritative({ turnId, stepId, text })
        if (interrupted) runtime.render.interrupt({ turnId, stepId })
        // The step's answer is committed: the agent is writing its reply.
        runtime.progressPhase = { kind: 'writing' }
        runtime.activityScheduler?.schedule(renderActivityContent(runtime))
        runtime.scheduler?.dispose()
        runtime.scheduler = undefined
        if (text === '') return
        // The authoritative finalize sends exactly once per turn answer. It
        // runs detached AFTER the in-flight head flush settles: racing the
        // flush would read `headMessageId` before the flushed send landed
        // and post the answer as a duplicate second message (16.39). The
        // step fence is read post-settle for the same reason.
        const pendingFlush = Promise.resolve(runtime.headFlush).catch(() => undefined)
        void pendingFlush.then((inFlightHead) => {
          const finalizedStepSeq = runtime.stepSeq
          const finalizer = createAnswerFinalizer({
            delivery: {
              editHead: async ({ messageId, content }) => {
                const payload = buildOutboundMessage({ kind: 'assistant', content })
                // No head exists (text arrived without flushed chunks): the
                // first finalize send IS the head, recorded for continuations.
                if (messageId === '') {
                  const sent = await deps.delivery.send({ channelId: threadId, content: payload.content })
                  if (sent.outcome === 'completed') {
                    if (runtime.stepSeq === finalizedStepSeq && runtime.headMessageId === undefined) {
                      runtime.headMessageId = sent.messageId
                    }
                    return { outcome: 'completed' as const }
                  }
                  return { outcome: 'failed' as const }
                }
                const edited = await deps.delivery.edit({ channelId: threadId, messageId, content: payload.content })
                return edited.outcome === 'completed' ? { outcome: 'completed' } : { outcome: 'failed' }
              },
              sendContinuation: async ({ content }) => {
                const payload = buildOutboundMessage({ kind: 'assistant', content })
                const sent = await deps.delivery.send({ channelId: threadId, content: payload.content })
                return sent.outcome === 'completed' ? { outcome: 'completed' } : { outcome: 'failed' }
              },
            },
            headMessageId: inFlightHead ?? runtime.headMessageId ?? '',
          })
          const finalText = text + ANSWER_MARKER(interrupted, deps.interruptedMarker?.() ?? '*（已被中断）*')
          return finalizer.finalize(finalText)
        }).catch((cause: unknown) => {
          deps.log?.('discord_live_finalize_threw', { threadId, cause: String(cause) })
        })
        return
      }
      case 'tool/call': {
        if (typeof data['callId'] !== 'string' || typeof data['name'] !== 'string') return
        const rawArguments = typeof data['arguments'] === 'string' ? data['arguments'] : undefined
        const title = presentationTitle(frameView) ?? shellCommandTitle(data['name'], rawArguments)
        runtime.toolNames.set(data['callId'], data['name'])
        if (title !== undefined) runtime.toolTitles.set(data['callId'], title)
        // The status line tracks the most recent call as the running phase.
        runtime.progressPhase = { kind: 'tool', label: data['name'], title }
        runtime.tools.record({
          callId: data['callId'],
          toolName: data['name'],
          state: 'running',
          title,
          rawArguments,
        })
        runtime.activityScheduler?.schedule(renderActivityContent(runtime))
        return
      }
      case 'tool/result': {
        const callId = resultCallId(data)
        if (callId === undefined) return
        const failed = resultFailed(data)
        runtime.tools.record({
          callId,
          toolName: runtime.toolNames.get(callId) ?? 'tool',
          state: failed ? 'failed' : 'succeeded',
          title: runtime.toolTitles.get(callId),
        })
        runtime.activityScheduler?.schedule(renderActivityContent(runtime))
        return
      }
      case 'turn/end': {
        runtime.typing.stop('completed')
        runtime.scheduler?.dispose()
        runtime.scheduler = undefined
        runtime.activityScheduler?.dispose()
        runtime.activityScheduler = undefined
        runtime.progressPhase = undefined
        runtime.phaseBeforeApproval = undefined
        // The activity message collapses at turn end (decision 5): a turn
        // that ran tools is EDITED into its one-line summary — the durable
        // process trace — while a zero-tool turn keeps the pure Q&A thread
        // and is deleted. A send still in flight when the cleanup ran would
        // orphan the message, so the collapse waits for the flush to settle
        // first (stepSeq fences a turn that began meanwhile: its message
        // owns the slot and must survive).
        const epochAtEnd = runtime.stepSeq
        const settledId = runtime.activityMessageId
        runtime.activityMessageId = undefined
        const summary = renderTurnSummary(runtime.tools.render())
        const pendingActivityFlush = Promise.resolve(runtime.activityFlush).catch(() => undefined)
        void pendingActivityFlush.then(flushedId => {
          const id = runtime.activityMessageId ?? settledId ?? flushedId
          if (id === undefined || runtime.stepSeq !== epochAtEnd) return
          runtime.activityMessageId = undefined
          if (summary !== undefined) {
            const payload = buildOutboundMessage({ kind: 'tool', content: summary })
            void deps.delivery.edit({ channelId: threadId, messageId: id, content: payload.content }).catch((cause: unknown) => {
              deps.log?.('discord_live_activity_summary_edit_threw', { threadId, cause: String(cause) })
            })
            return
          }
          void deps.delivery.delete({ channelId: threadId, messageId: id }).catch((cause: unknown) => {
            deps.log?.('discord_live_activity_delete_threw', { threadId, cause: String(cause) })
          })
        })
        // Watermark persist rides the same boundary (replay-fence D5): the
        // consumed high-water seq at turn end becomes the durable floor the
        // next process's catch-up seeds from.
        deps.onTurnEnded?.(sessionId, { threadId, renderedSeq: runtime.lastSeq })
        return
      }
      default:
        return
    }
  }

  /** A bounded one-line summary of a queued message: text blocks only. */
  function queueSummary(item: unknown): { id: string; summary: string } {
    const record = (typeof item === 'object' && item !== null ? item : {}) as { id?: unknown; message?: { content?: unknown } }
    const id = typeof record.id === 'string' ? record.id : ''
    const content = Array.isArray(record.message?.content) ? record.message.content : []
    const text = truncateText(
      content
        .filter((block): block is { type: 'text'; text: string } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
        .map(block => block.text)
        .join(' '),
      120,
    )
    return { id, summary: text === '' ? '（非文本消息）' : text }
  }

  function handleFrame(raw: unknown): void {
    const frame = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const type = frame['type']
    const sessionId = typeof frame['sessionId'] === 'string' ? frame['sessionId'] : undefined
    if (typeof type !== 'string' || sessionId === undefined) return
    if (type === 'session/queue') {
      const items = Array.isArray(frame['items']) ? frame['items'] : []
      deps.onQueueSnapshot?.(sessionId, items.map(item => queueSummary(item)))
      // Admission-time typing: typing starts when the prompt is
      // ENQUEUED — covering the queue wait, agent startup, and first-token
      // latency before the first turn event — and stops when the queue
      // drains with no turn open (never wedges the indicator on).
      const threadId = deps.threadForSession(sessionId)
      if (threadId === undefined) return
      const runtime = runtimeFor(threadId)
      if (items.length > 0) {
        runtime.typing.start()
        return
      }
      if (!runtime.render.snapshot().turnOpen) runtime.typing.stop()
      return
    }
    if (type === 'session/projection') {
      // DSH's model-generated session title (from the user's first input):
      // rename the thread once per distinct title.
      if (frame['key'] !== 'title') return
      const title = frame['value']
      if (typeof title !== 'string' || title === '') return
      const threadId = deps.threadForSession(sessionId)
      if (threadId === undefined) return
      const runtime = runtimeFor(threadId)
      const name = safeTitle(title)
      if (name === '' || name === runtime.lastTitle) return
      runtime.lastTitle = name
      // Cold dedupe state after a restart: confirm the thread's wire name
      // before PATCHing — Discord throttles renames hard (~2 per 10 min),
      // and an unchanged session must not burn one on a no-op. Both sides
      // are slugified: Discord stores names lowercased and dashed, so a
      // raw comparison would report a false difference on every restart.
      const renameNeeded = deps.threadName === undefined ? Promise.resolve(true)
        : deps.threadName(threadId).then(
            (current) => current === undefined || discordChannelNameKey(current) !== discordChannelNameKey(name),
          ).catch(() => true)
      void renameNeeded.then((needed) => {
        if (!needed) return
        return deps.delivery.renameThread({ channelId: threadId, name }).then((result) => {
          if (result.outcome !== 'completed') {
            deps.log?.('discord_live_rename_failed', { threadId, name })
          }
        })
      }).catch((cause: unknown) => {
        deps.log?.('discord_live_rename_threw', { threadId, cause: String(cause) })
      })
      return
    }
    // Answerable asks no longer ride the frame stream: the 0.1.6 host routes
    // them through the composed-answerer waterfalls (src/dsh/host-asks.ts).
    if (type !== 'session/event') return
    const threadId = deps.threadForSession(sessionId)
    if (threadId === undefined) {
      trace('drop: no thread for session', sessionId)
      return
    }
    const eventWrapper = frame['event'] as { type?: unknown; data?: Record<string, unknown> } | undefined
    if (eventWrapper === undefined || typeof eventWrapper.type !== 'string') {
      trace('drop: session/event without event wrapper', JSON.stringify(frame).slice(0, 200))
      return
    }
    const frameSeq = frame['seq']
    const frameCarrier = frame['carrier']
    handleSessionEvent(sessionId, threadId, runtimeFor(threadId), {
      type: eventWrapper.type,
      data: eventWrapper.data ?? {},
      ...(typeof frameSeq === 'number' ? { seq: frameSeq } : {}),
      ...(frameCarrier === 'snapshot' || frameCarrier === 'live' ? { carrier: frameCarrier } : {}),
    }, frame['view'])
  }

  async function runLoop(): Promise<void> {
    // Bounded reopen loop: the mux stream is the live accelerator; a dropped
    // stream reopens after backoff while reconciliation covers the gap.
    // The flag is read through a call: dispose() mutates it asynchronously.
    let backoffMs = 1_000
    const isDisposed = (): boolean => state.disposed
    while (!isDisposed()) {
      try {
        for await (const frame of deps.frames(controller.signal)) {
          if (isDisposed()) return
          try {
            if (TRACE) {
              const t = (typeof frame === 'object' && frame !== null ? (frame as { type?: unknown }).type : undefined)
              const sid = (typeof frame === 'object' && frame !== null ? (frame as { sessionId?: unknown }).sessionId : undefined)
              trace('frame', String(t), String(sid))
            }
            handleFrame(frame)
          } catch (cause) {
            deps.log?.('discord_live_frame_threw', { cause: String(cause) })
          }
        }
        backoffMs = 1_000
      } catch (cause) {
        if (isDisposed()) return
        deps.log?.('discord_live_stream_error', { cause: String(cause) })
        trace('stream closed:', String(cause))
      }
      if (isDisposed()) return
      await new Promise(resolve => { setTimeout(resolve, backoffMs) })
      backoffMs = Math.min(backoffMs * 2, 30_000)
    }
  }

  void runLoop()

  return {
    dispose() {
      state.disposed = true
      controller.abort()
      for (const runtime of runtimes.values()) {
        runtime.scheduler?.dispose()
        runtime.activityScheduler?.dispose()
        runtime.typing.dispose()
      }
      runtimes.clear()
    },
    /**
     * Approval-wait steering for the ask patches (turn-progress spec): a
     * claimed ask suspends the status line on the wait phase; settling
     * restores the suspended phase so progress tracking resumes.
     */
    setApprovalWait(threadId: string, waiting: boolean): void {
      if (state.disposed) return
      const runtime = runtimes.get(threadId)
      if (runtime === undefined) return
      if (waiting) {
        if (runtime.progressPhase?.kind === 'approval') return
        runtime.phaseBeforeApproval = runtime.progressPhase
        runtime.progressPhase = { kind: 'approval' }
      } else {
        if (runtime.progressPhase?.kind !== 'approval') return
        runtime.progressPhase = runtime.phaseBeforeApproval
        runtime.phaseBeforeApproval = undefined
      }
      runtime.activityScheduler?.schedule(renderActivityContent(runtime))
    },
  }
}
