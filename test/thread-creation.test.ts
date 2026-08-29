/**
 * Thread creation intent tests (8.2): the source Discord message is the
 * stable intent. The first creator claims it and records the new thread;
 * a duplicate delivery of the same message recovers the SAME thread without
 * creating a second one, and a replay of a DIFFERENT payload under the same
 * message id conflicts. The opener (author-impersonated mirror) rides the
 * creation call; recovered threads are never opened again.
 */

import { describe, expect, it } from 'vitest'

import { createKvTableStub } from './helpers/kv-table.js'
import { createIntentStore } from '../src/state/intents.js'
import { createThreadCreationFlow, type DiscordThreadPort } from '../src/features/thread-creation.js'

function threadPort(): DiscordThreadPort & { created: string[] } {
  const created: string[] = []
  let counter = 0
  return {
    created,
    createThread: () => {
      counter += 1
      const threadId = `thread-${String(counter)}`
      created.push(threadId)
      return Promise.resolve({ outcome: 'completed', threadId })
    },
    findThreadBySource: () => Promise.resolve({ outcome: 'not-found' }),
  }
}

const OPENER = { content: 'fix the bug', authorName: 'Addo' }

function setup() {
  const intents = createIntentStore(createKvTableStub())
  const port = threadPort()
  const flow = createThreadCreationFlow({ intents, discord: port, nowMs: () => 1_000 })
  return { flow, port }
}

describe('thread creation intent', () => {
  it('creates exactly one thread for the source message', async () => {
    const { flow, port } = setup()
    const result = await flow.ensureThread({
      sourceMessageId: 'm-1',
      contentHash: 'hash-1',
      guildId: 'g1',
      parentChannelId: 'c1',
      threadName: 'Task: ship it',
      opener: OPENER,
    })
    expect(result).toMatchObject({ outcome: 'created', threadId: 'thread-1' })
    expect(port.created).toEqual(['thread-1'])
  })

  it('recovers the same thread when the message redelivers', async () => {
    const { flow, port } = setup()
    await flow.ensureThread({ sourceMessageId: 'm-1', contentHash: 'hash-1', guildId: 'g1', parentChannelId: 'c1', threadName: 'x', opener: OPENER })
    const replay = await flow.ensureThread({ sourceMessageId: 'm-1', contentHash: 'hash-1', guildId: 'g1', parentChannelId: 'c1', threadName: 'x', opener: OPENER })

    expect(replay).toMatchObject({ outcome: 'recovered', threadId: 'thread-1' })
    // No second thread was ever created.
    expect(port.created).toEqual(['thread-1'])
  })

  it('recovers via the deterministic title lookup when the intent lacks a thread id', async () => {
    const intents = createIntentStore(createKvTableStub())
    let counter = 0
    const discord: DiscordThreadPort = {
      createThread: () => {
        counter += 1
        return Promise.resolve({ outcome: 'completed', threadId: `thread-${String(counter)}` })
      },
      findThreadBySource: (request: { threadName: string }) =>
        Promise.resolve({ outcome: 'found', threadId: `recovered-for-${request.threadName}` }),
    }
    const flow = createThreadCreationFlow({ intents, discord, nowMs: () => 1_000 })

    // Claim the intent WITHOUT completing creation (simulated crash window).
    await intents.claim({ messageId: 'm-crash', contentHash: 'h', claimedAtMs: 1 })
    const result = await flow.ensureThread({ sourceMessageId: 'm-crash', contentHash: 'h', guildId: 'g1', parentChannelId: 'c1', threadName: 'x', opener: OPENER })
    expect(result).toMatchObject({ outcome: 'recovered', threadId: 'recovered-for-x' })
  })

  it('conflicts when the same message id redelivers different content', async () => {
    const { flow } = setup()
    await flow.ensureThread({ sourceMessageId: 'm-1', contentHash: 'hash-1', guildId: 'g1', parentChannelId: 'c1', threadName: 'x', opener: OPENER })
    const conflict = await flow.ensureThread({ sourceMessageId: 'm-1', contentHash: 'hash-2', guildId: 'g1', parentChannelId: 'c1', threadName: 'x', opener: OPENER })
    expect(conflict).toEqual({ outcome: 'conflict' })
  })

  it('reports a thread-creation failure as a value', async () => {
    const intents = createIntentStore(createKvTableStub())
    const discord: DiscordThreadPort = {
      createThread: () => Promise.resolve({ outcome: 'failed' }),
      findThreadBySource: () => Promise.resolve({ outcome: 'not-found' }),
    }
    const flow = createThreadCreationFlow({ intents, discord, nowMs: () => 1_000 })
    const result = await flow.ensureThread({ sourceMessageId: 'm-1', contentHash: 'h', guildId: 'g1', parentChannelId: 'c1', threadName: 'x', opener: OPENER })
    expect(result).toEqual({ outcome: 'failed' })
  })
})

describe('opener mirroring', () => {
  it('hands the author-impersonated opener to the port on creation', async () => {
    const intents = createIntentStore(createKvTableStub())
    const seen: Array<{ content: string; authorName: string }> = []
    const discord: DiscordThreadPort = {
      createThread: (request) => {
        seen.push(request.opener)
        return Promise.resolve({ outcome: 'completed', threadId: 'thread-1' })
      },
      findThreadBySource: () => Promise.resolve({ outcome: 'not-found' }),
    }
    const flow = createThreadCreationFlow({ intents, discord, nowMs: () => 1_000 })

    await flow.ensureThread({
      sourceMessageId: 'm-1', contentHash: 'h', guildId: 'g1', parentChannelId: 'c1', threadName: 'x',
      opener: { content: 'fix the bug', authorName: 'Addo' },
    })

    expect(seen).toEqual([{ content: 'fix the bug', authorName: 'Addo' }])
  })

  it('does not open a recovered thread again', async () => {
    const intents = createIntentStore(createKvTableStub())
    let creations = 0
    const discord: DiscordThreadPort = {
      createThread: () => {
        creations += 1
        return Promise.resolve({ outcome: 'completed', threadId: 'thread-1' })
      },
      findThreadBySource: () => Promise.resolve({ outcome: 'found', threadId: 'recovered-1' }),
    }
    const flow = createThreadCreationFlow({ intents, discord, nowMs: () => 1_000 })

    // Claim first so the ensure call lands on the duplicate/recovery path.
    await intents.claim({ messageId: 'm-1', contentHash: 'h', claimedAtMs: 1 })
    await intents.annotate('m-1', { threadId: 'recovered-1' })
    const result = await flow.ensureThread({
      sourceMessageId: 'm-1', contentHash: 'h', guildId: 'g1', parentChannelId: 'c1', threadName: 'x',
      opener: { content: 'x', authorName: 'Addo' },
    })

    expect(result).toEqual({ outcome: 'recovered', threadId: 'recovered-1' })
    expect(creations).toBe(0)
  })
})
