/**
 * Twin smoke (E2E seam, Kimaki discipline): the REAL gateway client and REAL
 * REST client run against a local Discord API twin — the same wire protocol —
 * while DSH stays a deterministic fake. Only Discord-visible state is
 * asserted (threads, messages); internal logging is never asserted.
 *
 * The message mainline and the interaction surface (bind / stop / steer)
 * are both smoke-driven end to end over the twin.
 */

import { DigitalDiscord } from 'discord-digital-twin'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createInteractionRouter } from '../src/features/interaction-router.js'
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
import { channelBindingKey, parseChannelBindingKey, threadBindingKey } from '../src/state/domain.js'
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

    // The durable binding and the at-most-once prompt both landed. Wait on
    // the prompt: the binding commits before the DSH call in the flow.
    await vi.waitFor(() => { expect(promptCalls).toHaveLength(1) })
    expect(threadRows.get(threadBindingKey({ applicationId: BOT, guildId: GUILD, threadId: thread.id }))?.sessionId)
      .toBe('sess-twin-1')
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
    await vi.waitFor(() => { expect(promptCalls).toHaveLength(2) })
    expect(promptCalls[1]).toMatchObject({
      sessionId: 'sess-twin-1',
      prompt: 'also check the logs',
      mode: 'queue',
    })
    expect(promptCalls[1]?.requestId).not.toBe(promptCalls[0]?.requestId)
  }, 20_000)
})

describe('twin smoke: interaction surface (bind / stop / steer)', () => {
  let discord: DigitalDiscord
  let rest: SharedRestClient
  let channelId: string
  let threadId: string
  const runtimeRef: { current: DiscordAdapterRuntime | undefined } = { current: undefined }
  const cancelCalls: string[] = []
  const steerCalls: Array<{ sessionId: string; prompt: string }> = []
  const threadRows = new Map<string, ThreadBinding>()
  const rowMap = new Map<string, ChannelBinding>()
  let turnTracker: ReturnType<typeof createTurnTracker>

  beforeAll(async () => {
    discord = new DigitalDiscord({
      botToken: 'twin-test-token',
      botUser: { id: BOT, username: 'dsh' },
      dbUrl: ':memory:',
      guild: { id: GUILD, name: 'Twin Guild' },
      channels: [{ id: CHANNEL, name: 'tmp', type: 0 }],
      users: [{ id: USER, username: 'Addo' }],
    })
    await discord.start()
    rest = createSharedRestClient({ token: discord.botToken, apiBase: `${discord.restUrl}/v10` })

    turnTracker = createTurnTracker()
    const runtimeRef: { current: DiscordAdapterRuntime | undefined } = { current: undefined }
    const interactionRouter = createInteractionRouter({
      policy: () => ({
        allowedGuildIds: [GUILD],
        memberUserIds: [USER],
        memberRoleIds: [],
        administratorUserIds: [USER],
        administratorRoleIds: [],
        deniedUserIds: [],
        deniedRoleIds: [],
        hostOperatorUserIds: [],
      }),
      applicationId: () => BOT,
      registry: () => runtimeRef.current?.registry,
      approvals: createApprovalStore({ get: () => undefined, put: async () => {} }),
      approvalRespondPort: { respond: () => Promise.resolve({ outcome: 'confirmed' as const }) },
      turnTracker,
      queueSnapshots: new Map(),
      dsh: {
        cancel: (sessionId: string) => {
          cancelCalls.push(sessionId)
          return Promise.resolve({ outcome: 'accepted' as const })
        },
        steer: (sessionId: string, prompt: string) => {
          steerCalls.push({ sessionId, prompt })
          return Promise.resolve({ outcome: 'accepted' as const })
        },
        removeQueueItem: () => Promise.resolve({ outcome: 'accepted' as const }),
        readWorkspaceDetail: () => Promise.resolve({
          outcome: 'found' as const,
          workspace: { id: 'ws-1', title: 'tmp', path: '/tmp' },
        }),
      },
      catalogPort: {
        listWorkspaces: () => Promise.resolve({ outcome: 'completed' as const, workspaces: [{ id: 'ws-1', title: 'tmp' }] }),
      },
      resolver: {
        resolve: (reference) => reference === 'ws-1'
          ? Promise.resolve({ outcome: 'found' as const, workspace: { id: 'ws-1', title: 'tmp' } })
          : Promise.resolve({ outcome: 'stale' as const }),
      },
      channelBinding: (guildId, cid) => rowMap.get(channelBindingKey({ applicationId: BOT, guildId, channelId: cid })),
      findBoundChannelFor: (guildId, workspaceId) => {
        for (const [key, binding] of rowMap) {
          if (binding.workspaceId !== workspaceId) continue
          const parsed = parseChannelBindingKey(key)
          if (parsed?.guildId === guildId) return parsed.channelId
        }
        return undefined
      },
      sessionForThread: (guildId, tid) =>
        threadRows.get(threadBindingKey({ applicationId: BOT, guildId, threadId: tid }))?.sessionId,
      ensureWorkspaceChannel: async (options) => {
        // Minimal provisioning over the twin: reuse the same-named channel,
        // else create a -2 sibling — mirroring index's Kimaki placement.
        const listed = await rest.request<Array<{ id: string; name: string; type: number }>>('GET', `/guilds/${options.guildId}/channels`)
        const channels = listed.outcome === 'completed' && Array.isArray(listed.body) ? listed.body : []
        const bind = (cid: string): void => {
          rowMap.set(channelBindingKey({ applicationId: BOT, guildId: options.guildId, channelId: cid }), {
            workspaceId: options.workspaceId, revision: 1, boundBy: options.actorId, boundAtMs: 1,
          })
        }
        const sameName = channels.find(c => c.name === options.title && c.type === 0)
        if (sameName !== undefined) {
          bind(sameName.id)
          return { channelId: sameName.id, created: false }
        }
        const made = await rest.request<{ id?: string } | undefined>('POST', `/guilds/${options.guildId}/channels`, {
          name: `${options.title}-2`, type: 0,
        })
        if (made.outcome !== 'completed' || typeof made.body?.id !== 'string') return undefined
        bind(made.body.id)
        return { channelId: made.body.id, created: true }
      },
      rest: () => Promise.resolve(rest),
      log: () => {},
      warn: () => {},
    })

    runtimeRef.current = startDiscordAdapter({
      tokenProvider: () => Promise.resolve(discord.botToken),
      socketFactory: twinSocket,
      policy: () => ({
        allowedGuildIds: [GUILD],
        memberUserIds: [USER],
        memberRoleIds: [],
        administratorUserIds: [USER],
        administratorRoleIds: [],
        deniedUserIds: [],
        deniedRoleIds: [],
        hostOperatorUserIds: [],
      }),
      selfUserIdProvider: () => Promise.resolve(BOT),
      intents: (1 << 0) | (1 << 1) | (1 << 9) | (1 << 15),
      applicationId: () => BOT,
      mainline: {
        admitMention: () => Promise.resolve({ outcome: 'admitted', threadId: 't', sessionId: 's' }),
        continueInThread: () => Promise.resolve({ outcome: 'queued' }),
      },
      gatewayUrl: `${discord.gatewayUrl}?v=10&encoding=json`,
      bindings: {
        workspaceForChannel: () => undefined,
        sessionForThread: (guildId, tid) =>
          threadRows.get(threadBindingKey({ applicationId: BOT, guildId, threadId: tid }))?.sessionId,
      },
      approvals: createApprovalStore({ get: () => undefined, put: async () => {} }),
      questions: createQuestionStore(),
      status: createAdapterStatusTracker(),
      routeInteraction: (event, token) => {
        if (event.kind !== 'interaction') return
        return interactionRouter.route(event, token)
      },
    })
    await new Promise(resolve => { setTimeout(resolve, 500) })

    // A task thread the control commands can address.
    const source = await discord.channel(CHANNEL).user(USER).sendMessage({ content: 'task one' })
    const made = await rest.request<{ id?: string } | undefined>(
      'POST',
      `/channels/${CHANNEL}/messages/${source.id}/threads`,
      { name: 'task one', type: 11, auto_archive_duration: 1440 },
    )
    if (made.outcome === 'completed' && typeof made.body?.id === 'string') {
      threadId = made.body.id
      threadRows.set(threadBindingKey({ applicationId: BOT, guildId: GUILD, threadId }), {
        sessionId: 'sess-1', workspaceId: 'ws-1', revision: 1, createdBy: USER, createdAtMs: 1,
      })
    }
    channelId = CHANNEL
  }, 20_000)

  afterAll(async () => {
    runtimeRef.current?.dispose()
    await discord.stop()
  })

  it('binds a workspace through slash command and confirm button over the twin', async () => {
    const interaction = await discord.simulateSlashCommand({
      channelId, userId: USER, name: 'project',
      options: [{ name: 'bind', type: 1, options: [{ name: 'workspace', type: 3, value: 'ws-1' }] }],
    })
    const ack = await discord.channel(channelId).waitForInteractionAck({ interactionId: interaction.id })
    expect(ack.acknowledged).toBe(true)

    // The ephemeral plan reply carries the confirm/cancel buttons.
    const reply = await discord.channel(channelId).waitForBotReply()
    const row = (reply.components?.[0] as { components?: Array<{ custom_id?: string; label?: string }> } | undefined)?.components ?? []
    const confirmId = row.find(button => button.label === '确认绑定')?.custom_id
    expect(confirmId).toBeDefined()
    expect(typeof confirmId).toBe('string')

    await discord.simulateButtonClick({ channelId, userId: USER, messageId: reply.id, customId: confirmId ?? '' })
    await new Promise(resolve => { setTimeout(resolve, 400) })

    // Provisioning landed: the followup reports the created (or reused)
    // home channel, and the durable binding was written.
    const result = await discord.channel(channelId).waitForMessage({
      predicate: message => message.content.includes('已为工作区') || message.content.includes('已存在于'),
    })
    expect(result.content).toContain('<#')
    const keys = [...rowMap.values()]
    expect(keys.some(binding => binding.workspaceId === 'ws-1')).toBe(true)
  }, 20_000)

  it('stops the thread-owned active turn', async () => {
    expect(typeof threadId).toBe('string')
    const registered = turnTracker.register({ sessionId: 'sess-1', requestId: 'discord:m-1', threadId })
    expect(registered.ok).toBe(true)

    const interaction = await discord.simulateSlashCommand({ channelId: threadId, userId: USER, name: 'stop' })
    await discord.channel(threadId).waitForInteractionAck({ interactionId: interaction.id })
    const reply = await discord.channel(threadId).waitForMessage({ predicate: message => message.content.includes('已停止') })
    expect(reply.content).toContain('已停止')
    expect(((reply.flags ?? 0) & 64) !== 0).toBe(true)
    expect(cancelCalls).toEqual(['sess-1'])
  }, 20_000)

  it('steers the thread-owned active turn', async () => {
    const registered = turnTracker.register({ sessionId: 'sess-1', requestId: 'discord:m-2', threadId })
    expect(registered.ok).toBe(true)

    const interaction = await discord.simulateSlashCommand({
      channelId: threadId, userId: USER, name: 'steer',
      options: [{ name: 'prompt', type: 3, value: 'focus on auth' }],
    })
    await discord.channel(threadId).waitForInteractionAck({ interactionId: interaction.id })
    const reply = await discord.channel(threadId).waitForMessage({ predicate: message => message.content.includes('已插话') })
    expect(reply.content).toBe('↪️ 已插话。')
    expect(steerCalls).toEqual([{ sessionId: 'sess-1', prompt: 'focus on auth' }])
  }, 20_000)
})
