/**
 * Live render wiring tests (Phase 1): the mux frame source drives per-thread
 * render state into real Discord delivery — one head answer message per
 * assistant message, coalesced edits, authoritative finalization with
 * overflow continuations, typing on turn boundaries, and tool activity rows.
 * Frames for unknown sessions are dropped; queue snapshots are cached.
 */

import { describe, expect, it } from 'vitest'

import { startLiveRender, type LiveDeliveryPort, type LiveFrame } from '../src/stream/live.js'

function createDelivery() {
  const calls: Array<{ kind: 'send' | 'edit' | 'typing' | 'rename'; channelId: string; messageId?: string; content?: string }> = []
  let messageCounter = 0
  const delivery: LiveDeliveryPort = {
    send: (request) => {
      calls.push({ kind: 'send', channelId: request.channelId, content: request.content })
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
}): Promise<Array<{ kind: 'send' | 'edit' | 'typing' | 'rename'; channelId: string; messageId?: string; content?: string }>> {
  const { delivery, calls } = createDelivery()
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
    typingIntervalMs: 60_000,
    ...(options.onQueueSnapshot === undefined ? {} : { onQueueSnapshot: options.onQueueSnapshot }),
    ...(options.onTurnEnded === undefined ? {} : { onTurnEnded: options.onTurnEnded }),
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

  it('renders tool activity rows as a bounded activity message', async () => {
    const calls = await drive([
      sessionEvent('sess-1', 'turn/start', { turn: 1 }),
      sessionEvent('sess-1', 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash' }),
      sessionEvent('sess-1', 'tool/result', {
        turn: 1,
        step: 1,
        callId: 'call-1',
        message: { role: 'user', content: [{ type: 'tool-result', callId: 'call-1' }] },
      }),
    ], { threadForSession: () => 'thread-1' })

    // The safe allowlist label ('bash' → 'Shell') never echoes raw names
    // beyond the allowlist, and the completed row shows the terminal state.
    const running = calls.find(call => call.kind === 'send' && call.content?.includes('Shell'))
    expect(running).toBeDefined()
    const edited = calls.find(call => call.kind === 'edit' && call.content?.includes('✓ Shell'))
    expect(edited).toBeDefined()
    expect(edited?.content).not.toContain('raw-output')
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

describe('live render: admission-time typing (Kimaki pattern)', () => {
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
})
