/**
 * Twin smoke (E2E seam, Kimaki discipline): the REAL gateway client and REAL
 * REST client run against a local Discord API twin — the same wire protocol —
 * while DSH stays a deterministic fake. Only Discord-visible state is
 * asserted (threads, messages); internal logging is never asserted.
 *
 * Scope note: interaction routing (/project bind, /stop, /steer) still lives
 * in the Host composition root and is covered by 15.10 manual runs; this
 * file smoke-drives the message mainline (mention → anchored thread → queue
 * continuation) end to end over the twin.
 */

import { DigitalDiscord } from 'discord-digital-twin'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startDiscordAdapter, type DiscordAdapterRuntime } from '../src/compose.js'
import { createSharedRestClient, type SharedRestClient } from '../src/discord/rest.js'
import { createRestThreadPort } from '../src/discord/thread-port.js'
import { createSessionMainline } from '../src/features/session-mainline.js'
import { createThreadCreationFlow, type DiscordThreadPort } from '../src/features/thread-creation.js'
import { createSessionCreationFlow, type DshSessionPort } from '../src/features/session-creation.js'
import { createPromptSubmissionFlow, type DshPromptPort } from '../src/features/prompt-submission.js'
import { createTurnTracker } from '../src/features/turn-ownership.js'
import { createAdapterStatusTracker } from '../src/features/adapter-status.js'
import { createApprovalStore } from '../src/features/approval-store.js'
import { createQuestionStore } from '../src/features/question-store.js'
import { channelBindingKey, threadBindingKey } from '../src/state/domain.js'
import { createBindingStore } from '../src/state/bindings.js'
import { createIntentStore } from '../src/state/intents.js'
import { createKvTableStub } from './helpers/kv-table.js'
import type { ChannelBinding, ThreadBinding } from '../src/state/records.js'
import type { GatewaySocket } from '../src/gateway/gateway.js'

const BOT = '111111111111111111'
const USER = '222222222222222222'
const GUILD = '333333333333333333'
const CHANNEL = '444444444444444444'

/** Translate the browser-style WebSocket events onto the adapter contract. */
function twinSocket(url: string): GatewaySocket {
  const ws = new WebSocket(url)
  const socket: GatewaySocket = {
    url,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close: (code?: number) => { ws.close(code ?? 1000) },
    terminate: () => { ws.close(1000) },
    send: (data: string) => { ws.send(data) },
  }
  ws.addEventListener('open', () => { socket.onopen?.() })
  ws.addEventListener('message', (event) => {
    socket.onmessage?.(typeof event.data === 'string' ? event.data : String(event.data))
  })
  ws.addEventListener('close', (event) => { socket.onclose?.(event.code) })
  ws.addEventListener('error', () => { socket.onerror?.(new Error('socket error')) })
  return socket
}

describe('twin smoke: mention mainline over the real wire', () => {
  let discord: DigitalDiscord
  let rest: SharedRestClient
  let runtime: DiscordAdapterRuntime
  const promptCalls: Array<{ requestId: string; sessionId: string; prompt: string; mode: string }> = []
  const threadRows = new Map<string, ThreadBinding>()
  const rowMap = new Map<string, ChannelBinding>()

  beforeAll(async () => {
    discord = new DigitalDiscord({
      botToken: 'twin-test-token',
      botUser: { id: BOT, username: 'dsh' },
      guild: { id: GUILD, name: 'Twin Guild' },
      channels: [{ id: CHANNEL, name: 'tmp', type: 0 }], // GuildText
      users: [{ id: USER, username: 'Addo' }],
    })
    await discord.start()
    rest = createSharedRestClient({ token: discord.botToken, apiBase: `${discord.restUrl}/v10` })

    // The composed session mainline: real Discord ports over the twin, DSH
    // deterministic (accepted outcomes), stores process-local.
    const intents = createIntentStore(createKvTableStub())
    const threadBindings = createBindingStore<ThreadBinding>({
      get: key => threadRows.get(key),
      put: (key, record) => { threadRows.set(key, record); return Promise.resolve() },
      delete: key => Promise.resolve(threadRows.delete(key)),
    })
    rowMap.set(channelBindingKey({ applicationId: BOT, guildId: GUILD, channelId: CHANNEL }), {
      workspaceId: 'ws-1', revision: 1, boundBy: USER, boundAtMs: 1,
    })
    const threadPort: DiscordThreadPort = createRestThreadPort({
      request: async (method, path, body) => rest.request(method, path, body),
    }, { autoArchiveMinutes: () => 1440 })
    const sessions: DshSessionPort = {
      createSession: request => Promise.resolve({ outcome: 'completed', sessionId: request.sessionId }),
    }
    const prompts: DshPromptPort = {
      submit: request => {
        promptCalls.push(request)
        return Promise.resolve({ outcome: 'accepted' })
      },
    }
    const mainline = createSessionMainline({
      threads: createThreadCreationFlow({ intents, discord: threadPort, nowMs: () => Date.now() }),
      sessions: createSessionCreationFlow({
        sessions,
        threadBindings,
        newSessionId: () => 'sess-twin-1',
      }),
      prompts: createPromptSubmissionFlow({ prompts, intents, nowMs: () => Date.now() }),
      turns: createTurnTracker(),
    })

    runtime = startDiscordAdapter({
      tokenProvider: () => Promise.resolve(discord.botToken),
      socketFactory: twinSocket,
      policy: () => ({
        allowedGuildIds: [GUILD],
        memberUserIds: [USER],
        memberRoleIds: [],
        administratorUserIds: [],
        administratorRoleIds: [],
        deniedUserIds: [],
        deniedRoleIds: [],
        hostOperatorUserIds: [],
      }),
      selfUserIdProvider: () => Promise.resolve(BOT),
      intents: (1 << 0) | (1 << 1) | (1 << 9) | (1 << 15),
      applicationId: () => BOT,
      mainline,
      gatewayUrl: `${discord.gatewayUrl}?v=10&encoding=json`,
      bindings: {
        workspaceForChannel: (guildId, cid) =>
          rowMap.get(channelBindingKey({ applicationId: BOT, guildId, channelId: cid }))?.workspaceId,
        sessionForThread: (guildId, threadId) =>
          threadRows.get(threadBindingKey({ applicationId: BOT, guildId, threadId }))?.sessionId,
      },
      approvals: createApprovalStore({ get: () => undefined, put: async () => {} }),
      questions: createQuestionStore(),
      status: createAdapterStatusTracker(),
    })
    // Wait for the twin's READY: our gateway has identified and received
    // GUILD_CREATE before any user simulation is meaningful.
    await new Promise(resolve => { setTimeout(resolve, 500) })
  }, 20_000)

  afterAll(async () => {
    runtime.dispose()
    await discord.stop()
  })

  it('admits a mention into an anchored thread and submits exactly one prompt', async () => {
    const source = await discord.channel(CHANNEL).user(USER).sendMessage({
      content: `<@${BOT}> hello world`,
    })

    const scope = discord.channel(CHANNEL)
    const thread = await scope.waitForThread({
      timeout: 10_000,
      predicate: t => t.name === 'hello world',
    })

    // The task message anchors the thread as its first post.
    const threadScope = discord.thread(thread.id)
    const messages = await threadScope.getMessages()
    expect(messages.at(-1)?.id).toBe(source.id)

    // The durable binding and the at-most-once prompt both landed.
    expect(threadRows.get(threadBindingKey({ applicationId: BOT, guildId: GUILD, threadId: thread.id }))?.sessionId)
      .toBe('sess-twin-1')
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0]).toEqual({
      requestId: `discord:${source.id}`,
      sessionId: 'sess-twin-1',
      prompt: 'hello world',
      mode: 'queue',
    })
  }, 20_000)

  it('queues a follow-up posted inside the thread without a mention', async () => {
    const scope = discord.channel(CHANNEL)
    const thread = await scope.waitForThread({ timeout: 10_000, predicate: t => t.name === 'hello world' })

    await discord.thread(thread.id).user(USER).sendMessage({ content: 'also check the logs' })
    // The continuation rides the same at-most-once flow on a new intent.
    await new Promise(resolve => { setTimeout(resolve, 300) })
    expect(promptCalls).toHaveLength(2)
    expect(promptCalls[1]).toMatchObject({
      sessionId: 'sess-twin-1',
      prompt: 'also check the logs',
      mode: 'queue',
    })
    expect(promptCalls[1]?.requestId).not.toBe(promptCalls[0]?.requestId)
  }, 20_000)
})
