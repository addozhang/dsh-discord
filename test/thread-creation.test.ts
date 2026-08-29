/**
 * Thread creation intent tests (8.2): the source Discord message is the
 * stable intent. The first creator claims it and records the new thread;
 * a duplicate delivery of the same message recovers the SAME thread without
 * creating a second one, and a replay of a DIFFERENT payload under the same
 * message id conflicts.
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
    joinThread: () => Promise.resolve(),
    createThread: () => {
      counter += 1
      const threadId = `thread-${String(counter)}`
      created.push(threadId)
      return Promise.resolve({ outcome: 'completed', threadId })
    },
    findThreadBySource: () => Promise.resolve({ outcome: 'not-found' }),
  }
}

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
    })
    expect(result).toMatchObject({ outcome: 'created', threadId: 'thread-1' })
    expect(port.created).toEqual(['thread-1'])
  })

  it('recovers the same thread when the message redelivers', async () => {
    const { flow, port } = setup()
    await flow.ensureThread({ sourceMessageId: 'm-1', contentHash: 'hash-1', guildId: 'g1', parentChannelId: 'c1', threadName: 'x' })
    const replay = await flow.ensureThread({ sourceMessageId: 'm-1', contentHash: 'hash-1', guildId: 'g1', parentChannelId: 'c1', threadName: 'x' })

    expect(replay).toMatchObject({ outcome: 'recovered', threadId: 'thread-1' })
    // No second thread was ever created.
    expect(port.created).toEqual(['thread-1'])
  })

  it('recovers via the deterministic lookup when the intent lacks a thread id', async () => {
    const intents = createIntentStore(createKvTableStub())
    let counter = 0
    const discord: DiscordThreadPort = {
      createThread: () => {
        counter += 1
        return Promise.resolve({ outcome: 'completed', threadId: `thread-${String(counter)}` })
      },
      findThreadBySource: (request: { sourceMessageId: string }) =>
        Promise.resolve({ outcome: 'found', threadId: `recovered-for-${request.sourceMessageId}` }),
      joinThread: () => Promise.resolve(),
    }
    const flow = createThreadCreationFlow({ intents, discord, nowMs: () => 1_000 })

    // Claim the intent WITHOUT completing creation (simulated crash window).
    await intents.claim({ messageId: 'm-crash', contentHash: 'h', claimedAtMs: 1 })
    const result = await flow.ensureThread({ sourceMessageId: 'm-crash', contentHash: 'h', guildId: 'g1', parentChannelId: 'c1', threadName: 'x' })
    expect(result).toMatchObject({ outcome: 'recovered', threadId: 'recovered-for-m-crash' })
  })

  it('conflicts when the same message id redelivers different content', async () => {
    const { flow } = setup()
    await flow.ensureThread({ sourceMessageId: 'm-1', contentHash: 'hash-1', guildId: 'g1', parentChannelId: 'c1', threadName: 'x' })
    const conflict = await flow.ensureThread({ sourceMessageId: 'm-1', contentHash: 'hash-2', guildId: 'g1', parentChannelId: 'c1', threadName: 'x' })
    expect(conflict).toEqual({ outcome: 'conflict' })
  })

  it('reports a thread-creation failure as a value', async () => {
    const intents = createIntentStore(createKvTableStub())
    const discord: DiscordThreadPort = {
      createThread: () => Promise.resolve({ outcome: 'failed' }),
      findThreadBySource: () => Promise.resolve({ outcome: 'not-found' }),
      joinThread: () => Promise.resolve(),
    }
    const flow = createThreadCreationFlow({ intents, discord, nowMs: () => 1_000 })
    const result = await flow.ensureThread({ sourceMessageId: 'm-1', contentHash: 'h', guildId: 'g1', parentChannelId: 'c1', threadName: 'x' })
    expect(result).toEqual({ outcome: 'failed' })
  })
})

describe('author join', () => {
  it('joins the task author on a freshly created thread', async () => {
    const intents = createIntentStore(createKvTableStub())
    const joined: Array<{ threadId: string; userId: string }> = []
    const discord: DiscordThreadPort = {
      createThread: () => Promise.resolve({ outcome: 'completed', threadId: 'thread-1' }),
      findThreadBySource: () => Promise.resolve({ outcome: 'not-found' }),
      joinThread: (request) => {
        joined.push(request)
        return Promise.resolve()
      },
    }
    const flow = createThreadCreationFlow({ intents, discord, nowMs: () => 1_000 })

    await flow.ensureThread({
      sourceMessageId: 'm-1', contentHash: 'h', guildId: 'g1', parentChannelId: 'c1',
      threadName: 'x', creatorUserId: 'member-9',
    })

    expect(joined).toEqual([{ threadId: 'thread-1', userId: 'member-9' }])
  })

  it('joins the author on the recovery path too, and a join throw stays non-fatal', async () => {
    const intents = createIntentStore(createKvTableStub())
    // Simulated crash window: intent claimed, no thread id recorded.
    await intents.claim({ messageId: 'm-crash', contentHash: 'h', claimedAtMs: 1 })
    const joined: string[] = []
    const discord: DiscordThreadPort = {
      createThread: () => Promise.resolve({ outcome: 'failed' }),
      findThreadBySource: () => Promise.resolve({ outcome: 'found', threadId: 'recovered-1' }),
      joinThread: (request) => {
        joined.push(request.threadId)
        return Promise.reject(new Error('join refused'))
      },
    }
    const flow = createThreadCreationFlow({ intents, discord, nowMs: () => 1_000 })

    const result = await flow.ensureThread({
      sourceMessageId: 'm-crash', contentHash: 'h', guildId: 'g1', parentChannelId: 'c1',
      threadName: 'x', creatorUserId: 'member-9',
    })

    expect(result).toEqual({ outcome: 'recovered', threadId: 'recovered-1' })
    expect(joined).toEqual(['recovered-1'])
  })

  it('skips the join when no author id is provided', async () => {
    const intents = createIntentStore(createKvTableStub())
    let joins = 0
    const discord: DiscordThreadPort = {
      createThread: () => Promise.resolve({ outcome: 'completed', threadId: 'thread-1' }),
      findThreadBySource: () => Promise.resolve({ outcome: 'not-found' }),
      joinThread: () => {
        joins += 1
        return Promise.resolve()
      },
    }
    const flow = createThreadCreationFlow({ intents, discord, nowMs: () => 1_000 })

    await flow.ensureThread({ sourceMessageId: 'm-1', contentHash: 'h', guildId: 'g1', parentChannelId: 'c1', threadName: 'x' })
    expect(joins).toBe(0)
  })
})
