/**
 * Live render wiring (Phase 1): the DSH events.mux stream drives per-thread
 * render state into Discord delivery. Each bound session thread owns one
 * runtime — render model, update scheduler, typing lifecycle, tool activity
 * surface, and the turn's head message. Frames for sessions with no bound
 * thread are dropped (reconciliation owns recovery, not the live path);
 * `assistant/message` finalizes exactly once with ordered continuations;
 * `turn/end` stops typing and releases the adapter-owned turn.
 */

import { createThreadRenderModel, type ThreadRenderModel } from './render-model.js'
import { createUpdateScheduler, type UpdateScheduler } from './update-scheduler.js'
import { createTypingLifecycle, type TypingLifecycle } from './typing.js'
import { createToolActivitySurface, type ToolActivitySurface } from './tool-view.js'
import { createAnswerFinalizer, type AnswerFinalizer } from './finalizer.js'
import { buildOutboundMessage } from './outbound.js'
import { toolCategoryIcon, toolStateIcon } from './icons.js'
import { safeTitle } from '../policy/disclosure.js'
import type { DiscordVerbosity } from '../settings.js'

/** The mux frames the live path consumes (narrow, defensive shape). */
export type LiveFrame =
  | { type: 'session/event'; sessionId: string; event: { type: string; data: Record<string, unknown> } }
  | { type: 'session/subscribed'; sessionId: string }
  | { type: 'session/queue'; sessionId: string; items: Array<{ id: string; summary: string }> }
  | { type: string }

/** The Discord delivery face the live renderer needs. */
export interface LiveDeliveryPort {
  send(request: { channelId: string; content: string }): Promise<
    | { outcome: 'completed'; messageId: string }
    | { outcome: 'failed' }
  >
  edit(request: { channelId: string; messageId: string; content: string }): Promise<
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
  updateIntervalMs: number
  typingIntervalMs: number
  verbosity?: DiscordVerbosity
  log?: (event: string, detail?: unknown) => void
  /** Queue snapshot cache (the /queue surface's data source). */
  onQueueSnapshot?: (sessionId: string, items: Array<{ id: string; summary: string }>) => void
  /** Turn ownership release on turn/end. */
  onTurnEnded?: (sessionId: string) => void
}

interface ThreadRuntime {
  render: ThreadRenderModel
  tools: ToolActivitySurface
  typing: TypingLifecycle
  scheduler: UpdateScheduler | undefined
  finalizer: AnswerFinalizer | undefined
  headMessageId: string | undefined
  activityMessageId: string | undefined
  turnId: string | undefined
  /** Safe correlation for tool/result rows: the label stays the call's own. */
  toolNames: Map<string, string>
  /** Last title this thread was renamed to (dedupes repeat projections). */
  lastTitle: string | undefined
}

const ANSWER_MARKER = (interrupted: boolean): string => interrupted ? '\n\n*（已被中断）*' : ''

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

/** The callId of a tool/result event (block-carried, defensive). */
function resultCallId(data: Record<string, unknown>): string | undefined {
  if (typeof data['callId'] === 'string') return data['callId']
  const message = data['message'] as { content?: Array<{ type?: unknown; callId?: unknown }> } | undefined
  const block = Array.isArray(message?.content) ? message.content[0] : undefined
  return typeof block?.callId === 'string' ? block.callId : undefined
}

export function startLiveRender(deps: LiveRenderDeps): { dispose(): void } {
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
      }),
      scheduler: undefined,
      finalizer: undefined,
      headMessageId: undefined,
      activityMessageId: undefined,
      turnId: undefined,
      toolNames: new Map<string, string>(),
      lastTitle: undefined,
    }
    runtimes.set(threadId, runtime)
    return runtime
  }

  /** Flush the current answer text: create the head once, then edit it. */
  function flushAnswer(threadId: string, runtime: ThreadRuntime): (content: string) => Promise<void> {
    return async (content: string) => {
      const payload = buildOutboundMessage({ kind: 'assistant', content })
      if (runtime.headMessageId === undefined) {
        const sent = await deps.delivery.send({ channelId: threadId, content: payload.content })
        if (sent.outcome === 'completed') runtime.headMessageId = sent.messageId
        return
      }
      await deps.delivery.edit({ channelId: threadId, messageId: runtime.headMessageId, content: payload.content })
    }
  }

  function beginTurn(threadId: string, runtime: ThreadRuntime, turnId: string): void {
    runtime.render.beginTurn({ turnId })
    runtime.turnId = turnId
    runtime.headMessageId = undefined
    runtime.activityMessageId = undefined
    runtime.tools = createToolActivitySurface({ verbosity })
    runtime.toolNames = new Map<string, string>()
    runtime.scheduler?.dispose()
    runtime.scheduler = createUpdateScheduler({
      minIntervalMs: deps.updateIntervalMs,
      onFlush: flushAnswer(threadId, runtime),
    })
    runtime.finalizer = undefined
    // A fresh lifecycle per turn: start() no-ops on a stopped one, so a
    // second turn in the same thread would otherwise never type again.
    runtime.typing.dispose()
    runtime.typing = createTypingLifecycle({
      trigger: () => deps.delivery.typing(threadId),
      intervalMs: deps.typingIntervalMs,
    })
    runtime.typing.start()
  }

  /** Render the tool rows into one bounded activity message (create once, edit after). */
  async function renderActivity(threadId: string, runtime: ThreadRuntime): Promise<void> {
    const rows = runtime.tools.render()
    if (rows.length === 0) return
    const content = rows.map(row => {
      const marks = [toolStateIcon(row.state), toolCategoryIcon(row.label)].filter(Boolean)
      return `> ${marks.join(' ')} ${row.label}`
    }).join('\n')
    if (runtime.activityMessageId === undefined) {
      const sent = await deps.delivery.send({ channelId: threadId, content })
      if (sent.outcome === 'completed') runtime.activityMessageId = sent.messageId
      return
    }
    await deps.delivery.edit({ channelId: threadId, messageId: runtime.activityMessageId, content })
  }

  function handleSessionEvent(sessionId: string, threadId: string, runtime: ThreadRuntime, event: { type: string; data: Record<string, unknown> }): void {
    const data = event.data
    const turnId = typeof data['turn'] === 'number' ? String(data['turn']) : undefined
    const stepId = typeof data['step'] === 'number' ? String(data['step']) : undefined
    switch (event.type) {
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
        // The previous step's finalize disposed the scheduler; a fresh one
        // carries the new step's chunk coalescing.
        runtime.scheduler?.dispose()
        runtime.scheduler = createUpdateScheduler({
          minIntervalMs: deps.updateIntervalMs,
          onFlush: flushAnswer(threadId, runtime),
        })
        return
      }
      case 'assistant/chunk': {
        if (runtime.scheduler === undefined || turnId === undefined || stepId === undefined) return
        const chunk = data['chunk'] as { type?: unknown; text?: unknown } | undefined
        if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return
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
        runtime.render.setAuthoritative({ turnId, stepId, text })
        if (interrupted) runtime.render.interrupt({ turnId, stepId })
        runtime.scheduler?.dispose()
        runtime.scheduler = undefined
        if (text === '') return
        // The authoritative finalize sends exactly once per turn answer.
        runtime.finalizer = createAnswerFinalizer({
          delivery: {
            editHead: async ({ messageId, content }) => {
              const payload = buildOutboundMessage({ kind: 'assistant', content })
              // No head exists (text arrived without flushed chunks): the
              // first finalize send IS the head, recorded for continuations.
              if (messageId === '') {
                const sent = await deps.delivery.send({ channelId: threadId, content: payload.content })
                if (sent.outcome === 'completed') {
                  runtime.headMessageId = sent.messageId
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
          headMessageId: runtime.headMessageId ?? '',
        })
        const finalText = text + ANSWER_MARKER(interrupted)
        void runtime.finalizer.finalize(finalText).catch((cause: unknown) => {
          deps.log?.('discord_live_finalize_threw', { threadId, cause: String(cause) })
        })
        return
      }
      case 'tool/call': {
        if (typeof data['callId'] !== 'string' || typeof data['name'] !== 'string') return
        runtime.toolNames.set(data['callId'], data['name'])
        runtime.tools.record({ callId: data['callId'], toolName: data['name'], state: 'running', rawArguments: typeof data['arguments'] === 'string' ? data['arguments'] : undefined })
        void renderActivity(threadId, runtime)
        return
      }
      case 'tool/result': {
        const callId = resultCallId(data)
        if (callId === undefined) return
        const failed = data['error'] !== undefined
        runtime.tools.record({ callId, toolName: runtime.toolNames.get(callId) ?? 'tool', state: failed ? 'failed' : 'succeeded' })
        void renderActivity(threadId, runtime)
        return
      }
      case 'turn/end': {
        runtime.typing.stop('completed')
        runtime.scheduler?.dispose()
        runtime.scheduler = undefined
        deps.onTurnEnded?.(sessionId)
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
    const text = content
      .filter((block): block is { type: 'text'; text: string } =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
      .map(block => block.text)
      .join(' ')
      .slice(0, 120)
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
      // Kimaki admission-time typing: typing starts when the prompt is
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
      // rename the thread once per distinct title, Kimaki-style.
      if (frame['key'] !== 'title') return
      const title = frame['value']
      if (typeof title !== 'string' || title === '') return
      const threadId = deps.threadForSession(sessionId)
      if (threadId === undefined) return
      const runtime = runtimeFor(threadId)
      const name = safeTitle(title)
      if (name === '' || name === runtime.lastTitle) return
      runtime.lastTitle = name
      void deps.delivery.renameThread({ channelId: threadId, name }).then((result) => {
        if (result.outcome !== 'completed') {
          deps.log?.('discord_live_rename_failed', { threadId, name })
        }
      }).catch((cause: unknown) => {
        deps.log?.('discord_live_rename_threw', { threadId, cause: String(cause) })
      })
      return
    }
    if (type !== 'session/event') return
    const threadId = deps.threadForSession(sessionId)
    if (threadId === undefined) return
    const eventWrapper = frame['event'] as { type?: unknown; data?: Record<string, unknown> } | undefined
    if (eventWrapper === undefined || typeof eventWrapper.type !== 'string') return
    handleSessionEvent(sessionId, threadId, runtimeFor(threadId), { type: eventWrapper.type, data: eventWrapper.data ?? {} })
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
            const payload = (typeof frame === 'object' && frame !== null && 'payload' in frame)
              ? (frame as { payload?: unknown }).payload
              : frame
            handleFrame(payload)
          } catch (cause) {
            deps.log?.('discord_live_frame_threw', { cause: String(cause) })
          }
        }
        backoffMs = 1_000
      } catch (cause) {
        if (isDisposed()) return
        deps.log?.('discord_live_stream_error', { cause: String(cause) })
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
        runtime.typing.dispose()
      }
      runtimes.clear()
    },
  }
}
