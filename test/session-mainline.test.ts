/**
 * Session mainline orchestration (Phase 1 wiring): mention → intent claim →
 * thread creation → session creation → at-most-once prompt → turn ownership.
 * This is the exact flow `routeEvent` hands a bound-channel mention to, with
 * fakes standing in for Discord REST and the in-process apiProxy.
 */

import { describe, expect, it, vi } from 'vitest'

import { createSessionMainline, type MainlineImageCollector } from '../src/features/session-mainline.js'
import { createThreadCreationFlow, type DiscordThreadPort } from '../src/features/thread-creation.js'
import { createSessionCreationFlow, type DshSessionPort } from '../src/features/session-creation.js'
import { createPromptSubmissionFlow, type DshPromptPort } from '../src/features/prompt-submission.js'
import { createTurnTracker } from '../src/features/turn-ownership.js'
import { threadBindingKey } from '../src/state/domain.js'
import { createIntentStore } from '../src/state/intents.js'
import { createBindingStore } from '../src/state/bindings.js'
import { createKvTableStub } from './helpers/kv-table.js'
import type { ThreadBinding } from '../src/state/records.js'

const APP = 'app'
const GUILD = 'guild-1'

interface Fixture {
  promptCalls: Array<{
    requestId: string
    sessionId: string
    prompt: string
    mode: string
    images?: ReadonlyArray<{ mediaType: string; base64: string }>
  }>
  collectCalls: Array<{ attachments: ReadonlyArray<{ url: string; declaredSize: number; contentType: string }> }>
  threadRequests: Array<{ threadName: string }>
  threadBindings: Map<string, ThreadBinding>
  turnTracker: ReturnType<typeof createTurnTracker>
  mainline: ReturnType<typeof createSessionMainline>
}

function createFixture(options: {
  createThread?: DiscordThreadPort['createThread']
  joinThread?: DiscordThreadPort['joinThread']
  createSession?: DshSessionPort['createSession']
  submit?: DshPromptPort['submit']
  collect?: MainlineImageCollector['collect']
} = {}): Fixture {
  const intents = createIntentStore(createKvTableStub())
  const threadTable = createKvTableStub<ThreadBinding>()
  const threadBindings = createBindingStore<ThreadBinding>(threadTable)
  const threadRequests: Array<{ threadName: string }> = []
  const threads: DiscordThreadPort = {
    createThread: options.createThread ?? (request => {
      threadRequests.push({ threadName: request.name })
      return Promise.resolve({ outcome: 'completed', threadId: 'thread-1' })
    }),
    findThreadBySource: () => Promise.resolve({ outcome: 'not-found' }),
    joinThread: options.joinThread ?? (() => Promise.resolve({ outcome: 'completed' })),
  }
  const sessions: DshSessionPort = {
    createSession: options.createSession ?? ((request) => Promise.resolve({ outcome: 'completed', sessionId: request.sessionId })),
  }
  const promptCalls: Array<{
    requestId: string
    sessionId: string
    prompt: string
    mode: string
    images?: ReadonlyArray<{ mediaType: string; base64: string }>
  }> = []
  const prompts: DshPromptPort = {
    submit: options.submit ?? ((request) => {
      promptCalls.push(request)
      return Promise.resolve({ outcome: 'accepted' })
    }),
  }
  const collectCalls: Array<{ attachments: ReadonlyArray<{ url: string; declaredSize: number; contentType: string }> }> = []
  const images: MainlineImageCollector = {
    collect: options.collect ?? (request => {
      collectCalls.push(request)
      return Promise.resolve({ outcome: 'collected', images: [{ mediaType: 'image/png', base64: 'cG5n' }] })
    }),
  }
  const turnTracker = createTurnTracker()
  const mainline = createSessionMainline({
    threads: createThreadCreationFlow({ intents, discord: threads, nowMs: () => 1_000 }),
    sessions: createSessionCreationFlow({
      sessions,
      threadBindings,
      newSessionId: () => 'preallocated-1',
    }),
    prompts: createPromptSubmissionFlow({ prompts, intents, nowMs: () => 1_000 }),
    turns: turnTracker,
    images,
  })
  return {
    promptCalls,
    collectCalls,
    threadRequests,
    threadBindings: threadTable as unknown as Map<string, ThreadBinding>,
    turnTracker,
    mainline,
  }
}

describe('session mainline', () => {
  it('admits a mention end to end: thread → session → prompt → turn ownership', async () => {
    const f = createFixture()

    const result = await f.mainline.admitMention({
      applicationId: APP,
      guildId: GUILD,
      channelId: 'channel-1',
      messageId: 'm-1',
      authorId: 'member-1',
      workspaceId: 'ws-1',
      prompt: 'fix the bug',
    })

    expect(result).toEqual({ outcome: 'admitted', threadId: 'thread-1', sessionId: 'preallocated-1' })
    expect(f.promptCalls).toEqual([{
      requestId: 'discord:m-1',
      sessionId: 'preallocated-1',
      prompt: 'fix the bug',
      mode: 'queue',
    }])
    // The durable thread binding and adapter-owned turn are both in place.
    expect(f.threadBindings.get(threadBindingKey({ applicationId: APP, guildId: GUILD, threadId: 'thread-1' }))?.sessionId).toBe('preallocated-1')
    expect(f.turnTracker.active('preallocated-1')).toEqual({
      sessionId: 'preallocated-1',
      requestId: 'discord:m-1',
      threadId: 'thread-1',
    })
  })

  it('replays a redelivered mention idempotently without a second prompt', async () => {
    const f = createFixture()
    const request = {
      applicationId: APP,
      guildId: GUILD,
      channelId: 'channel-1',
      messageId: 'm-1',
      authorId: 'member-1',
      workspaceId: 'ws-1',
      prompt: 'fix the bug',
    }
    await f.mainline.admitMention(request)

    const replay = await f.mainline.admitMention(request)
    expect(replay).toEqual({ outcome: 'admitted', threadId: 'thread-1', sessionId: 'preallocated-1' })
    expect(f.promptCalls).toHaveLength(1)
  })

  it('reports thread-creation failure without touching DSH', async () => {
    const createSession = vi.fn<DshSessionPort['createSession']>(() => Promise.resolve({ outcome: 'completed', sessionId: 'x' }))
    const f = createFixture({ createThread: () => Promise.resolve({ outcome: 'unknown' }), createSession })

    const result = await f.mainline.admitMention({
      applicationId: APP, guildId: GUILD, channelId: 'channel-1',
      messageId: 'm-1', authorId: 'member-1',
      workspaceId: 'ws-1', prompt: 'fix the bug',
    })

    expect(result).toEqual({ outcome: 'thread-failed' })
    expect(createSession).not.toHaveBeenCalled()
    expect(f.promptCalls).toHaveLength(0)
  })

  it('leaves the thread unbound when the Host rejects session creation', async () => {
    const f = createFixture({ createSession: () => Promise.resolve({ outcome: 'rejected', reason: 'workspace-gone' }) })

    const result = await f.mainline.admitMention({
      applicationId: APP, guildId: GUILD, channelId: 'channel-1',
      messageId: 'm-1', authorId: 'member-1',
      workspaceId: 'ws-1', prompt: 'fix the bug',
    })

    expect(result).toEqual({ outcome: 'session-rejected' })
    expect(f.promptCalls).toHaveLength(0)
    expect(f.turnTracker.active('preallocated-1')).toBeUndefined()
  })

  it('does not claim turn ownership when the prompt was not accepted', async () => {
    const f = createFixture({ submit: () => Promise.resolve({ outcome: 'unknown' }) })

    const result = await f.mainline.admitMention({
      applicationId: APP, guildId: GUILD, channelId: 'channel-1',
      messageId: 'm-1', authorId: 'member-1',
      workspaceId: 'ws-1', prompt: 'fix the bug',
    })

    expect(result).toEqual({ outcome: 'prompt-unknown' })
    expect(f.turnTracker.active('preallocated-1')).toBeUndefined()
  })

  it('queues continuations in an owned thread and keeps one active turn', async () => {
    const f = createFixture()
    await f.mainline.admitMention({
      applicationId: APP, guildId: GUILD, channelId: 'channel-1',
      messageId: 'm-1', authorId: 'member-1',
      workspaceId: 'ws-1', prompt: 'fix the bug',
    })

    const first = await f.mainline.continueInThread({
      applicationId: APP, guildId: GUILD, threadId: 'thread-1',
      sessionId: 'preallocated-1', messageId: 'm-2', prompt: 'also the logs',
    })
    expect(first).toEqual({ outcome: 'queued' })
    expect(f.promptCalls[1]).toMatchObject({ requestId: 'discord:m-2', sessionId: 'preallocated-1' })

    const second = await f.mainline.continueInThread({
      applicationId: APP, guildId: GUILD, threadId: 'thread-1',
      sessionId: 'preallocated-1', messageId: 'm-3', prompt: 'and the metrics',
    })
    expect(second).toEqual({ outcome: 'queued' })
    // Ownership stays with the FIRST submitted turn.
    expect(f.turnTracker.active('preallocated-1')?.requestId).toBe('discord:m-1')
    expect(f.promptCalls).toHaveLength(3)
  })
})

describe('session mainline with images (16.50)', () => {
  const WIRE_IMAGE = {
    url: 'https://cdn.discordapp.com/attachments/1/2/chart.png?ex=abc',
    filename: 'chart.png',
    declaredSize: 1234,
    contentType: 'image/png',
  }

  it('admits a mention with images: collects, then submits the images with the prompt', async () => {
    const f = createFixture()

    const result = await f.mainline.admitMention({
      applicationId: APP,
      guildId: GUILD,
      channelId: 'channel-1',
      messageId: 'm-img-1',
      authorId: 'member-1',
      workspaceId: 'ws-1',
      prompt: 'what does this chart say',
      images: [WIRE_IMAGE],
    })

    expect(result).toEqual({ outcome: 'admitted', threadId: 'thread-1', sessionId: 'preallocated-1' })
    // The declared filename never reaches the collector: only download facts.
    expect(f.collectCalls).toEqual([{
      attachments: [{ url: WIRE_IMAGE.url, declaredSize: WIRE_IMAGE.declaredSize, contentType: WIRE_IMAGE.contentType }],
    }])
    expect(f.promptCalls).toEqual([{
      requestId: 'discord:m-img-1',
      sessionId: 'preallocated-1',
      prompt: 'what does this chart say',
      mode: 'queue',
      images: [{ mediaType: 'image/png', base64: 'cG5n' }],
    }])
  })

  it('short-circuits before thread creation when collection fails', async () => {
    const f = createFixture({
      collect: () => Promise.resolve({ outcome: 'failed', reason: 'timeout' }),
    })

    const result = await f.mainline.admitMention({
      applicationId: APP,
      guildId: GUILD,
      channelId: 'channel-1',
      messageId: 'm-img-2',
      authorId: 'member-1',
      workspaceId: 'ws-1',
      prompt: 'what does this chart say',
      images: [WIRE_IMAGE],
    })

    expect(result).toEqual({ outcome: 'image-failed', reason: 'timeout' })
    expect(f.threadRequests).toHaveLength(0)
    expect(f.promptCalls).toHaveLength(0)
    expect(f.turnTracker.active('preallocated-1')).toBeUndefined()
  })

  it('names the thread after the image filename when the mention carries no text', async () => {
    const f = createFixture()

    const result = await f.mainline.admitMention({
      applicationId: APP,
      guildId: GUILD,
      channelId: 'channel-1',
      messageId: 'm-img-3',
      authorId: 'member-1',
      workspaceId: 'ws-1',
      prompt: '',
      images: [WIRE_IMAGE],
    })

    expect(result).toEqual({ outcome: 'admitted', threadId: 'thread-1', sessionId: 'preallocated-1' })
    expect(f.threadRequests[0]?.threadName).toBe('chart.png')
  })

  it('never calls the collector for a text-only mention', async () => {
    const f = createFixture()

    await f.mainline.admitMention({
      applicationId: APP,
      guildId: GUILD,
      channelId: 'channel-1',
      messageId: 'm-plain-1',
      authorId: 'member-1',
      workspaceId: 'ws-1',
      prompt: 'fix the bug',
    })

    expect(f.collectCalls).toHaveLength(0)
  })

  it('collects and submits images for a continuation message too', async () => {
    const f = createFixture()
    await f.mainline.admitMention({
      applicationId: APP,
      guildId: GUILD,
      channelId: 'channel-1',
      messageId: 'm-1',
      authorId: 'member-1',
      workspaceId: 'ws-1',
      prompt: 'fix the bug',
    })

    const result = await f.mainline.continueInThread({
      applicationId: APP,
      guildId: GUILD,
      threadId: 'thread-1',
      sessionId: 'preallocated-1',
      messageId: 'm-img-4',
      prompt: '',
      images: [WIRE_IMAGE],
    })

    expect(result).toEqual({ outcome: 'queued' })
    expect(f.promptCalls[1]).toMatchObject({
      requestId: 'discord:m-img-4',
      images: [{ mediaType: 'image/png', base64: 'cG5n' }],
    })
  })
})
