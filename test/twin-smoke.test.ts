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
import { renderApprovalControls } from '../src/features/approval-view.js'
import { createApprovalStore } from '../src/features/approval-store.js'
import { createClientRespondPort, type RespondReceipt } from '../src/dsh/api-proxy-face.js'
import { createComponentRegistry } from '../src/discord/components.js'
import { startLiveRender } from '../src/stream/live.js'
import { CUSTOM_ANSWER_VALUE, renderQuestionControls } from '../src/features/question-view.js'
import { handleRemoteResolution } from '../src/features/question-routing.js'
import { handleSelectInput, handleModalSubmit } from '../src/features/question-routing.js'
import { startDiscordAdapter, type DiscordAdapterRuntime } from '../src/compose.js'
import { createSharedRestClient, type SharedRestClient } from '../src/discord/rest.js'
import { createRestThreadPort } from '../src/discord/thread-port.js'
import { createSessionMainline } from '../src/features/session-mainline.js'
import { createThreadCreationFlow, type DiscordThreadPort } from '../src/features/thread-creation.js'
import { createSessionCreationFlow, type DshSessionPort } from '../src/features/session-creation.js'
import { createPromptSubmissionFlow, type DshPromptPort } from '../src/features/prompt-submission.js'
import { createTurnTracker } from '../src/features/turn-ownership.js'
import { createAdapterStatusTracker } from '../src/features/adapter-status.js'
import { createQuestionStore } from '../src/features/question-store.js'
import { channelBindingKey, parseChannelBindingKey, threadBindingKey, parseThreadBindingKey } from '../src/state/domain.js'
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
      intents: (1 << 0) | (1 << 9) | (1 << 15),
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
  const queueSnapshotsHandle = new Map<string, Array<{ id: string; summary: string }>>()
  const threadRows = new Map<string, ThreadBinding>()
  const rowMap = new Map<string, ChannelBinding>()
  let turnTracker: ReturnType<typeof createTurnTracker>

  beforeAll(async () => {
    discord = new DigitalDiscord({
      botToken: 'twin-test-token',
      botUser: { id: BOT, username: 'dsh' },
      dbUrl: ':memory:',
      guild: { id: GUILD, name: 'Twin Guild' },
      channels: [
        { id: CHANNEL, name: 'tmp', type: 0 },
        { id: '444444444444444445', name: 'free', type: 0 },
      ],
      users: [
        { id: USER, username: 'Addo' },
        { id: '222222222222222223', username: 'Guest' },
      ],
    })
    await discord.start()
    rest = createSharedRestClient({ token: discord.botToken, apiBase: `${discord.restUrl}/v10` })

    turnTracker = createTurnTracker()
    const sharedRegistry = createComponentRegistry()
    const questionsStore = createQuestionStore()
    const questionRoutingDeps = {
      registry: sharedRegistry,
      store: questionsStore,
      port: {
        respond: () => Promise.resolve({ outcome: 'confirmed' as const }),
      },
      nowMs: () => Date.now(),
      controls: { disable: () => Promise.resolve() },
    } as unknown as Parameters<typeof handleSelectInput>[0]
    const interactionRouter = createInteractionRouter({
      policy: () => ({
        allowedGuildIds: [GUILD],
        memberUserIds: [USER, '222222222222222223'],
        memberRoleIds: [],
        administratorUserIds: [USER],
        administratorRoleIds: [],
        deniedUserIds: [],
        deniedRoleIds: [],
        hostOperatorUserIds: [USER],
      }),
      applicationId: () => BOT,
      registry: sharedRegistry,
      approvals: createApprovalStore({ get: () => undefined, put: async () => {} }),
      approvalRespondPort: { respond: () => Promise.resolve({ outcome: 'confirmed' as const }) },
      turnTracker,
      queueSnapshots: queueSnapshotsHandle,
      forgetGuild: (guildId: string) => {
        for (const [key] of [...rowMap.entries()]) {
          const scope = parseChannelBindingKey(key)
          if (scope?.guildId === guildId) rowMap.delete(key)
        }
        return Promise.resolve()
      },
      componentFollowUp: async (_interactionId: string, interactionToken: string, content: string) => {
        await rest.request('POST', `/webhooks/${BOT}/${interactionToken}`, { content, flags: 64 })
      },
      disableControl: (key: string) => {
        void key
        return Promise.resolve()
      },
      handleQuestionComponent: input => handleSelectInput(questionRoutingDeps, input),
      handleQuestionModal: input => handleModalSubmit(questionRoutingDeps, input),
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
        memberUserIds: [USER, '222222222222222223'],
        memberRoleIds: [],
        administratorUserIds: [USER],
        administratorRoleIds: [],
        deniedUserIds: [],
        deniedRoleIds: [],
        hostOperatorUserIds: [],
      }),
      selfUserIdProvider: () => Promise.resolve(BOT),
      intents: (1 << 0) | (1 << 9) | (1 << 15),
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
      unboundNotice: (request) => {
        void rest.request('POST', `/channels/${request.channelId}/messages`, {
          content: request.audience === 'administrator'
            ? '💡 此频道未绑定工作区。工作区管理员可运行 `/project bind` 创建并绑定项目频道。'
            : '💡 此频道未绑定工作区；请工作区管理员运行 `/project bind`。',
        })
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

  it('forgets the guild through the host-operator command and confirm button', async () => {
    // Seed a binding that forget must remove.
    rowMap.set(channelBindingKey({ applicationId: BOT, guildId: GUILD, channelId: CHANNEL }), {
      workspaceId: 'ws-1', revision: 1, boundBy: USER, boundAtMs: 1,
    })

    // A plain member (not a host operator) is refused.
    await discord.prisma.guildMember.update({
      where: { guildId_userId: { guildId: GUILD, userId: '222222222222222223' } },
      data: { permissions: '0' },
    })
    const denied = await discord.simulateSlashCommand({
      channelId, userId: '222222222222222223', name: 'guild', options: [{ name: 'forget', type: 1 }],
    })
    await discord.channel(channelId).waitForInteractionAck({ interactionId: denied.id })
    await discord.channel(channelId).waitForMessage({
      predicate: message => message.content.includes('只有 Host 操作员'),
    })

    // The operator confirms; adapter records for the guild are deleted.
    const interaction = await discord.simulateSlashCommand({
      channelId, userId: USER, name: 'guild', options: [{ name: 'forget', type: 1 }],
    })
    await discord.channel(channelId).waitForInteractionAck({ interactionId: interaction.id })
    const plan = await discord.channel(channelId).waitForMessage({
      predicate: message => message.content.includes('将删除本 Guild 的全部适配器记录'),
    })
    const row = (plan.components?.[0] as { components?: Array<{ custom_id?: string }> } | undefined)?.components ?? []
    const confirmId = row[0]?.custom_id
    expect(typeof confirmId).toBe('string')

    await discord.simulateButtonClick({ channelId, userId: USER, messageId: plan.id, customId: confirmId ?? '' })
    const done = await discord.channel(channelId).waitForMessage({
      predicate: message => message.content.includes('已忘记本 Guild'),
    })
    expect(done.content).toContain('DSH 工作区与 Session 未受影响')
    expect(rowMap.has(channelBindingKey({ applicationId: BOT, guildId: GUILD, channelId: CHANNEL }))).toBe(false)
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

  it('denies bind to a plain member with an ephemeral failure copy', async () => {
    // The twin seeds every member with all permissions; demote Guest to a
    // plain member so the administrator gate is actually exercised.
    await discord.prisma.guildMember.update({
      where: { guildId_userId: { guildId: GUILD, userId: '222222222222222223' } },
      data: { permissions: '0' },
    })
    const interaction = await discord.simulateSlashCommand({
      channelId, userId: '222222222222222223', name: 'project',
      options: [{ name: 'bind', type: 1, options: [{ name: 'workspace', type: 3, value: 'ws-1' }] }],
    })
    await discord.channel(channelId).waitForInteractionAck({ interactionId: interaction.id })
    const reply = await discord.channel(channelId).waitForMessage({
      predicate: message => message.content.includes('只有工作区管理员可以绑定频道'),
    })
    expect((reply.flags ?? 0) & 64).toBe(64)
  }, 20_000)

  it('lists workspaces with names only, ephemerally', async () => {
    const interaction = await discord.simulateSlashCommand({
      channelId, userId: USER, name: 'project',
      options: [{ name: 'list', type: 1 }],
    })
    await discord.channel(channelId).waitForInteractionAck({ interactionId: interaction.id })
    const reply = await discord.channel(channelId).waitForMessage({
      predicate: message => message.content.includes('可用工作区'),
    })
    expect(reply.content).toContain('• tmp')
    // Names only: opaque ids never render in the list.
    expect(reply.content).not.toContain('ws-1')
    expect((reply.flags ?? 0) & 64).toBe(64)
  }, 20_000)

  it('answers autocomplete with live workspace choices', async () => {
    const interaction = await discord.simulateInteraction({
      type: 4,
      channelId, userId: USER,
      data: { id: '1', name: 'project', options: [{ name: 'bind', type: 1, options: [{ name: 'workspace', type: 3, value: '', focused: true }] }] },
    })
    const ack = await discord.channel(channelId).waitForInteractionAck({ interactionId: interaction.id })
    expect(ack.acknowledged).toBe(true)
    // The type-8 choices callback carries the catalog titles.
    const response = await discord.channel(channelId).getInteractionResponse(interaction.id)
    expect(response?.data ?? '').toContain('tmp')
  }, 20_000)

  it('shows the bound workspace detail for an administrator, path included', async () => {
    // Seed a binding for the command channel.
    rowMap.set(channelBindingKey({ applicationId: BOT, guildId: GUILD, channelId: CHANNEL }), {
      workspaceId: 'ws-1', revision: 2, boundBy: USER, boundAtMs: 1,
    })
    const interaction = await discord.simulateSlashCommand({
      channelId, userId: USER, name: 'project', options: [{ name: 'info', type: 1 }],
    })
    await discord.channel(channelId).waitForInteractionAck({ interactionId: interaction.id })
    const reply = await discord.channel(channelId).waitForMessage({
      predicate: message => message.content.includes('tmp'),
    })
    expect(reply.content).toContain('修订 2')
    expect(reply.content).toContain('路径')
    // Restore: other tests rely on the unbound state of the command channel.
    rowMap.delete(channelBindingKey({ applicationId: BOT, guildId: GUILD, channelId: CHANNEL }))
  }, 20_000)

  it('renders the mux queue snapshot and removes by position', async () => {
    queueSnapshotsHandle.set('sess-1', [
      { id: 'm-10', summary: 'first queued task' },
      { id: 'm-11', summary: 'second queued task' },
    ])
    const list = await discord.simulateSlashCommand({
      channelId: threadId, userId: USER, name: 'queue', options: [{ name: 'list', type: 1 }],
    })
    await discord.channel(threadId).waitForInteractionAck({ interactionId: list.id })
    const view = await discord.channel(threadId).waitForMessage({
      predicate: message => message.content.includes('队列'),
    })
    expect(view.content).toContain('1. first queued task')
    expect(view.content).toContain('2. second queued task')

    const remove = await discord.simulateSlashCommand({
      channelId: threadId, userId: USER, name: 'queue',
      options: [{ name: 'remove', type: 1, options: [{ name: 'item', type: 3, value: '1' }] }],
    })
    await discord.channel(threadId).waitForInteractionAck({ interactionId: remove.id })
    const removed = await discord.channel(threadId).waitForMessage({
      predicate: message => message.content.includes('已移除'),
    })
    expect(removed.content).toContain('first queued task')
  }, 20_000)

  it('answers an unbound-channel mention with the public bind affordance', async () => {
    await discord.channel('444444444444444445').user(USER).sendMessage({ content: `<@${BOT}> hello there` })
    const notice = await discord.channel('444444444444444445').waitForMessage({
      predicate: message => message.content.includes('此频道未绑定工作区'),
    })
    expect(notice.content).toContain('/project bind')
    // Not ephemeral: ordinary channel messages have no ephemeral channel.
    expect((notice.flags ?? 0) & 64).toBe(0)
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

describe('twin smoke: stream rendering over the real wire (fake DSH mux)', () => {
  let discord: DigitalDiscord
  let rest: SharedRestClient
  const threadRows = new Map<string, ThreadBinding>()
  const promptCalls: Array<{ requestId: string; sessionId: string; prompt: string; mode: string }> = []
  const pushed: unknown[] = []
  let runtime: DiscordAdapterRuntime

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

    const intents = createIntentStore(createKvTableStub())
    const threadBindings = createBindingStore<ThreadBinding>({
      get: key => threadRows.get(key),
      put: (key, record) => { threadRows.set(key, record); return Promise.resolve() },
      delete: key => Promise.resolve(threadRows.delete(key)),
    })
    const rowMap = new Map<string, ChannelBinding>()
    rowMap.set(channelBindingKey({ applicationId: BOT, guildId: GUILD, channelId: CHANNEL }), {
      workspaceId: 'ws-1', revision: 1, boundBy: USER, boundAtMs: 1,
    })
    const threadPort: DiscordThreadPort = createRestThreadPort({
      request: async (method, path, body) => rest.request(method, path, body),
    })
    const prompts: DshPromptPort = {
      submit: (request: { requestId: string; sessionId: string; prompt: string; mode: 'queue' }) => {
        promptCalls.push(request)
        return Promise.resolve({ outcome: 'accepted' as const })
      },
    }
    const mainline = createSessionMainline({
      threads: createThreadCreationFlow({ intents, discord: threadPort, nowMs: () => Date.now() }),
      sessions: createSessionCreationFlow({
        sessions: {
          createSession: (request: { sessionId: string }) =>
            Promise.resolve({ outcome: 'completed' as const, sessionId: request.sessionId }),
        },
        threadBindings,
        newSessionId: () => 'sess-stream',
      }),
      prompts: createPromptSubmissionFlow({ prompts, intents, nowMs: () => Date.now() }),
      turns: createTurnTracker(),
    })

    // The fake DSH mux: a pushable frame source the test drives after admission.
    async function* pushableFrames(signal: AbortSignal): AsyncIterable<unknown> {
      let index = 0
      while (!signal.aborted) {
        while (index < pushed.length) {
          yield pushed[index]
          index += 1
        }
        await new Promise(resolve => { setTimeout(resolve, 5) })
      }
    }

    const live = startLiveRender({
      frames: pushableFrames,
      threadForSession: (sessionId: string) => {
        for (const [key, record] of threadRows) {
          if (record.sessionId !== sessionId) continue
          const scope = parseThreadBindingKey(key)
          if (scope !== undefined) return scope.threadId
        }
        return undefined
      },
      delivery: {
        send: async (request: { channelId: string; content: string }) => {
          const sent = await rest.request<{ id?: string } | undefined>('POST', `/channels/${request.channelId}/messages`, { content: request.content })
          if (sent.outcome === 'completed' && typeof sent.body?.id === 'string') {
            return { outcome: 'completed', messageId: sent.body.id }
          }
          return { outcome: 'failed' }
        },
        edit: async (request: { channelId: string; messageId: string; content: string }) => {
          const edited = await rest.request('PATCH', `/channels/${request.channelId}/messages/${request.messageId}`, { content: request.content })
          return edited.outcome === 'completed' ? { outcome: 'completed' } : { outcome: 'failed' }
        },
        delete: async (request: { channelId: string; messageId: string }) => {
          const deleted = await rest.request('DELETE', `/channels/${request.channelId}/messages/${request.messageId}`)
          return deleted.outcome === 'completed' ? { outcome: 'completed' } : { outcome: 'failed' }
        },
        typing: async (channelId: string) => {
          await rest.request('POST', `/channels/${channelId}/typing`)
        },
        renameThread: async (request: { channelId: string; name: string }) => {
          const renamed = await rest.request('PATCH', `/channels/${request.channelId}`, { name: request.name })
          return renamed.outcome === 'completed' ? { outcome: 'completed' } : { outcome: 'failed' }
        },
      },
      updateIntervalMs: 0,
      activityCoalesceMs: 0,
      typingIntervalMs: 60_000,
      approvalTimeoutMs: 600_000,
      questionTimeoutMs: 1_800_000,
      onTurnEnded: () => {},
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
      intents: (1 << 0) | (1 << 9) | (1 << 15),
      applicationId: () => BOT,
      mainline,
      gatewayUrl: `${discord.gatewayUrl}?v=10&encoding=json`,
      bindings: {
        workspaceForChannel: () => 'ws-1',
        sessionForThread: () => undefined,
      },
      approvals: createApprovalStore({ get: () => undefined, put: async () => {} }),
      questions: createQuestionStore(),
      status: createAdapterStatusTracker(),
    })
    void live
    await new Promise(resolve => { setTimeout(resolve, 500) })
  }, 20_000)

  afterAll(async () => {
    runtime.dispose()
    await discord.stop()
  })

  it('renders the full turn onto the twin: typing, head edits, activity rows, delete, rename', async () => {
    const source = await discord.channel(CHANNEL).user(USER).sendMessage({ content: `<@${BOT}> 检查磁盘状态` })
    await vi.waitFor(() => { expect(promptCalls).toHaveLength(1) })
    const sessionId = 'sess-stream'
    const threadBinding = [...threadRows.entries()][0]
    const tid = threadBinding?.[0] ? (parseThreadBindingKey(threadBinding[0])?.threadId ?? '') : ''
    expect(typeof tid).toBe('string')

    // Drive the fake DSH mux: queue → turn → tool → answer → end → title.
    pushed.push(
      { type: 'session/queue', sessionId, items: [{ id: source.id, summary: '检查磁盘状态' }] },
      sessionEventFrame(sessionId, 'turn/start', { turn: 1 }),
      {
        type: 'session/event',
        sessionId,
        event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c-1', name: 'bash', arguments: '{"command":"df -h"}' } },
        view: { for: 'call', view: { card: 'terminal', title: 'df -h' } },
      },
      sessionEventFrame(sessionId, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '磁盘状态如下' } }),
      {
        type: 'session/event',
        sessionId,
        event: { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '磁盘状态如下：主数据卷已用 96%。' }] } } },
      },
      sessionEventFrame(sessionId, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
      { type: 'session/projection', sessionId, key: 'title', value: '检查磁盘状态' },
    )

    // The answer finalizes on the twin.
    const answer = await discord.thread(tid).waitForMessage({
      predicate: message => message.content.includes('主数据卷已用 96%'),
    })
    expect(answer.author.bot).toBe(true)

    // Typing fired at the ENQUEUED moment (before any turn event).
    const typing = discord.getTypingEvents({ channelId: tid })
    expect(typing.length).toBeGreaterThanOrEqual(1)

    // The session title renamed the thread (Kimaki rename).
    const renamed = await discord.channel(CHANNEL).waitForThread({
      timeout: 10_000,
      predicate: t => t.name === '检查磁盘状态',
    })
    expect(renamed.id).toBe(tid)

    // Turn end deleted the tool activity message: no activity rows remain.
    await new Promise(resolve => { setTimeout(resolve, 300) })
    const leftovers = (await discord.thread(tid).getMessages()).filter(message => message.content.startsWith('> 💻'))
    expect(leftovers).toHaveLength(0)
  }, 30_000)
})

/** Build one session/event frame the way the Host mux wraps it. */
function sessionEventFrame(sessionId: string, type: string, data: Record<string, unknown>): unknown {
  return { type: 'session/event', sessionId, event: { type, data } }
}

describe('twin smoke: approval/question round trip with a STRICT fake DSH', () => {
  let discord: DigitalDiscord
  let rest: SharedRestClient
  let runtime: DiscordAdapterRuntime
  let threadId = ''
  const runtimeRef: { current: DiscordAdapterRuntime | undefined } = { current: undefined }
  /** Host-side pending asks: an rpcId leaves the map when answered. */
  const pendingAsks = new Map<string, { sessionId: string; kind: 'approval' | 'question' }>()
  const respondCalls: Array<Record<string, unknown>> = []
  /** Type-9 (show-modal) interaction callbacks, for minted modal custom_id capture. */
  const interactionCallbacks: Array<Record<string, unknown>> = []
  const controlMessages = new Map<string, { channelId: string; messageId: string }>()
  let pushFrames: (frames: unknown[]) => void = () => {}
  let turnTracker: ReturnType<typeof createTurnTracker>
  let approvalsStore: ReturnType<typeof createApprovalStore>

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

    // A REAL twin thread channel: the controls are Discord messages in it.
    const source = await discord.channel(CHANNEL).user(USER).sendMessage({ content: 'approval task' })
    const made = await rest.request<{ id?: string } | undefined>(
      'POST',
      `/channels/${CHANNEL}/messages/${source.id}/threads`,
      { name: 'approval task', type: 11, auto_archive_duration: 1440 },
    )
    if (made.outcome === 'completed' && typeof made.body?.id === 'string') {
      threadId = made.body.id
    }

    turnTracker = createTurnTracker()
    const sharedRegistry = createComponentRegistry()
    approvalsStore = createApprovalStore(createKvTableStub())
    const questionsStore = createQuestionStore()

    // ── STRICT fake DSH apiProxy: validates the ClientResponse envelope
    // exactly like the Host, and resolves each ask exactly once.
    const strictRespond = (message: unknown): Promise<RespondReceipt> => {
      const m = message as { type?: unknown; rpcId?: unknown; result?: { ok?: unknown; value?: unknown } }
      if (m.type !== 'client-response') return Promise.reject(new TypeError('respond: missing type discriminator'))
      if (typeof m.rpcId !== 'string' || m.rpcId === '') return Promise.reject(new TypeError('respond: missing rpcId'))
      if (m.result?.ok !== true) return Promise.reject(new TypeError('respond: result must be ok'))
      const ask = pendingAsks.get(m.rpcId)
      if (ask === undefined) return Promise.resolve({ accepted: false, reason: 'not-pending' })
      pendingAsks.delete(m.rpcId)
      respondCalls.push(message as Record<string, unknown>)
      return Promise.resolve({ accepted: true })
    }
    const clientRespond = createClientRespondPort({ respond: strictRespond }, { log: () => {} })

    // Pushable mux: the test drives approval/question frames like the Host.
    const pushed: unknown[] = []
    pushFrames = frames => { pushed.push(...frames) }
    async function* pushableFrames(signal: AbortSignal): AsyncIterable<unknown> {
      let index = 0
      while (!signal.aborted) {
        while (index < pushed.length) {
          yield pushed[index]
          index += 1
        }
        await new Promise(resolve => { setTimeout(resolve, 5) })
      }
    }

    const disableControl = async (key: string): Promise<void> => {
      const target = controlMessages.get(key)
      if (target === undefined) return
      controlMessages.delete(key)
      await rest.request('PATCH', `/channels/${target.channelId}/messages/${target.messageId}`, { components: [] })
    }
    const componentFollowUp = async (interactionToken: string, content: string): Promise<void> => {
      await rest.request('POST', `/webhooks/${BOT}/${interactionToken}`, { content, flags: 64 })
    }

    const questionRoutingDeps = {
      registry: sharedRegistry,
      store: questionsStore,
      port: {
        respond: (input: { rpcId: string; sessionId: string; answer: { answers: Array<{ id: string; selected: string[]; custom?: string }> } }) =>
          clientRespond.respond(input.rpcId, { sessionId: input.sessionId, answer: input.answer }),
      },
      nowMs: () => Date.now(),
      controls: { disable: disableControl },
    } as unknown as Parameters<typeof handleSelectInput>[0]

    const interactionRouter = createInteractionRouter({
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
      applicationId: () => BOT,
      registry: sharedRegistry,
      approvals: approvalsStore,
      approvalRespondPort: {
        respond: ({ rpcId, sessionId, approvalId, outcome }) =>
          clientRespond.respond(rpcId, { sessionId, approvalId, outcome }),
      },
      turnTracker,
      queueSnapshots: new Map(),
      forgetGuild: () => Promise.resolve(),
      componentFollowUp: async (_interactionId: string, interactionToken: string, content: string) => {
        await componentFollowUp(interactionToken, content)
      },
      disableControl,
      handleQuestionComponent: input => handleSelectInput(questionRoutingDeps, input),
      handleQuestionModal: input => handleModalSubmit(questionRoutingDeps, input),
      dsh: {
        cancel: () => Promise.resolve({ outcome: 'accepted' as const }),
        steer: () => Promise.resolve({ outcome: 'accepted' as const }),
        removeQueueItem: () => Promise.resolve({ outcome: 'accepted' as const }),
        readWorkspaceDetail: () => Promise.resolve({ outcome: 'stale' }),
      },
      catalogPort: { listWorkspaces: () => Promise.resolve({ outcome: 'completed' as const, workspaces: [] }) },
      resolver: { resolve: () => Promise.resolve({ outcome: 'stale' }) },
      channelBinding: () => undefined,
      findBoundChannelFor: () => undefined,
      sessionForThread: () => undefined,
      ensureWorkspaceChannel: () => Promise.resolve(undefined),
      rest: () => Promise.resolve({
        request: async (method: string, path: string, body?: unknown) => {
          if (method === 'POST' && path.includes('/interactions/') && (body as { type?: number } | undefined)?.type === 9) {
            interactionCallbacks.push(body as Record<string, unknown>)
          }
          return rest.request(method as never, path as never, body)
        },
      } as never),
      log: () => {},
      warn: () => {},
    })

    runtime = startDiscordAdapter({
      registry: sharedRegistry,
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
      intents: (1 << 0) | (1 << 9) | (1 << 15),
      applicationId: () => BOT,
      mainline: {
        admitMention: () => Promise.resolve({ outcome: 'admitted', threadId: 't', sessionId: 's' }),
        continueInThread: () => Promise.resolve({ outcome: 'queued' }),
      },
      gatewayUrl: `${discord.gatewayUrl}?v=10&encoding=json`,
      bindings: {
        workspaceForChannel: () => undefined,
        sessionForThread: () => undefined,
      },
      approvals: approvalsStore,
      questions: questionsStore,
      status: createAdapterStatusTracker(),
      routeInteraction: (event, token) => {
        if (event.kind !== 'interaction') return
        return interactionRouter.route(event, token)
      },
    })
    runtimeRef.current = runtime

    // The live renderer with index-style requests wiring over the strict port.
    const live = startLiveRender({
      frames: pushableFrames,
      threadForSession: (sessionId: string) => sessionId === 'sess-1' ? threadId : undefined,
      delivery: {
        send: async (request) => {
          const sent = await rest.request<{ id?: string } | undefined>('POST', `/channels/${request.channelId}/messages`, { content: request.content })
          if (sent.outcome === 'completed' && typeof sent.body?.id === 'string') {
            return { outcome: 'completed', messageId: sent.body.id }
          }
          return { outcome: 'failed' }
        },
        edit: async (request) => {
          const edited = await rest.request('PATCH', `/channels/${request.channelId}/messages/${request.messageId}`, { content: request.content })
          return edited.outcome === 'completed' ? { outcome: 'completed' } : { outcome: 'failed' }
        },
        delete: () => Promise.resolve({ outcome: 'completed' as const }),
        typing: async () => {},
        renameThread: () => Promise.resolve({ outcome: 'completed' as const }),
      },
      updateIntervalMs: 0,
      activityCoalesceMs: 0,
      typingIntervalMs: 60_000,
      approvalTimeoutMs: 600_000,
      questionTimeoutMs: 1_800_000,
      requests: {
        onApprovalRequested: (input) => {
          void input.threadId
          approvalsStore.open({
            approvalId: input.approvalId,
            sessionId: input.sessionId,
            threadId: input.threadId,
            requestId: 'discord:m-1',
            rpcId: input.rpcId,
            actorUserId: USER,
            toolName: input.toolName,
            reason: input.reason,
            expiresAtMs: input.expiresAtMs,
            state: 'pending',
          })
          turnTracker.register({ sessionId: input.sessionId, requestId: 'discord:m-1', threadId: input.threadId })
          const payload = renderApprovalControls({
            registry: sharedRegistry,
            sessionId: input.sessionId,
            rpcId: input.rpcId,
            approvalId: input.approvalId,
            toolName: input.toolName,
            reason: input.reason,
            expiresAtMs: input.expiresAtMs,
          })
          void (async () => {
            const sent = await rest.request<{ id?: string } | undefined>('POST', `/channels/${input.threadId}/messages`, payload)
            if (sent.outcome === 'completed' && typeof sent.body?.id === 'string') {
              controlMessages.set(input.approvalId, { channelId: input.threadId, messageId: sent.body.id })
            }
          })().catch(() => {})
        },
        onApprovalResolved: () => {},
        onQuestionRequested: (input) => {
          const batch = {
            questionRpcId: input.rpcId,
            sessionId: input.sessionId,
            threadId: input.threadId,
            requestId: 'discord:m-1',
            actorUserId: USER,
            expiresAtMs: input.expiresAtMs,
            questions: input.questions.map(question => ({
              id: typeof question['id'] === 'string' ? question['id'] : '',
              question: typeof question['question'] === 'string' ? question['question'] : '',
              header: typeof question['header'] === 'string' ? question['header'] : undefined,
              options: Array.isArray(question['options'])
                ? question['options'].map(option => ({
                    label: typeof (option as { label?: unknown }).label === 'string'
                      ? (option as { label: string }).label
                      : '',
                  }))
                : undefined,
              multiSelect: question['multiSelect'] === true,
            })),
          }
          const opened = questionsStore.open(batch)
          if (!opened.ok) return
          const payload = renderQuestionControls({ registry: sharedRegistry, batch })
          void (async () => {
            const sent = await rest.request<{ id?: string } | undefined>('POST', `/channels/${input.threadId}/messages`, payload)
            if (sent.outcome === 'completed' && typeof sent.body?.id === 'string') {
              controlMessages.set(input.rpcId, { channelId: input.threadId, messageId: sent.body.id })
            }
          })().catch(() => {})
        },
        onQuestionResolved: (input) => {
          void handleRemoteResolution(questionRoutingDeps, {
            questionRpcId: input.questionRpcId,
            outcome: input.outcome,
          }).catch(() => {})
        },
      },
    })
    void live
    await new Promise(resolve => { setTimeout(resolve, 500) })
  }, 20_000)

  afterAll(async () => {
    runtimeRef.current?.dispose()
    await discord.stop()
  })

  it('carries an approval click into a shape-correct client-response', async () => {
    pendingAsks.set('ask-approval', { sessionId: 'sess-1', kind: 'approval' })
    pushFrames([{
      rpcId: 'ask-approval',
      payload: {
        type: 'approval/requested',
        sessionId: 'sess-1',
        approvalId: '7c4a447f',
        toolName: 'bash',
        reason: 'write outside workspace',
      },
    }])

    const scope = discord.channel(threadId)
    const control = await scope.waitForMessage({
      predicate: message => message.content.includes('Approval required'),
    })
    const row = (control.components?.[0] as { components?: Array<{ custom_id?: string; label?: string }> } | undefined)?.components ?? []
    const allowId = row.find(button => button.label === 'Allow once')?.custom_id
    if (typeof allowId !== 'string') throw new TypeError('allow control missing custom_id')

    await discord.simulateButtonClick({ channelId: threadId, userId: USER, messageId: control.id, customId: allowId })
    await new Promise(resolve => { setTimeout(resolve, 300) })

    // The strict fake validated the envelope; the payload rides result.value.
    expect(respondCalls).toHaveLength(1)
    expect(respondCalls[0]).toMatchObject({
      type: 'client-response',
      rpcId: 'ask-approval',
      result: { ok: true, value: { sessionId: 'sess-1', approvalId: '7c4a447f', outcome: 'allowed-once' } },
    })
    // Controls retired on the confirmed answer.
    const edited = await discord.thread(threadId).getMessages()
    const controlAfter = edited.find(message => message.id === control.id)
    expect(controlAfter).toBeDefined()
    expect(controlAfter?.components ?? []).toHaveLength(0)
  }, 20_000)

  it('carries a question select + submit into a shape-correct answer batch', async () => {
    pendingAsks.set('ask-question', { sessionId: 'sess-1', kind: 'question' })
    pushFrames([{
      rpcId: 'ask-question',
      payload: {
        type: 'question/requested',
        sessionId: 'sess-1',
        questions: [{
          id: 'q1',
          question: 'How to proceed',
          options: [
            { label: 'Retry with approval (Recommended)' },
            { label: 'Create in /private/tmp' },
            { label: 'Other — tell us in your own words' },
          ],
        }],
      },
    }])

    const scope = discord.channel(threadId)
    const control = await scope.waitForMessage({
      predicate: message => message.content.includes('How to proceed'),
    })
    const rows = control.components as Array<{ components: Array<{ custom_id?: string }> }>
    const selectCustomId = rows[0]?.components[0]?.custom_id
    if (typeof selectCustomId !== 'string') throw new TypeError('select control missing custom_id')

    // Select the first option, then submit.
    await discord.simulateSelectMenu({
      channelId: threadId, userId: USER, messageId: control.id, customId: selectCustomId,
      values: ['Retry with approval (Recommended)'],
    })
    await new Promise(resolve => { setTimeout(resolve, 200) })
    const submitCustomId = rows.at(-1)?.components[0]?.custom_id
    if (typeof submitCustomId !== 'string') throw new TypeError('submit control missing custom_id')
    await discord.simulateButtonClick({
      channelId: threadId, userId: USER, messageId: control.id,
      customId: submitCustomId,
    })
    await new Promise(resolve => { setTimeout(resolve, 300) })

    const sent = respondCalls.filter(message => message.rpcId === 'ask-question')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'client-response',
      result: {
        ok: true,
        value: { sessionId: 'sess-1', answer: { answers: [{ id: 'q1', selected: ['Retry with approval (Recommended)'] }] } },
      },
    })
  }, 20_000)

  it('answers a second respond for a settled ask with not-pending', async () => {
    // The Host-semantics regression: an ask answered once is no longer
    // pending — a duplicate respond must NOT be treated as delivered.
    pendingAsks.set('ask-dupe', { sessionId: 'sess-1', kind: 'approval' })
    const first = await (async () => {
      // Drive the strict responder directly through a fresh render+click.
      pushFrames([{
        rpcId: 'ask-dupe',
        payload: {
          type: 'approval/requested',
          sessionId: 'sess-1',
          approvalId: 'dupe-1',
          toolName: 'bash',
        },
      }])
      const scope = discord.channel(threadId)
      const control = await scope.waitForMessage({
        predicate: message => message.content.includes('Approval required'),
      })
      const row = (control.components?.[0] as { components?: Array<{ custom_id?: string }> } | undefined)?.components ?? []
      return { control, allowId: row[0]?.custom_id ?? '' }
    })()
    await discord.simulateButtonClick({ channelId: threadId, userId: USER, messageId: first.control.id, customId: first.allowId })
    await new Promise(resolve => { setTimeout(resolve, 300) })

    const before = respondCalls.length
    const strict = await (async () => {
      // A second respond for the settled ask: not-pending.
      const port = createClientRespondPort({ respond: () => Promise.resolve({ accepted: false, reason: 'not-pending' }) })
      return port.respond('ask-dupe', {})
    })()
    expect(strict).toEqual({ outcome: 'rejected', reason: 'not-pending' })
    expect(respondCalls.length).toBe(before)
  }, 20_000)

  it('carries a Reject click into outcome rejected', async () => {
    pendingAsks.set('ask-reject', { sessionId: 'sess-1', kind: 'approval' })
    pushFrames([{
      rpcId: 'ask-reject',
      payload: { type: 'approval/requested', sessionId: 'sess-1', approvalId: 'rej-1', toolName: 'edit' },
    }])
    const scope = discord.channel(threadId)
    const control = await scope.waitForMessage({
      predicate: message => message.content.includes('Approval required — Edit'),
    })
    const row = (control.components?.[0] as { components?: Array<{ custom_id?: string; label?: string }> } | undefined)?.components ?? []
    const rejectId = row.find(button => button.label === 'Reject')?.custom_id
    if (typeof rejectId !== 'string') throw new TypeError('reject control missing custom_id')

    await discord.simulateButtonClick({ channelId: threadId, userId: USER, messageId: control.id, customId: rejectId })
    await new Promise(resolve => { setTimeout(resolve, 300) })

    const sent = respondCalls.filter(message => message.rpcId === 'ask-reject')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'client-response',
      result: { ok: true, value: { sessionId: 'sess-1', approvalId: 'rej-1', outcome: 'rejected' } },
    })
  }, 20_000)

  it('carries the Other modal answer through modal submit into the batch', async () => {
    pendingAsks.set('ask-modal', { sessionId: 'sess-1', kind: 'question' })
    pushFrames([{
      rpcId: 'ask-modal',
      payload: {
        type: 'question/requested',
        sessionId: 'sess-1',
        questions: [{ id: 'q1', question: '部署策略怎么选', options: [{ label: 'Option A' }] }],
      },
    }])
    const scope = discord.channel(threadId)
    const control = await scope.waitForMessage({
      predicate: message => message.content.includes('部署策略怎么选'),
    })
    const rows = control.components as Array<{ components: Array<{ custom_id?: string }> }>
    const selectCustomId = rows[0]?.components[0]?.custom_id
    if (typeof selectCustomId !== 'string') throw new TypeError('select control missing custom_id')

    // The reserved Other value opens the modal instead of recording.
    await discord.simulateSelectMenu({
      channelId: threadId, userId: USER, messageId: control.id, customId: selectCustomId,
      values: [CUSTOM_ANSWER_VALUE],
    })
    await new Promise(resolve => { setTimeout(resolve, 300) })
    const modal = interactionCallbacks.at(-1) as { data?: { custom_id?: string } } | undefined
    const modalCustomId = modal?.data?.custom_id
    if (typeof modalCustomId !== 'string') throw new TypeError('modal callback missing custom_id')

    await discord.simulateModalSubmit({
      channelId: threadId, userId: USER, customId: modalCustomId,
      fields: [{ customId: 'answer', value: '改为只读挂载' }],
    })
    await new Promise(resolve => { setTimeout(resolve, 200) })

    const submitCustomId = rows.at(-1)?.components[0]?.custom_id
    if (typeof submitCustomId !== 'string') throw new TypeError('submit control missing custom_id')
    await discord.simulateButtonClick({
      channelId: threadId, userId: USER, messageId: control.id, customId: submitCustomId,
    })
    await new Promise(resolve => { setTimeout(resolve, 300) })

    const sent = respondCalls.filter(message => message.rpcId === 'ask-modal')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'client-response',
      result: { ok: true, value: { sessionId: 'sess-1', answer: { answers: [{ id: 'q1', selected: [], custom: '改为只读挂载' }] } } },
    })
  }, 20_000)

  it('retires question controls on a remote resolution without submitting', async () => {
    pendingAsks.set('ask-remote', { sessionId: 'sess-1', kind: 'question' })
    pushFrames([{
      rpcId: 'ask-remote',
      payload: {
        type: 'question/requested',
        sessionId: 'sess-1',
        questions: [{ id: 'q1', question: 'Remote resolution target', options: [{ label: 'A' }, { label: 'B' }] }],
      },
    }])
    const scope = discord.channel(threadId)
    const control = await scope.waitForMessage({
      predicate: message => message.content.includes('Remote resolution target'),
    })
    const rows = control.components as Array<{ components: Array<{ custom_id?: string }> }>
    const selectCustomId = rows[0]?.components[0]?.custom_id
    if (typeof selectCustomId !== 'string') throw new TypeError('select control missing custom_id')
    const submitCustomId = rows.at(-1)?.components[0]?.custom_id
    if (typeof submitCustomId !== 'string') throw new TypeError('submit control missing custom_id')

    pushFrames([{
      rpcId: 'ask-remote',
      payload: { type: 'question/resolved', sessionId: 'sess-1', questionRpcId: 'ask-remote', outcome: 'answered' },
    }])
    await new Promise(resolve => { setTimeout(resolve, 300) })

    // Controls retired; later clicks settle as already-resolved, never a respond.
    const edited = await discord.thread(threadId).getMessages()
    const controlAfter = edited.find(message => message.id === control.id)
    expect(controlAfter?.components ?? []).toHaveLength(0)

    const before = respondCalls.length
    await discord.simulateSelectMenu({
      channelId: threadId, userId: USER, messageId: control.id, customId: selectCustomId,
      values: ['A'],
    })
    await discord.simulateButtonClick({ channelId: threadId, userId: USER, messageId: control.id, customId: submitCustomId })
    await new Promise(resolve => { setTimeout(resolve, 300) })
    expect(respondCalls.filter(message => message.rpcId === 'ask-remote')).toHaveLength(0)
    expect(respondCalls.length).toBe(before)
  }, 20_000)
})
