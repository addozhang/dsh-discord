import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

import {
  DEFAULT_DISCORD_SETTINGS,
  DiscordSettingsSchema,
  installDiscordSettings,
  normalizeDiscordSettings,
  type DiscordSettings,
  } from './settings.js'
import { installCancellationRoot } from './lifecycle.js'
import { validateHostCapabilities } from './startup.js'
import {
  createAdapterStatusTracker,
  installAdapterStatusRpc,
  type ConnectionRpc,
} from './features/adapter-status.js'
import { describeDiscordCredential, resolveDiscordBotToken, type DiscordCredentialProvider } from './credential.js'
import { createSharedRestClient, type SharedRestClient } from './discord/rest.js'
import { createRestThreadPort } from './discord/thread-port.js'
import { buildCommandRegistrations } from './discord/commands.js'
import { startDiscordAdapter, type BindingsProbe, type DiscordAdapterRuntime } from './compose.js'
import { createWorkspaceCatalogPort, createWorkspaceResolver, readWorkspaceDetail, promptSession, createSessionViaProxy, cancelSessionViaProxy, steerSession, removeQueueItemViaProxy, type DshApiProxyFace } from './dsh/api-proxy-face.js'
import { createApprovalStore } from './features/approval-store.js'
import { createQuestionStore } from './features/question-store.js'
import type { DshApprovalRespondPort } from './features/approval-routing.js'
import { createInteractionRouter } from './features/interaction-router.js'
import { channelBindingKey, parseChannelBindingKey, threadBindingKey, parseThreadBindingKey } from './state/domain.js'
import { createBindingStore } from './state/bindings.js'
import { createIntentStore, type InboundIntentRecord } from './state/intents.js'
import { createTurnTracker } from './features/turn-ownership.js'
import { createThreadCreationFlow, type DiscordThreadPort } from './features/thread-creation.js'
import { createSessionCreationFlow, type DshSessionPort } from './features/session-creation.js'
import { createPromptSubmissionFlow, type DshPromptPort } from './features/prompt-submission.js'
import { createSessionMainline } from './features/session-mainline.js'
import { startLiveRender } from './stream/live.js'
import type { ChannelBinding, ThreadBinding } from './state/records.js'
import type { PolicyTable } from './policy/authorization.js'
import { planWorkspaceChannel, workspaceChannelName, type ChannelBindingState } from './features/workspace-channel.js'
import type { GatewaySocket } from './gateway/gateway.js'

/** Stable Cordis plugin name for diagnostics. */
export const name = 'dsh-discord'

/** Host services required by the complete embedded adapter. */
export const inject = ['apiProxy', 'credentials', 'settings', 'storageDomain', 'connection']

export type Config = DiscordSettings

export const Config: z<Config> = DiscordSettingsSchema

/** Fixed Milestone 1 Gateway intents: guilds, members, messages, content. */
const GATEWAY_INTENTS = (1 << 0) | (1 << 1) | (1 << 9) | (1 << 15)

/**
 * Emit through the Host's logger service only when it is actually wired:
 * bare or fake Cordis contexts must not turn an error path into an
 * unhandled rejection.
 */
function emitLog(ctx: Context, level: 'debug' | 'warn', message: unknown): void {
  const logger = ctx.logger as Partial<Record<'debug' | 'warn', unknown>> | undefined
  const emit = logger?.[level]
  if (typeof emit === 'function') (emit as (message: unknown) => void).call(logger, message)
}

/**
 * Mount the embedded Discord adapter. Composition of the runtime path
 * (Gateway → ingress → command/mention dispatch → Discord REST, plus the
 * reconciliation sweeps) lives in `src/compose.ts` and is started from here.
 */
export function apply(ctx: Context, config: Config = DEFAULT_DISCORD_SETTINGS): void {
  validateHostCapabilities(name => ctx.get(name))
  installCancellationRoot(ctx)
  let current = normalizeDiscordSettings(config)
  const onGuildsChanged = (): void => { void registerCommands() }
  installDiscordSettings(ctx, current, (next) => {
    const guildsChanged = next.allowedGuildIds.join(',') !== current.allowedGuildIds.join(',')
    current = next
    if (guildsChanged) onGuildsChanged()
    emitLog(ctx, 'debug', {
      event: 'discord_settings_applied',
      enabled: current.enabled,
      allowedGuildCount: current.allowedGuildIds.length,
    })
  })

  // The settings card's status surface: credential presence seeded now, the
  // Gateway observation fed by the adapter composition as it starts.
  // Services resolve through the same accessor the startup boundary probes.
  const statusTracker = createAdapterStatusTracker()
  installAdapterStatusRpc(ctx.get('connection') as ConnectionRpc, statusTracker)
  void describeDiscordCredential(ctx.get('credentials') as DiscordCredentialProvider)
    .then((view) => { statusTracker.setCredential(view) })
    .catch((cause: unknown) => {
      emitLog(ctx, 'warn', { event: 'discord_credential_probe_failed', cause: String(cause) })
      statusTracker.setCredential({ configured: false })
    })

  const credentials = ctx.get('credentials') as DiscordCredentialProvider
  // The in-process apiProxy face: domain methods resolve RpcRequest →
  // RpcResponse and never throw business errors; boundedness and outcome
  // logging live in src/dsh/api-proxy-face.ts.
  const apiProxy = ctx.get('apiProxy') as unknown as DshApiProxyFace & {
    respond: (rpcId: string, payload: unknown) => Promise<unknown>
  }
  // Every apiProxy outcome is visible on stderr: the live profile pass reads
  // this channel, and a silent call can never again be misread as a hang.
  const rpcLog = (event: string, detail?: unknown): void => {
    console.error(`[dsh-discord] ${event}:`, typeof detail === 'string' ? detail : JSON.stringify(detail ?? null))
    emitLog(ctx, 'debug', { event, detail: typeof detail === 'string' ? detail : JSON.stringify(detail ?? null) })
  }
  const catalogPort = createWorkspaceCatalogPort(apiProxy, { log: rpcLog })
  const policy = (): PolicyTable => ({
    allowedGuildIds: [...current.allowedGuildIds],
    memberUserIds: [...current.memberUserIds],
    memberRoleIds: [...current.memberRoleIds],
    administratorUserIds: [...current.administratorUserIds],
    administratorRoleIds: [...current.administratorRoleIds],
    deniedUserIds: [...current.deniedUserIds],
    deniedRoleIds: [...current.deniedRoleIds],
    hostOperatorUserIds: [...current.hostOperatorUserIds],
  })

  // Channel→Workspace and Thread→Session bindings, plus the inbound-intent
  // records and the adapter-owned turn tracker. M1 keeps these process-local
  // Maps; the storage-domain KvTable backing lands with the persistence
  // milestone (Phase 2). The Discord application id equals the bot user id,
  // resolved at start.
  const applicationIdRef: { current: string } = { current: 'dsh-discord' }
  const rows = new Map<string, ChannelBinding>()
  const bindingStore = createBindingStore<ChannelBinding>({
    get: key => rows.get(key),
    put: (key, record) => { rows.set(key, record); return Promise.resolve() },
    delete: key => Promise.resolve(rows.delete(key)),
  })
  const threadRows = new Map<string, ThreadBinding>()
  const threadBindingStore = createBindingStore<ThreadBinding>({
    get: key => threadRows.get(key),
    put: (key, record) => { threadRows.set(key, record); return Promise.resolve() },
    delete: key => Promise.resolve(threadRows.delete(key)),
  })
  const intentRows = new Map<string, InboundIntentRecord>()
  const intents = createIntentStore({
    get: key => intentRows.get(key),
    put: (key, record) => { intentRows.set(key, record); return Promise.resolve() },
  })
  const turnTracker = createTurnTracker()
  const bindings: BindingsProbe = {
    workspaceForChannel: (guildId, channelId) =>
      bindingStore.get(channelBindingKey({
        applicationId: applicationIdRef.current, guildId, channelId,
      }))?.workspaceId,
    sessionForThread: (guildId, threadId) =>
      threadBindingStore.get(threadBindingKey({
        applicationId: applicationIdRef.current, guildId, threadId,
      }))?.sessionId,
  }

  // ── Session mainline: mention → thread → session → prompt → turn ──────
  const restThreadPort: DiscordThreadPort = (() => {
    const port = createRestThreadPort({
      request: async (method, path, body) => {
        const rest = await sharedRest()
        if (rest === undefined) return { outcome: 'unknown', reason: 'network-unreachable' }
        return rest.request(method, path, body)
      },
    }, { autoArchiveMinutes: () => current.threadAutoArchiveMinutes })
    return {
      ...port,
      // The join only affects sidebar visibility, but a silent refusal is
      // still indistinguishable from a working one — log it (runbook rule).
      joinThread: async (request) => {
        const joined = await port.joinThread(request)
        if (joined.outcome !== 'completed') {
          rpcLog('discord_thread_join_failed', request)
        }
        return joined
      },
    }
  })()
  const dshSessionPort: DshSessionPort = {
    createSession: request => createSessionViaProxy(apiProxy, request, { log: rpcLog }),
  }
  const dshPromptPort: DshPromptPort = {
    submit: request => promptSession(
      apiProxy,
      { sessionId: request.sessionId, prompt: request.prompt },
      { log: rpcLog, rpcId: request.requestId },
    ),
  }
  const composedMainline = createSessionMainline({
    threads: createThreadCreationFlow({
      intents,
      discord: restThreadPort,
      nowMs: () => Date.now(),
    }),
    sessions: createSessionCreationFlow({
      sessions: dshSessionPort,
      threadBindings: threadBindingStore,
      newSessionId: () => crypto.randomUUID(),
    }),
    prompts: createPromptSubmissionFlow({
      prompts: dshPromptPort,
      intents,
      nowMs: () => Date.now(),
    }),
    turns: turnTracker,
  })
  /** Visible failure feedback for mainline outcomes (posted to the source channel). */
  const mainlineFailureCopy: Record<string, string> = {
    'thread-conflict': '⚠️ 这条消息已被用于另一个会话任务，无法重复创建线程。',
    'thread-failed': '⚠️ 线程创建失败，请稍后重试。',
    'session-rejected': '⚠️ DSH 拒绝了会话创建（工作区可能已失效）；请稍后重试或重新 /project bind。',
    'session-unknown': '⚠️ 会话创建结果未知；请到 DSH Web 确认后再重试，不会自动重复创建。',
    'prompt-rejected': '⚠️ DSH 拒绝了任务提交。',
    'prompt-unknown': '⚠️ 任务提交结果未知；为避免重复执行不会自动重发，请确认后重试。',
  }
  const mainline = {
    admitMention: async (request: Parameters<typeof composedMainline.admitMention>[0]) => {
      const result = await composedMainline.admitMention(request)
      if (result.outcome === 'admitted') {
        rpcLog('discord_mention_admitted', { messageId: request.messageId, threadId: result.threadId, sessionId: result.sessionId })
      } else {
        rpcLog('discord_mention_not_admitted', { messageId: request.messageId, outcome: result.outcome })
        const copy = mainlineFailureCopy[result.outcome]
        if (copy !== undefined) {
          void withRest(rest => rest.request('POST', `/channels/${request.channelId}/messages`, { content: copy }))
            .catch((cause: unknown) => { rpcLog('discord_mainline_notice_failed', String(cause)) })
        }
      }
      return result
    },
    continueInThread: async (request: Parameters<typeof composedMainline.continueInThread>[0]) => {
      const result = await composedMainline.continueInThread(request)
      if (result.outcome === 'rejected' || result.outcome === 'unknown') {
        rpcLog('discord_continuation_not_queued', { messageId: request.messageId, outcome: result.outcome })
        const copy = result.outcome === 'rejected'
          ? '⚠️ 消息提交被 DSH 拒绝。'
          : '⚠️ 消息提交结果未知；不会自动重发，请确认后重试。'
        void withRest(rest => rest.request('POST', `/channels/${request.threadId}/messages`, { content: copy }))
          .catch((cause: unknown) => { rpcLog('discord_mainline_notice_failed', String(cause)) })
      }
      return result
    },
  }

  // Bind provision resolves the selection against the live catalog; the
  // Discord confirm button carries only opaque registry ids between the
  // command and the write.
  const resolver = createWorkspaceResolver(apiProxy, { log: rpcLog })

  // Adapter-owned guild surfaces: the "DeepSeek Harness" category, the
  // general control channel (both provisioned on READY), and — on bind —
  // one channel per Workspace, named after its display title. Nothing
  // outside the category is ever touched.
  const CATEGORY_NAME = 'DeepSeek Harness'
  type GuildChannel = { id: string; name: string; type: number; parent_id?: string }
  const ensureCategory = async (
    rest: SharedRestClient,
    guildId: string,
  ): Promise<{ channels: GuildChannel[]; categoryId: string } | undefined> => {
    const listed = await rest.request<GuildChannel[]>('GET', `/guilds/${guildId}/channels`)
    if (listed.outcome !== 'completed') return undefined
    const channels = listed.body
    let category = channels.find((c) => c.type === 4 && c.name.toLowerCase() === CATEGORY_NAME.toLowerCase())
    if (category === undefined) {
      const made = await rest.request<GuildChannel>('POST', `/guilds/${guildId}/channels`, { name: CATEGORY_NAME, type: 4 })
      if (made.outcome !== 'completed') return undefined
      category = made.body
    }
    return { channels, categoryId: category.id }
  }
  /**
   * ONE process-wide REST client, rebuilt only when the resolved token
   * changes. Per-route serialization lives inside the client, so concurrent
   * sends/edits/typing into one channel queue behind each other instead of
   * racing the bucket; every composition path goes through here.
   */
  let sharedRestCache: { token: string; client: SharedRestClient } | undefined
  const sharedRest = async (): Promise<SharedRestClient | undefined> => {
    const token = (await resolveDiscordBotToken(credentials)) ?? ''
    if (token === '') return undefined
    if (sharedRestCache?.token !== token) {
      const apiBase = process.env['DSH_DISCORD_REST_BASE']
      sharedRestCache = {
        token,
        client: createSharedRestClient({ token, ...(apiBase === undefined ? {} : { apiBase }) }),
      }
    }
    return sharedRestCache.client
  }
  const withRest = async <T>(
    run: (rest: SharedRestClient) => Promise<T>,
  ): Promise<T | undefined> => {
    const rest = await sharedRest()
    if (rest === undefined) return undefined
    return run(rest)
  }
  const bindChannelKey = (guildId: string, channelId: string): string =>
    channelBindingKey({ applicationId: applicationIdRef.current, guildId, channelId })
  /** The guild channel already serving this Workspace, if any (Kimaki's one-project-one-channel lookup). */
  const findBoundChannelFor = (guildId: string, workspaceId: string): string | undefined => {
    for (const [key, binding] of rows) {
      if (binding.workspaceId !== workspaceId) continue
      const scope = parseChannelBindingKey(key)
      if (scope?.guildId === guildId) return scope.channelId
    }
    return undefined
  }
  /**
   * Ensure the Workspace's home channel exists under the adapter category
   * and serves this Workspace (Kimaki one-project-one-channel: the
   * Workspace's existing bound channel wins outright). A same-name channel
   * is reused only when unbound; a channel serving another Workspace is
   * never stolen — a `-2` sibling is created instead.
   */
  const ensureWorkspaceChannel = async (options: {
    guildId: string
    workspaceId: string
    title: string
    actorId: string
  }): Promise<{ channelId: string; created: boolean } | undefined> => {
    return withRest(async (rest) => {
      const ensured = await ensureCategory(rest, options.guildId)
      if (ensured === undefined) return undefined
      // The control channel (general, the Kimaki #kimaki-opencode analog) is
      // the command surface — it must never become a Workspace home.
      const controlChannelId = ensured.channels.find((c) => c.type === 0 && c.name.toLowerCase() === 'general' && c.parent_id === ensured.categoryId)?.id
      const bindingOf = (channelId: string): ChannelBindingState => {
        if (channelId === controlChannelId) return 'other-workspace'
        const bound = bindingStore.get(bindChannelKey(options.guildId, channelId))
        if (bound === undefined) return 'unbound'
        return bound.workspaceId === options.workspaceId ? 'this-workspace' : 'other-workspace'
      }
      const existing = findBoundChannelFor(options.guildId, options.workspaceId)
      const record = { workspaceId: options.workspaceId, boundBy: options.actorId, boundAtMs: Date.now() }
      const placement = planWorkspaceChannel({
        channels: ensured.channels.map((c) => ({ id: c.id, name: c.name, parentId: c.parent_id })),
        categoryId: ensured.categoryId,
        desiredName: workspaceChannelName(options.title),
        bindingOf,
        existingForWorkspace: existing,
      })
      if (placement.outcome === 'reuse') {
        if (placement.needsBind) {
          await bindingStore.bind(bindChannelKey(options.guildId, placement.channelId), record)
        }
        return { channelId: placement.channelId, created: false }
      }
      const made = await rest.request<GuildChannel>('POST', `/guilds/${options.guildId}/channels`, {
        name: placement.name,
        type: 0,
        parent_id: ensured.categoryId,
      })
      if (made.outcome !== 'completed') {
        rpcLog('discord_workspace_channel_create_failed', made.outcome === 'rejected' ? `HTTP ${String(made.status)}` : made.reason)
        return undefined
      }
      await bindingStore.bind(bindChannelKey(options.guildId, made.body.id), record)
      return { channelId: made.body.id, created: true }
    })
  }

  const runtimeRef: { current: DiscordAdapterRuntime | undefined } = { current: undefined }
  // DSH approval respond face: the client-response echoes the ask's rpcId.
  const approvalRespondPort: DshApprovalRespondPort = {
    respond: async ({ rpcId, sessionId, approvalId, outcome }) => {
      const answer = await (apiProxy.respond as (
        rpcId: string, payload: { sessionId: string; approvalId: string; outcome: string },
      ) => Promise<unknown>)(rpcId, { sessionId, approvalId, outcome })
      return answer === undefined ? { outcome: 'unknown' } : { outcome: 'confirmed' }
    },
  }
  const approvals = createApprovalStore({ get: () => undefined, put: async () => {} })
  const queueSnapshots: Map<string, Array<{ id: string; summary: string }>> = new Map()
  const interactionRouter = createInteractionRouter({
    policy,
    applicationId: () => applicationIdRef.current,
    registry: () => runtimeRef.current?.registry,
    approvals,
    approvalRespondPort,
    turnTracker,
    queueSnapshots,
    dsh: {
      cancel: sessionId => cancelSessionViaProxy(apiProxy, { sessionId }, { log: rpcLog }),
      steer: (sessionId, prompt) => steerSession(apiProxy, { sessionId, prompt }, { log: rpcLog }),
      removeQueueItem: (sessionId, itemId) => removeQueueItemViaProxy(apiProxy, { sessionId, itemId }, { log: rpcLog }),
      readWorkspaceDetail: reference => readWorkspaceDetail(apiProxy, reference, { log: rpcLog }),
    },
    catalogPort,
    resolver,
    channelBinding: (guildId, channelId) => bindingStore.get(bindChannelKey(guildId, channelId)),
    findBoundChannelFor,
    sessionForThread: (guildId, threadId) => bindings.sessionForThread(guildId, threadId),
    ensureWorkspaceChannel,
    rest: sharedRest,
    log: rpcLog,
    warn: (event, detail) => {
      emitLog(ctx, 'warn', { event, detail: typeof detail === 'string' ? detail : JSON.stringify(detail ?? null) })
    },
  })
  runtimeRef.current = startDiscordAdapter({
    tokenProvider: async () => (await resolveDiscordBotToken(credentials)) ?? undefined,
    socketFactory: (url): GatewaySocket => {
      const ws = new WebSocket(url)
      // Translate the browser-style WebSocket event API (undici) into the
      // adapter's plain-callback contract. onclose MUST pass the numeric
      // close code: terminal codes drive the fail-closed status surface.
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
      ws.onopen = () => { socket.onopen?.() }
      ws.onmessage = (ev) => { socket.onmessage?.(typeof ev.data === 'string' ? ev.data : String(ev.data)) }
      ws.onclose = (ev) => { socket.onclose?.(ev.code) }
      ws.onerror = () => { socket.onerror?.(new Error('socket error')) }
      return socket
    },
    policy,
    selfUserIdProvider: async () => {
      const rest = await sharedRest()
      if (rest === undefined) throw new TypeError('discord bot token unavailable')
      const me = await rest.request<{ id: string }>('GET', '/users/@me')
      if (me.outcome !== 'completed') throw new TypeError('cannot resolve bot identity')
      return me.body.id
    },
    intents: GATEWAY_INTENTS,
    // Twin-E2E seams: both overrides default to the production surfaces and
    // exist only so a local Discord API twin can host the real protocol.
    ...(process.env['DSH_DISCORD_GATEWAY_URL'] === undefined
      ? {}
      : { gatewayUrl: process.env['DSH_DISCORD_GATEWAY_URL'] }),
    allowedGuildIds: [...current.allowedGuildIds],
    applicationId: () => applicationIdRef.current,
    mainline,
    bindings,
    unboundNotice: (request) => {
      const content = request.audience === 'administrator'
        ? '💡 此频道未绑定工作区。工作区管理员可运行 `/project bind` 创建并绑定项目频道。'
        : '💡 此频道未绑定工作区；请工作区管理员运行 `/project bind`。'
      void withRest(async (rest) => {
        const sent = await rest.request('POST', `/channels/${request.channelId}/messages`, { content })
        if (sent.outcome !== 'completed') {
          rpcLog('discord_unbound_notice_send_failed', sent.outcome === 'rejected' ? `HTTP ${String(sent.status)}` : sent.reason)
        }
      }).catch((cause: unknown) => {
        rpcLog('discord_unbound_notice_threw', String(cause))
      })
    },
    ensureGuildChannels: async (guildId) => {
      await withRest(async (rest) => {
        const ensured = await ensureCategory(rest, guildId)
        if (ensured === undefined) return
        // Never touch channels outside our category: create our own only.
        const hasControl = ensured.channels.some((c) => c.type === 0 && c.name.toLowerCase() === 'general' && c.parent_id === ensured.categoryId)
        if (hasControl) return
        await rest.request('POST', `/guilds/${guildId}/channels`, { name: 'general', type: 0, parent_id: ensured.categoryId })
      })
    },
    approvals,
    questions: createQuestionStore(),
    status: statusTracker,
    routeInteraction: (event, token) => {
      // The router speaks the interaction dialect only (compose forwards
      // interactions exclusively).
      if (event.kind !== 'interaction') return
      return interactionRouter.route(event, token)
    },
    logger: {
      warn: (event, detail) => {
        emitLog(ctx, 'warn', { event, detail: typeof detail === 'string' ? detail : JSON.stringify(detail ?? null) })
      },
    },
  })
  // Register the Milestone 1 command set per allowed Guild (instant
  // propagation, unlike global commands) once the bot identity is known.
  // Re-runs whenever the allowlist changes — apply-time settings may still
  // be loading, so the first non-empty list wins.
  let registering = false
  const registerCommands = async (): Promise<void> => {
    if (registering || current.allowedGuildIds.length === 0) return
    registering = true
    try {
      const rest = await sharedRest()
      if (rest === undefined) return
      const me = await rest.request<{ id: string }>('GET', '/users/@me')
      if (me.outcome !== 'completed') return
      applicationIdRef.current = me.body.id
      const registrations = buildCommandRegistrations()
      for (const guildId of current.allowedGuildIds) {
        const result = await rest.request('PUT', `/applications/${me.body.id}/guilds/${guildId}/commands`, registrations)
        if (result.outcome !== 'completed') {
          emitLog(ctx, 'warn', { event: 'discord_command_register_failed', guildId })
        }
      }
    } finally {
      registering = false
    }
  }
  void registerCommands().catch((cause: unknown) => {
    emitLog(ctx, 'warn', { event: 'discord_command_register_failed', cause: String(cause) })
  })

  // ── Live streaming: DSH events.mux → per-thread Discord rendering ─────
  // The queue snapshot cache (declared with the interaction router) is the
  // /queue surface's data source: DSH 0.1.1 has no queue-list RPC, only the
  // authoritative whole-snapshot mux frame.
  const threadForSession = (sessionId: string): string | undefined => {
    for (const [key, record] of threadRows) {
      if (record.sessionId !== sessionId) continue
      const scope = parseThreadBindingKey(key)
      if (scope !== undefined) return scope.threadId
    }
    return undefined
  }
  interface EventsFace {
    mux(request: { rpcId: string; payload: Record<string, never> }, signal: AbortSignal): AsyncIterable<unknown>
  }
  const liveRef: { current: ReturnType<typeof startLiveRender> | undefined } = { current: undefined }
  liveRef.current = startLiveRender({
    frames: (signal) => {
      const events = (apiProxy as unknown as { events?: EventsFace }).events
      if (events === undefined) throw new TypeError('apiProxy.events is unavailable on this Host')
      return events.mux({ rpcId: crypto.randomUUID(), payload: {} }, signal)
    },
    threadForSession,
    delivery: {
      send: async (request) => {
        const rest = await sharedRest()
        if (rest === undefined) return { outcome: 'failed' }
        const sent = await rest.request<{ id?: string } | undefined>('POST', `/channels/${request.channelId}/messages`, { content: request.content })
        if (sent.outcome === 'completed' && typeof sent.body?.id === 'string') {
          return { outcome: 'completed', messageId: sent.body.id }
        }
        rpcLog('discord_live_send_failed', { channelId: request.channelId, outcome: sent.outcome })
        return { outcome: 'failed' }
      },
      edit: async (request) => {
        const rest = await sharedRest()
        if (rest === undefined) return { outcome: 'failed' }
        const edited = await rest.request('PATCH', `/channels/${request.channelId}/messages/${request.messageId}`, { content: request.content })
        return edited.outcome === 'completed' ? { outcome: 'completed' } : { outcome: 'failed' }
      },
      typing: async (channelId) => {
        const rest = await sharedRest()
        if (rest === undefined) return
        await rest.request('POST', `/channels/${channelId}/typing`)
      },
      renameThread: async (request) => {
        const rest = await sharedRest()
        if (rest === undefined) return { outcome: 'failed' }
        const renamed = await rest.request('PATCH', `/channels/${request.channelId}`, { name: request.name })
        return renamed.outcome === 'completed' ? { outcome: 'completed' } : { outcome: 'failed' }
      },
    },
    updateIntervalMs: current.streamUpdateIntervalMs,
    typingIntervalMs: current.typingIntervalMs,
    verbosity: current.defaultVerbosity,
    log: rpcLog,
    onQueueSnapshot: (sessionId, items) => { queueSnapshots.set(sessionId, items) },
    onTurnEnded: (sessionId) => {
      const turn = turnTracker.active(sessionId)
      if (turn !== undefined) turnTracker.complete(turn.requestId)
    },
  })
  ctx.effect(() => () => { liveRef.current?.dispose() }, 'dsh-discord live render')
  ctx.effect(() => () => { runtimeRef.current?.dispose() }, 'dsh-discord composed runtime')
}

export {
  DEFAULT_DISCORD_SETTINGS,
  DISCORD_SETTINGS_NAMESPACE,
  DiscordSettingsSchema,
  normalizeDiscordSettings,
  validateDiscordSettings,
} from './settings.js'
export {
  DISCORD_BOT_TOKEN_REF,
  describeDiscordCredential,
  resolveDiscordBotToken,
} from './credential.js'
