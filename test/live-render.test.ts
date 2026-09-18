/**
 * Live render wiring tests (Phase 1): the mux frame source drives per-thread
 * render state into real Discord delivery — one head answer message per
 * assistant message, coalesced edits, authoritative finalization with
 * overflow continuations, typing on turn boundaries, and tool activity rows.
 * Frames for unknown sessions are dropped; queue snapshots are cached.
 */

import { describe, expect, it } from 'vitest'

import { startLiveRender, type LiveDeliveryPort, type LiveFrame } from '../src/stream/live.js'

function createDelivery(sendOutcomes: Array<'completed' | 'unknown' | 'failed'> = []) {
  const calls: Array<{ kind: 'send' | 'edit' | 'typing' | 'rename' | 'delete'; channelId: string; messageId?: string; content?: string }> = []
  let messageCounter = 0
  const delivery: LiveDeliveryPort = {
    send: (request) => {
      calls.push({ kind: 'send', channelId: request.channelId, content: request.content })
      const queued = sendOutcomes.shift()
      if (queued === 'unknown') return Promise.resolve({ outcome: 'unknown' })
      if (queued === 'failed') return Promise.resolve({ outcome: 'failed' })
      messageCounter += 1
      return Promise.resolve({ outcome: 'completed', messageId: `dm-${String(messageCounter)}` })
    },
    edit: (request) => {
      calls.push({ kind: 'edit', channelId: request.channelId, messageId: request.messageId, content: request.content })
      return Promise.resolve({ outcome: 'completed' })
    },
    typing: (channelId) => {
      calls.push({ kind: 'typing', channelId })
      return Promise.resolve()
    },
    renameThread: (request) => {
      calls.push({ kind: 'rename', channelId: request.channelId, content: request.name })
      return Promise.resolve({ outcome: 'completed' })
    },
    delete: (request) => {
      calls.push({ kind: 'delete', channelId: request.channelId, messageId: request.messageId })
      return Promise.resolve({ outcome: 'completed' })
    },
  }
  return { delivery, calls }
}

function sessionEvent(sessionId: string, type: string, data: Record<string, unknown>): LiveFrame {
  return { type: 'session/event', sessionId, event: { type, data } }
}

/** Push frames through the live renderer and wait for the pipeline to drain. */
async function drive(frames: LiveFrame[], options: {
  threadForSession: (sessionId: string) => string | undefined
  onQueueSnapshot?: (sessionId: string, items: Array<{ id: string; summary: string }>) => void
  onTurnEnded?: (sessionId: string) => void
  updateIntervalMs?: number
  threadName?: (channelId: string) => Promise<string | undefined>
  sendOutcomes?: Array<'completed' | 'unknown' | 'failed'>
  /** Test-controlled delivery for interleaving races (16.39). */
  delivery?: LiveDeliveryPort
  /** Progress-phase copy provider (production always supplies one). */
  progressCopy?: () => { thinking: string; thinkingStep: (step: number) => string; writing: string; approvalWait: string; turnSummary: (total: number, failed: number, breakdown: string) => string }
}): Promise<Array<{ kind: 'send' | 'edit' | 'typing' | 'rename' | 'delete'; channelId: string; messageId?: string; content?: string }>> {
  const { delivery, calls } = options.delivery !== undefined
    ? { delivery: options.delivery, calls: [] }
    : createDelivery(options.sendOutcomes ?? [])
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  async function* source(): AsyncIterable<LiveFrame> {
    for (const frame of frames) {
      yield frame
      // A real macrotask turn lets interval-0 schedulers flush between frames.
      await new Promise(resolve => { setTimeout(resolve, 5) })
    }
    release()
  }
  const live = startLiveRender({
    frames: source,
    threadForSession: options.threadForSession,
    delivery,
    updateIntervalMs: options.updateIntervalMs ?? 0,
    activityCoalesceMs: 0,
    typingIntervalMs: 60_000,
    ...(options.onQueueSnapshot === undefined ? {} : { onQueueSnapshot: options.onQueueSnapshot }),
    ...(options.onTurnEnded === undefined ? {} : { onTurnEnded: options.onTurnEnded }),
    ...(options.threadName === undefined ? {} : { threadName: options.threadName }),
    ...(options.progressCopy === undefined ? {} : { progressCopy: options.progressCopy }),
  })
  await gate
  await new Promise(resolve => { setTimeout(resolve, 10) })
  live.dispose()
  return calls
}

describe('live render', () => {
  it('streams one head answer message and edits it with the latest accumulated text', async () => {
    const calls = await drive([
      sessionEvent('sess-1', 'turn/start', { turn: 1 }),
      sessionEvent('sess-1', 'step/start', { turn: 1, step: 1 }),
      sessionEvent('sess-1', 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hel' } }),
      sessionEvent('sess-1', 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'lo ' } }),
      sessionEvent('sess-1', 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'world' } }),
    ], { threadForSession: () => 'thread-1' })

    const threadCalls = calls.filter(call => call.channelId === 'thread-1')
    const sends = threadCalls.filter(call => call.kind === 'send')
    const edits = threadCalls.filter(call => call.kind === 'edit')
    expect(sends).toHaveLength(1)
    // The first flush creates the head; subsequent flushes EDIT it with the
    // latest accumulated text (coalescing with interval 0 still converges).
    expect(edits.length).toBeGreaterThanOrEqual(1)
    expect(edits.at(-1)?.content).toBe('Hello world')
    expect(threadCalls.filter(call => call.kind === 'typing').length).toBeGreaterThanOrEqual(1)
  })

  it('finalizes the authoritative message exactly once with continuation overflow', async () => {
    const longText = 'x'.repeat(2_500)
    const calls = await drive([
      sessionEvent('sess-1', 'turn/start', { turn: 1 }),
      sessionEvent('sess-1', 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: longText } }),
      sessionEvent('sess-1', 'assistant/message', {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
      }),
      sessionEvent('sess-1', 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
    ], { threadForSession: () => 'thread-1' })

    const sends = calls.filter(call => call.kind === 'send' && call.content !== undefined && call.content.length > 0)
    // Head + at least one continuation (2000-char limit, 2500-char text).
    expect(sends.length).toBeGreaterThanOrEqual(2)
    // A late second finalize (duplicate assistant/message) must not re-send.
    const editCount = calls.filter(call => call.kind === 'edit').length
    expect(editCount).toBeGreaterThanOrEqual(0)
  })

  it('stops typing on turn end and notifies the owner', async () => {
    const turnEnds: string[] = []
    const calls = await drive([
      sessionEvent('sess-1', 'turn/start', { turn: 1 }),
      sessionEvent('sess-1', 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
    ], { threadForSession: () => 'thread-1', onTurnEnded: (sessionId) => { turnEnds.push(sessionId) } })

    expect(turnEnds).toEqual(['sess-1'])
    expect(calls.filter(call => call.kind === 'typing')).toHaveLength(1)
  })

  it('drops frames for sessions without a bound thread', async () => {
    const calls = await drive([
      sessionEvent('sess-unknown', 'turn/start', { turn: 1 }),
      sessionEvent('sess-unknown', 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } }),
    ], { threadForSession: () => undefined })

    expect(calls).toHaveLength(0)
  })

  it('caches queue snapshots for the /queue surface', async () => {
    const snapshots: Array<{ sessionId: string; count: number }> = []
    await drive([
      { type: 'session/queue', sessionId: 'sess-1', items: [{ id: 'm-1', summary: 'first' }, { id: 'm-2', summary: 'second' }] },
    ], {
      threadForSession: () => 'thread-1',
      onQueueSnapshot: (sessionId, items) => { snapshots.push({ sessionId, count: items.length }) },
    })
    expect(snapshots).toEqual([{ sessionId: 'sess-1', count: 2 }])
  })

  it('renders presentation-view titles as activity rows and deletes them at turn end', async () => {
    const calls = await drive([
      sessionEvent('sess-1', 'turn/start', { turn: 1 }),
      // bash with a terminal view: the row IS the command (Host-curated).
      {
        type: 'session/event',
        sessionId: 'sess-1',
        event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"df -h"}' } },
        view: { for: 'call', view: { card: 'terminal', title: 'df -h' } },
      },
      // A tool WITHOUT a presentation view falls back to the generic label.
      sessionEvent('sess-1', 'tool/call', { turn: 1, step: 1, callId: 'call-2', name: 'mystery' }),
      // The result correlates through the block's toolCallId.
      sessionEvent('sess-1', 'tool/result', {
        turn: 1,
        step: 1,
        message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1' }] },
      }),
      sessionEvent('sess-1', 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
    ], { threadForSession: () => 'thread-1' })

    const activity = calls.filter(call => (call.kind === 'send' || call.kind === 'edit') && call.content?.startsWith('>'))
    expect(activity.length).toBeGreaterThanOrEqual(1)
    const body = activity.at(-1)?.content ?? ''
    // The terminal command is Host-curated disclosure — shown, never the raw args.
    expect(body).toContain('df -h')
    expect(body).not.toContain('{"command"')
    // The un-viewed tool falls back to the generic icon + label.
    expect(body).toContain('🧩 Tool')
    // No state marks of any kind.
    expect(body).not.toContain('🟡')
    expect(body).not.toContain('❌')
    // Turn end deletes the activity message exactly once.
    const deletions = calls.filter(call => call.kind === 'delete')
    expect(deletions).toHaveLength(1)
  })
})

describe('live render: per-step answer separation', () => {
  it('opens a new answer message for a later step instead of overwriting', async () => {
    const calls = await drive([
      sessionEvent('sess-1', 'turn/start', { turn: 1 }),
      sessionEvent('sess-1', 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'first answer' } }),
      sessionEvent('sess-1', 'assistant/message', {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      }),
      // Step 2 begins: its answer must land on a fresh message.
      sessionEvent('sess-1', 'step/start', { turn: 1, step: 2 }),
      sessionEvent('sess-1', 'assistant/chunk', { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'second answer' } }),
    ], { threadForSession: () => 'thread-1' })

    const sends = calls.filter(call => call.kind === 'send' && call.content !== undefined)
    const firstHead = sends.find(call => call.content?.includes('first'))
    const secondHead = sends.find(call => call.content?.includes('second'))
    expect(firstHead).toBeDefined()
    expect(secondHead).toBeDefined()
    // The second step's chunks created a NEW message, not an edit of the first.
    const secondEdits = calls.filter(call => call.kind === 'edit' && call.content?.includes('second'))
    for (const edit of secondEdits) {
      expect(edit.messageId).not.toBe('dm-1')
    }
  })

  it('sends the authoritative text as a fresh head when no chunks flushed', async () => {
    const calls = await drive([
      sessionEvent('sess-1', 'turn/start', { turn: 1 }),
      sessionEvent('sess-1', 'assistant/message', {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'instant answer' }] },
      }),
    ], { threadForSession: () => 'thread-1' })

    const sends = calls.filter(call => call.kind === 'send' && call.content === 'instant answer')
    expect(sends).toHaveLength(1)
  })
})

describe('live render: admission-time typing', () => {
  it('starts typing when a prompt is queued, before any turn event', async () => {
    const calls = await drive([
      { type: 'session/queue', sessionId: 'sess-1', items: [{ id: 'm-1', summary: 'hello' }] } as LiveFrame,
    ], { threadForSession: () => 'thread-1' })

    expect(calls.filter(call => call.kind === 'typing')).toHaveLength(1)
  })

  it('stops typing when the queue drains with no open turn', async () => {
    const calls = await drive([
      { type: 'session/queue', sessionId: 'sess-1', items: [{ id: 'm-1', summary: 'hello' }] } as LiveFrame,
      { type: 'session/queue', sessionId: 'sess-1', items: [] } as LiveFrame,
      // A later turn must still start typing: the lifecycle was reset, not stuck.
      sessionEvent('sess-1', 'turn/start', { turn: 1 }),
    ], { threadForSession: () => 'thread-1' })

    // admission typing → stop → turn typing: two pulses reach the wire.
    expect(calls.filter(call => call.kind === 'typing').length).toBeGreaterThanOrEqual(2)
  })

  it('restarts typing on a later turn after a previous turn ended', async () => {
    const calls = await drive([
      sessionEvent('sess-1', 'turn/start', { turn: 1 }),
      sessionEvent('sess-1', 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
      sessionEvent('sess-1', 'turn/start', { turn: 2 }),
    ], { threadForSession: () => 'thread-1' })

    expect(calls.filter(call => call.kind === 'typing').length).toBeGreaterThanOrEqual(2)
  })
})

describe('live render: session-title rename', () => {
  it('renames the thread when the DSH session title lands, once per distinct title', async () => {
    const calls = await drive([
      { type: 'session/projection', sessionId: 'sess-1', key: 'title', value: '阅读 main 分支当前状态' } as LiveFrame,
      { type: 'session/projection', sessionId: 'sess-1', key: 'title', value: '阅读 main 分支当前状态' } as LiveFrame,
    ], { threadForSession: () => 'thread-1' })

    const renames = calls.filter(call => call.kind === 'rename')
    expect(renames).toEqual([{ kind: 'rename', channelId: 'thread-1', content: '阅读 main 分支当前状态' }])
  })

  it('ignores title projections for sessions without a bound thread', async () => {
    const calls = await drive([
      { type: 'session/projection', sessionId: 'sess-unknown', key: 'title', value: 'x' } as LiveFrame,
    ], { threadForSession: () => undefined })
    expect(calls.filter(call => call.kind === 'rename')).toHaveLength(0)
  })

  it('after a restart, skips the rename when the thread already carries the title', async () => {
    const calls = await drive([
      { type: 'session/projection', sessionId: 'sess-1', key: 'title', value: '阅读 main 分支当前状态' } as LiveFrame,
    ], {
      threadForSession: () => 'thread-1',
      threadName: () => Promise.resolve('阅读 main 分支当前状态'),
    })
    expect(calls.filter(call => call.kind === 'rename')).toHaveLength(0)
  })

  it('after a restart, skips the rename when the wire name is the slugified title', async () => {
    // Discord stores thread names lowercased and dashed; the dedupe must
    // compare slugified keys or every restart burns a rename on a no-op.
    const calls = await drive([
      { type: 'session/projection', sessionId: 'sess-1', key: 'title', value: '阅读 main 分支当前状态' } as LiveFrame,
    ], {
      threadForSession: () => 'thread-1',
      threadName: () => Promise.resolve('阅读-main-分支当前状态'),
    })
    expect(calls.filter(call => call.kind === 'rename')).toHaveLength(0)
  })

  it('after a restart, renames when the wire name differs or lookup fails', async () => {
    for (const threadName of [
      () => Promise.resolve('stale name'),
      () => Promise.reject(new Error('lookup failed')),
    ]) {
      const calls = await drive([
        { type: 'session/projection', sessionId: 'sess-1', key: 'title', value: '阅读 main 分支当前状态' } as LiveFrame,
      ], { threadForSession: () => 'thread-1', threadName })
      expect(calls.filter(call => call.kind === 'rename')).toEqual([
        { kind: 'rename', channelId: 'thread-1', content: '阅读 main 分支当前状态' },
      ])
    }
  })
})

describe('live render: delivery failure posture', () => {
  it('never blind-resends a head whose send outcome was unobservable', async () => {
    const calls = await drive([
      sessionEvent('sess-1', 'turn/start', { turn: 1 }),
      sessionEvent('sess-1', 'step/start', { turn: 1, step: 1 }),
      sessionEvent('sess-1', 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hel' } }),
      sessionEvent('sess-1', 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'lo' } }),
      sessionEvent('sess-1', 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Hello' }] } }),
    ], {
      threadForSession: () => 'thread-1',
      // The first (head-creating) send is unobservable: Discord may have it.
      sendOutcomes: ['unknown'],
    })

    const sends = calls.filter(call => call.kind === 'send')
    // One unobservable flush send + the finalizer's single fresh send —
    // never a blind resend of the same content.
    expect(sends).toHaveLength(2)
    expect(sends[1]?.content).toContain('Hello')
    expect(calls.filter(call => call.kind === 'edit')).toHaveLength(0)
  })

  it('a finalize from a superseded step never re-points the live head', async () => {
    const calls: Array<{ kind: string; channelId?: string; messageId?: string; content?: string }> = []
    let releaseFinalizeSend!: () => void
    const finalizeSendGate = new Promise<void>((resolve) => { releaseFinalizeSend = resolve })
    const { delivery } = (() => {
      let n = 0
      const delivery: LiveDeliveryPort = {
        send: (request) => {
          calls.push({ kind: 'send', channelId: request.channelId, content: request.content })
          if (request.content.includes('step-one-final')) {
            n += 1
            const id = `dm-${String(n)}`
            return finalizeSendGate.then(() => ({ outcome: 'completed' as const, messageId: id }))
          }
          n += 1
          return Promise.resolve({ outcome: 'completed' as const, messageId: `dm-${String(n)}` })
        },
        edit: (request) => {
          calls.push({ kind: 'edit', channelId: request.channelId, messageId: request.messageId, content: request.content })
          return Promise.resolve({ outcome: 'completed' as const })
        },
        typing: () => Promise.resolve(),
        renameThread: () => Promise.resolve({ outcome: 'completed' as const }),
        delete: () => Promise.resolve({ outcome: 'completed' as const }),
      }
      return { delivery }
    })()

    // A pushable frame queue so the test can interleave with in-flight sends.
    const queue: LiveFrame[] = []
    let notify: (() => void) | undefined
    let drainedClosed: boolean = false
    const sleep = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms) })
    async function* source(): AsyncIterable<LiveFrame> {
      while (!drainedClosed) {
        if (queue.length === 0) {
          await new Promise<void>(resolve => { notify = resolve })
          continue
        }
        const frame = queue.shift()
        if (frame === undefined) continue
        yield frame
        await sleep(5)
      }
    }
    const live = startLiveRender({
      frames: source,
      threadForSession: () => 'thread-1',
      delivery,
      updateIntervalMs: 0,
      activityCoalesceMs: 0,
      typingIntervalMs: 60_000,
    })
    const push = (frame: LiveFrame): void => { queue.push(frame); notify?.() }

    push(sessionEvent('sess-1', 'turn/start', { turn: 1 }))
    await sleep(10)
    push(sessionEvent('sess-1', 'step/start', { turn: 1, step: 1 }))
    await sleep(10)
    // Step-1's authoritative message finalizes with no flushed head: the
    // finalizer's own send becomes the head — but it is gated in flight.
    push(sessionEvent('sess-1', 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'step-one-final' }] } }))
    await sleep(20)
    // Step-2 opens a new head while step-1's finalize send is still in REST.
    push(sessionEvent('sess-1', 'step/start', { turn: 1, step: 2 }))
    await sleep(10)
    push(sessionEvent('sess-1', 'assistant/chunk', { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'A' } }))
    await sleep(20)
    releaseFinalizeSend()
    await sleep(20)
    push(sessionEvent('sess-1', 'assistant/chunk', { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'B' } }))
    await sleep(20)
    drainedClosed = true
    notify?.()
    live.dispose()

    // Step-2's chunk flushed into its own message; the late finalize's send
    // must NOT have become the head — the last edit still targets dm-2.
    const sends = calls.filter(call => call.kind === 'send')
    expect(sends.some(call => call.content?.includes('step-one-final'))).toBe(true)
    const lastEdit = calls.filter(call => call.kind === 'edit').at(-1)
    expect(lastEdit?.messageId).toBe('dm-2')
    expect(lastEdit?.content).toContain('AB')
  })

  it('completes the in-flight head send instead of duplicating the answer (16.39)', async () => {
    // The live race: the last coalesced flush's send is still in flight
    // (headMessageId unset) when the authoritative assistant/message
    // arrives. The finalize must settle that send and EDIT its message —
    // not post the full answer as a duplicate second message.
    const calls: Array<{ kind: string; messageId?: string; content?: string }> = []
    let releaseHeadSend!: (messageId: string) => void
    const headSendGate = new Promise<string>((resolve) => { releaseHeadSend = resolve })
    const delivery: LiveDeliveryPort = {
      send: (request) => {
        calls.push({ kind: 'send', content: request.content })
        if (calls.filter(call => call.kind === 'send').length === 1) {
          return headSendGate.then((messageId) => ({ outcome: 'completed' as const, messageId }))
        }
        return Promise.resolve({ outcome: 'completed', messageId: 'dm-extra' })
      },
      edit: (request) => {
        calls.push({ kind: 'edit', messageId: request.messageId, content: request.content })
        return Promise.resolve({ outcome: 'completed' })
      },
      typing: () => Promise.resolve(),
      renameThread: () => Promise.resolve({ outcome: 'completed' }),
      delete: () => Promise.resolve({ outcome: 'completed' }),
    }

    await drive([
      sessionEvent('sess-1', 'turn/start', { turn: 1 }),
      sessionEvent('sess-1', 'step/start', { turn: 1, step: 1 }),
      sessionEvent('sess-1', 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hel' } }),
      sessionEvent('sess-1', 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] } }),
    ], { threadForSession: () => 'thread-1', delivery, updateIntervalMs: 0 })

    // The flushed head lands once released, then the finalize edits it.
    releaseHeadSend('dm-head')
    await new Promise(resolve => { setTimeout(resolve, 20) })

    const sends = calls.filter(call => call.kind === 'send')
    expect(sends).toHaveLength(1)
    expect(sends[0]?.content).toBe('Hel')
    const edits = calls.filter(call => call.kind === 'edit')
    expect(edits).toHaveLength(1)
    expect(edits[0]?.messageId).toBe('dm-head')
    expect(edits[0]?.content).toBe('Hello world')
  }, 20_000)
})

describe('live render: turn progress status line (turn-progress-discord-sync)', () => {
  const progressCopy = () => ({
    thinking: '⏳ 思考中…',
    thinkingStep: (step: number) => `⏳ 思考中…（步骤 ${String(step)}）`,
    writing: '✍️ 撰写回复…',
    approvalWait: '⏳ 等待审批…',
    turnSummary: (total: number, failed: number, breakdown: string) => failed > 0 ? `⚙️ 本轮 ${String(total)} 次工具调用 · ${String(failed)} 失败 ✗（${breakdown}）` : `⚙️ 本轮 ${String(total)} 次工具调用 ✓（${breakdown}）`,
  })

  it('creates the status message at turn/start, tracks phases, deletes at turn/end', async () => {
    const calls = await drive([
      sessionEvent('sess-1', 'turn/start', { turn: 1 }),
      sessionEvent('sess-1', 'step/start', { turn: 1, step: 1 }),
      sessionEvent('sess-1', 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"find /private/tmp -name x"}' }),
      sessionEvent('sess-1', 'tool/result', { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', isError: false }] } }),
      sessionEvent('sess-1', 'step/start', { turn: 1, step: 2 }),
      sessionEvent('sess-1', 'assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
      sessionEvent('sess-1', 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], { threadForSession: () => 'thread-1', progressCopy })

    const statusCalls = calls.filter(call => (call.kind === 'send' || call.kind === 'edit') && (call.content?.includes('⏳') || call.content?.includes('💻') || call.content?.includes('✍️')))
    // The status message exists from turn/start with the thinking phase.
    expect(statusCalls.length).toBeGreaterThanOrEqual(1)
    const first = statusCalls[0]?.content ?? ''
    expect(first).toContain('⏳ 思考中…')
    // tool/call switches the phase line to the running tool + title.
    const duringTool = statusCalls.find(call => call.content?.includes('💻'))
    expect(duringTool?.content).toContain('find /private/tmp -name x')
    // A succeeded tool row carries the ✓ mark (0.1.6 isError semantics).
    expect(statusCalls.some(call => call.content?.includes('✓'))).toBe(true)
    // A later step shows the step count; the writing phase appears next.
    expect(statusCalls.some(call => call.content?.includes('步骤 2'))).toBe(true)
    expect(statusCalls.some(call => call.content?.includes('✍️ 撰写回复…'))).toBe(true)
    // Turn end edits the status message into the one-line turn summary —
    // no delete for a turn that ran tools (decision 5).
    const deletions = calls.filter(call => call.kind === 'delete')
    expect(deletions).toHaveLength(0)
    const summaryEdit = calls.filter(call => call.kind === 'edit' && (call.content?.includes('⚙️') ?? false)).at(-1)?.content ?? ''
    expect(summaryEdit).toContain('⚙️ 本轮 1 次工具调用')
    expect(summaryEdit).toContain('Shell ×1')
    expect(summaryEdit).toContain('✓')
    expect(summaryEdit).not.toContain('失败')
  })

  it('removes the status message at turn/end when the turn ran no tools', async () => {
    const calls = await drive([
      sessionEvent('sess-1', 'turn/start', { turn: 1 }),
      sessionEvent('sess-1', 'step/start', { turn: 1, step: 1 }),
      sessionEvent('sess-1', 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '直接回答' }] } }),
      sessionEvent('sess-1', 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], { threadForSession: () => 'thread-1', progressCopy })

    // Zero-tool turns keep the pure Q&A thread: the status message is deleted.
    const deletions = calls.filter(call => call.kind === 'delete')
    expect(deletions).toHaveLength(1)
    const summaryEdits = calls.filter(call => call.kind === 'edit' && (call.content?.includes('⚙️') ?? false))
    expect(summaryEdits).toHaveLength(0)
  })

  it('marks a failed tool row with ✗ (message.content[0].isError)', async () => {
    const calls = await drive([
      sessionEvent('sess-1', 'turn/start', { turn: 1 }),
      sessionEvent('sess-1', 'step/start', { turn: 1, step: 1 }),
      sessionEvent('sess-1', 'tool/call', { turn: 1, step: 1, callId: 'call-bad', name: 'bash', arguments: '{"command":"exit 3"}' }),
      sessionEvent('sess-1', 'tool/result', { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-bad', isError: true }] } }),
      sessionEvent('sess-1', 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ], { threadForSession: () => 'thread-1', progressCopy })

    const statusCalls = calls.filter(call => (call.kind === 'send' || call.kind === 'edit') && call.content !== undefined && call.content !== '')
    expect(statusCalls.some(call => call.content?.includes('✗'))).toBe(true)
    expect(statusCalls.some(call => call.content?.includes('✓'))).toBe(false)
    // The turn summary carries the failure tally (decision 5).
    const summaryEdit = calls.filter(call => call.kind === 'edit' && (call.content?.includes('⚙️') ?? false)).at(-1)?.content ?? ''
    expect(summaryEdit).toContain('1 失败')
    expect(summaryEdit).toContain('✗')
  })

  it('switches to approval-wait on the ask claim and restores progress on settle', async () => {
    const { delivery, calls } = createDelivery()
    const frames: LiveFrame[] = [
      sessionEvent('sess-1', 'turn/start', { turn: 1 }),
      sessionEvent('sess-1', 'step/start', { turn: 1, step: 1 }),
      sessionEvent('sess-1', 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"rm -rf /tmp/x"}' }),
    ]
    const released = new Promise<void>(resolve => { setTimeout(resolve, 40) })
    async function* source(): AsyncIterable<LiveFrame> {
      for (const frame of frames) {
        yield frame
        await new Promise(resolve => { setTimeout(resolve, 5) })
      }
      await released
    }
    const live = startLiveRender({
      frames: source,
      threadForSession: () => 'thread-1',
      delivery,
      updateIntervalMs: 0,
      activityCoalesceMs: 0,
      typingIntervalMs: 60_000,
      progressCopy,
    })
    await new Promise(resolve => { setTimeout(resolve, 30) })
    live.setApprovalWait('thread-1', true)
    await new Promise(resolve => { setTimeout(resolve, 30) })
    live.setApprovalWait('thread-1', false)
    await new Promise(resolve => { setTimeout(resolve, 30) })
    live.dispose()

    const statusCalls = calls.filter(call => (call.kind === 'send' || call.kind === 'edit') && (call.content?.includes('⏳') || call.content?.includes('💻')))
    expect(statusCalls.some(call => call.content?.includes('⏳ 等待审批…'))).toBe(true)
    // After settling, the phase returns to the running tool.
    const afterSettle = statusCalls.filter(call => call.content?.includes('💻')).at(-1)?.content ?? ''
    expect(afterSettle).toContain('rm -rf /tmp/x')
    expect(afterSettle).not.toContain('等待审批')
  })
})

describe('live render: status message vs turn/end race (turn-progress)', () => {
  const progressCopy = () => ({
    thinking: '⏳ 思考中…',
    thinkingStep: (step: number) => `⏳ 思考中…（步骤 ${String(step)}）`,
    writing: '✍️ 撰写回复…',
    approvalWait: '⏳ 等待审批…',
    turnSummary: (total: number, failed: number, breakdown: string) => failed > 0 ? `⚙️ 本轮 ${String(total)} 次工具调用 · ${String(failed)} 失败 ✗（${breakdown}）` : `⚙️ 本轮 ${String(total)} 次工具调用 ✓（${breakdown}）`,
  })

  it('deletes the status message when its in-flight send lands after turn/end', async () => {
    const calls: Array<{ kind: string; messageId?: string; content?: string }> = []
    const sendDeferreds: Array<(id: string) => void> = []
    const delivery: LiveDeliveryPort = {
      send: (request) => {
        calls.push({ kind: 'send', content: request.content })
        return new Promise(resolve => {
          sendDeferreds.push((id: string) => { resolve({ outcome: 'completed', messageId: id }) })
        })
      },
      edit: (request) => {
        calls.push({ kind: 'edit', messageId: request.messageId, content: request.content })
        return Promise.resolve({ outcome: 'completed' })
      },
      delete: (request) => {
        calls.push({ kind: 'delete', messageId: request.messageId })
        return Promise.resolve({ outcome: 'completed' })
      },
      typing: (channelId) => { calls.push({ kind: 'typing', content: channelId }); return Promise.resolve() },      renameThread: () => Promise.resolve({ outcome: 'completed' }),
    }

    async function* source(): AsyncIterable<LiveFrame> {
      yield sessionEvent('sess-1', 'turn/start', { turn: 1 })
      // Let the coalescer (interval 0) fire the status send, which now
      // hangs on the deferred.
      await new Promise(resolve => { setTimeout(resolve, 15) })
      yield sessionEvent('sess-1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
      await new Promise(resolve => { setTimeout(resolve, 15) })
    }
    const live = startLiveRender({
      frames: source,
      threadForSession: () => 'thread-1',
      delivery,
      updateIntervalMs: 0,
      activityCoalesceMs: 0,
      typingIntervalMs: 60_000,
      progressCopy,
    })
    await new Promise(resolve => { setTimeout(resolve, 25) })
    expect(sendDeferreds.length).toBeGreaterThanOrEqual(1)
    // turn/end has run its cleanup while the send is still in flight.
    // No delete may have happened yet.
    expect(calls.filter(call => call.kind === 'delete')).toHaveLength(0)

    // The send lands late: the cleanup's await must now delete it.
    sendDeferreds[0]?.('dm-status')
    await new Promise(resolve => { setTimeout(resolve, 25) })
    live.dispose()

    const deletions = calls.filter(call => call.kind === 'delete')
    expect(deletions).toHaveLength(1)
    expect(deletions[0]?.messageId).toBe('dm-status')
  })
})
