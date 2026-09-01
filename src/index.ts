import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

import {
  DEFAULT_DISCORD_SETTINGS,
  DiscordSettingsSchema,
  installDiscordSettings,
  normalizeDiscordSettings,
  type DiscordSettings,
  } from './settings.js'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { installCancellationRoot } from './lifecycle.js'
import { ALLOWED_MENTIONS_NONE, DISCORD_SUPPRESS_NOTIFICATIONS_FLAG, OUTBOUND_EPHEMERAL_FLAGS, safeTitle } from './policy/disclosure.js'
import { validateHostCapabilities } from './startup.js'
import {
  createAdapterStatusTracker,
  installAdapterStatusRpc,
  type ConnectionRpc,
} from './features/adapter-status.js'
import { DISCORD_BOT_TOKEN_REF, describeDiscordCredential, resolveDiscordBotToken, type DiscordCredentialProvider } from './credential.js'
import { createSharedRestClient, newNonce, type SharedRestClient } from './discord/rest.js'
import { createRestThreadPort } from './discord/thread-port.js'
import { createComponentRegistry } from './discord/components.js'
import { buildCommandRegistrations } from './discord/commands.js'
import { startDiscordAdapter, type BindingsProbe, type DiscordAdapterRuntime } from './compose.js'
import { createModelPort, createWorkspaceCatalogPort, createWorkspaceResolver, readWorkspaceDetail, promptSession, createSessionViaProxy, cancelSessionViaProxy, steerSession, removeQueueItemViaProxy, type DshApiProxyFace } from './dsh/api-proxy-face.js'
import { createApprovalStore, type ApprovalRecord } from './features/approval-store.js'
import { createAskWiring } from './features/ask-wiring.js'
import { sweepExpiredApprovals } from './features/approval-expiry.js'
import { sweepExpiredQuestions, type DshTurnCancelPort } from './features/question-expiry.js'
import { createQuestionStore } from './features/question-store.js'
import { handleSelectInput, handleModalSubmit, type QuestionRoutingDeps } from './features/question-routing.js'
import { createCopy, type CopyTable } from './i18n.js'
import type { DshApprovalRespondPort } from './features/approval-routing.js'
import { createInteractionRouter } from './features/interaction-router.js'
import { channelBindingKey, parseChannelBindingKey, threadBindingKey, parseThreadBindingKey, discordDomainSpec, CHANNEL_BINDINGS_TABLE, THREAD_BINDINGS_TABLE, INTENTS_TABLE } from './state/domain.js'
import { planBindingReconciliation } from './features/reconcile-bindings.js'
import { guildKeysToForget, sweepExpired } from './state/retention.js'
import { listSessionIds, listSessionSummaries, createClientRespondPort } from './dsh/api-proxy-face.js'
import { createBindingStore } from './state/bindings.js'
import { createIntentStore, type InboundIntentRecord, type IntentTable } from './state/intents.js'
import type { BindingTable } from './state/bindings.js'
import { createTurnTracker } from './features/turn-ownership.js'
import { createThreadCreationFlow, type DiscordThreadPort } from './features/thread-creation.js'
import { createSessionCreationFlow, type DshSessionPort } from './features/session-creation.js'
import { createResumeCandidatesPort } from './features/session-resume.js'
import { createPromptSubmissionFlow, type DshPromptPort } from './features/prompt-submission.js'
import { createSessionMainline, requestIdFor, type MainlineImageCollector } from './features/session-mainline.js'
import { collectImages, createSafeImageDownloadPort } from './features/image-collection.js'
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

/**
 * Fixed Milestone 1 Gateway intents: guilds, messages, content. Member data
 * rides MESSAGE_CREATE/INTERACTION_CREATE payloads, so the privileged
 * GUILD_MEMBERS bit (1 << 1) is not requested — without the Dev Portal
 * toggle Discord rejects identify with 4014, which is terminal for us.
 */
const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15)

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
  /**
   * Discord-visible copy, re-resolved on every access so a language change
   * on the settings card applies without rebuilding the composition. The
   * 'auto' preference follows the DSH locale (the `locale` namespace the
   * Host app registers); non-Chinese locales fall back to English.
   */
  const resolveLanguage = (): 'zh' | 'en' => {
    if (current.language !== 'auto') return current.language
    const locale = (ctx.get('settings') as { get(namespace: unknown): unknown }).get(settingsNamespace('locale')) as { preference?: string } | undefined
    return typeof locale?.preference === 'string' && locale.preference.startsWith('zh') ? 'zh' : 'en'
  }
  const copy: CopyTable = new Proxy({} as CopyTable, {
    get: (_target, key) => createCopy(resolveLanguage())[key as keyof CopyTable],
  })
  // Reassigned once the async composition has built the real registrar.
  let registerCommands: () => Promise<void> = async () => {}
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
  // Late-bound so the management channel can reach the runtime built inside
  // the composition IIFE below (the card's Connect button).
  const runtimeRef: { current: DiscordAdapterRuntime | undefined } = { current: undefined }
  installAdapterStatusRpc(ctx.get('connection') as ConnectionRpc, statusTracker, {
    tracker: statusTracker,
    setToken: async (value: string) => {
      await (ctx.get('credentials') as DiscordCredentialProvider).set(DISCORD_BOT_TOKEN_REF, value)
      statusTracker.setCredential({ configured: true })
    },
    connect: () => { runtimeRef.current?.connect() },
    disconnect: () => { runtimeRef.current?.disconnect() },
  })
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
  const apiProxy = ctx.get('apiProxy') as unknown as DshApiProxyFace
  // Default-quiet logging (16.33): flow records ride the Host's debug level
  // only — the adapter prints nothing into the DSH process at the default
  // level. Failure-shaped events (…failed/…threw/…blocked/…unknown) escalate
  // to warn so a default-level Host still surfaces them.
  const rpcLog = (event: string, detail?: unknown): void => {
    const serialized = typeof detail === 'string' ? detail : JSON.stringify(detail ?? null)
    if (process.env['DSH_DISCORD_TRACE'] === '1') {
      console.error(`[dsh-discord:trace] ${event}:`, serialized)
    }
    emitLog(ctx, /(?:failed|threw|blocked|unknown)/.test(event) ? 'warn' : 'debug', { event, detail: serialized })
  }
  void (async () => {
    // The durable domain gates the whole composition: no adapter starts
    // without its bindings/intents tables, and close() drains queued writes
    // on teardown (fail-closed across restarts, design §10).
    const domain = await ctx.storageDomain.open(discordDomainSpec)
    ctx.effect(() => () => { void domain.close() }, 'discord durable domain')

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

    // Channel→Workspace and Thread→Session bindings, inbound-intent records,
    // and the adapter-owned turn tracker. The first three are DURABLE through
    // the storage-domain tables opened above (design §10); reads are
    // synchronous from the domain's in-memory projection, writes queue on
    // its durable chain. queueSnapshots stays process-local by design. The
    // Discord application id equals the bot user id, resolved at start.
    const applicationIdRef: { current: string } = { current: 'dsh-discord' }
    // Durable tables carry the store contracts PLUS snapshot iteration
    // (reconciliation sweeps and guild-forget scan by parsed key parts).
    type DurableBindingTable<V> = BindingTable<V> & {
      entries(): IterableIterator<[string, V]>
      keys(): IterableIterator<string>
    }
    type DurableIntentTable = IntentTable & {
      entries(): IterableIterator<[string, InboundIntentRecord]>
      delete(key: string): Promise<boolean>
    }
    const channelTable = domain.table(CHANNEL_BINDINGS_TABLE) as unknown as DurableBindingTable<ChannelBinding>
    const threadTable = domain.table(THREAD_BINDINGS_TABLE) as unknown as DurableBindingTable<ThreadBinding>
    const intentTable = domain.table(INTENTS_TABLE) as unknown as DurableIntentTable
    const bindingStore = createBindingStore<ChannelBinding>(channelTable)
    const threadBindingStore = createBindingStore<ThreadBinding>(threadTable)
    const intents = createIntentStore(intentTable)
    const turnTracker = createTurnTracker()
    // Approvals: process-local backing (minutes-lived; DSH replays pending
    // asks on mux reopen). turnActors maps submitted request ids to their
    // Discord authors — the ownership fact for approval/question clicks.
    const approvalRows = new Map<string, ApprovalRecord>()
    const approvalsStore = createApprovalStore({
      get: key => approvalRows.get(key),
      put: (key, record) => {
        approvalRows.set(key, record)
        return Promise.resolve()
      },
    })
    const questionsStore = createQuestionStore()
    const turnActors = new Map<string, string>()
    const sharedRegistry = createComponentRegistry()
    const questionCancelPort: DshTurnCancelPort = {
      cancel: async ({ sessionId }) => {
        const cancelled = await cancelSessionViaProxy(apiProxy, { sessionId }, { log: rpcLog })
        const turn = turnTracker.active(sessionId)
        if (turn !== undefined) turnTracker.complete(turn.requestId)
        return cancelled.outcome === 'accepted'
          ? { outcome: 'accepted' as const }
          : cancelled.outcome === 'rejected'
            ? { outcome: 'rejected' as const, reason: cancelled.reason }
            : { outcome: 'unknown' as const }
      },
    }
    const askWiring = createAskWiring({
      registry: sharedRegistry,
      approvals: approvalsStore,
      questions: questionsStore,
      cancelPort: questionCancelPort,
      nowMs: () => Date.now(),
      log: rpcLog,
      activeTurnRequestId: sessionId => turnTracker.active(sessionId)?.requestId,
      turnActor: requestId => turnActors.get(requestId),
      threadOwner: threadId => {
        for (const key of threadTable.keys()) {
          if (!key.endsWith(`:${threadId}`)) continue
          const createdBy = threadTable.get(key)?.createdBy
          if (typeof createdBy === 'string' && createdBy !== '') return createdBy
        }
        return undefined
      },
      postMessage: async (threadId, payload) => {
        const rest = await sharedRest()
        if (rest === undefined) return { stored: false, reason: 'rest unavailable' }
        const sent = await rest.request<{ id?: string } | undefined>('POST', `/channels/${threadId}/messages`, payload)
        if (sent.outcome !== 'completed') {
          return {
            stored: false,
            reason: sent.outcome === 'rejected'
              ? `HTTP ${String(sent.status)} ${sent.error.message}`
              : sent.reason,
          }
        }
        if (typeof sent.body?.id !== 'string') return { stored: false, reason: `HTTP ${String(sent.status)}: response missing message id` }
        return { stored: true, messageId: sent.body.id }
      },
      editMessage: async (channelId, messageId, payload) => {
        const rest = await sharedRest()
        if (rest === undefined) return { stored: false, reason: 'rest unavailable' }
        const patched = await rest.request('PATCH', `/channels/${channelId}/messages/${messageId}`, payload)
        if (patched.outcome !== 'completed') {
          return {
            stored: false,
            reason: patched.outcome === 'rejected'
              ? `HTTP ${String(patched.status)} ${patched.error.message}`
              : patched.reason,
          }
        }
        return { stored: true }
      },
    })
    const componentFollowUp = async (_interactionId: string, interactionToken: string, content: string): Promise<void> => {
      const rest = await sharedRest()
      if (rest === undefined) return
      const posted = await rest.request('POST', `/webhooks/${applicationIdRef.current}/${interactionToken}`, { content, flags: OUTBOUND_EPHEMERAL_FLAGS })
      if (posted.outcome !== 'completed') {
        rpcLog('discord_followup_failed', posted.outcome === 'rejected' ? `HTTP ${String(posted.status)}` : posted.reason)
      }
    }
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
        {
          sessionId: request.sessionId,
          prompt: request.prompt,
          ...(request.images === undefined ? {} : { images: request.images }),
        },
        { log: rpcLog, rpcId: request.requestId },
      ),
    }
    /**
     * The bounded image collection boundary (16.50): downloads ride the
     * safe-download port (allowlisted CDN hosts, capped sizes, timeout) and
     * come back base64-encoded for the prompt parts.
     */
    const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000
    const imageCollector: MainlineImageCollector = {
      collect: async ({ attachments }) => {
        const result = await collectImages(createSafeImageDownloadPort(), {
          nowMs: Date.now(),
          timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
          attachments,
        })
        if (result.outcome !== 'collected') {
          const reason = result.outcome === 'too-large' ? `too-large:${result.reason}` : result.outcome
          return { outcome: 'failed', reason }
        }
        return {
          outcome: 'collected',
          images: result.downloaded.map(image => ({
            mediaType: image.mediaType,
            base64: Buffer.from(image.body).toString('base64'),
          })),
        }
      },
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
      images: imageCollector,
    })
    /** Mainline outcome → copy key; the string resolves live per language. */
    const MAINLINE_FAILURE_KEYS = {
      'thread-conflict': 'mainlineThreadConflict',
      'thread-failed': 'mainlineThreadFailed',
      'session-rejected': 'mainlineSessionRejected',
      'session-unknown': 'mainlineSessionUnknown',
      'prompt-rejected': 'mainlinePromptRejected',
      'prompt-unknown': 'mainlinePromptUnknown',
      'image-failed': 'mainlineImageFailed',
    } as const satisfies Record<string, keyof CopyTable>
    const mainline = {
      admitMention: async (request: Parameters<typeof composedMainline.admitMention>[0]) => {
        const result = await composedMainline.admitMention(request)
        if (result.outcome === 'admitted') {
          // Ownership fact: this request id's turn belongs to this author —
          // approval/question clicks authorize against it.
          turnActors.set(requestIdFor(request.messageId), request.authorId)
          rpcLog('discord_mention_admitted', { messageId: request.messageId, threadId: result.threadId, sessionId: result.sessionId })
        } else {
          rpcLog('discord_mention_not_admitted', { messageId: request.messageId, outcome: result.outcome })
          const notice = copy[MAINLINE_FAILURE_KEYS[result.outcome]]
          void withRest(rest => rest.request('POST', `/channels/${request.channelId}/messages`, { content: notice, flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG, allowed_mentions: ALLOWED_MENTIONS_NONE }))
            .catch((cause: unknown) => { rpcLog('discord_mainline_notice_failed', String(cause)) })
        }
        return result
      },
      continueInThread: async (request: Parameters<typeof composedMainline.continueInThread>[0]) => {
        const result = await composedMainline.continueInThread(request)
        if (result.outcome === 'rejected' || result.outcome === 'unknown' || result.outcome === 'image-failed') {
          rpcLog('discord_continuation_not_queued', { messageId: request.messageId, outcome: result.outcome })
          const notice = result.outcome === 'rejected'
            ? copy.continuationRejected
            : result.outcome === 'image-failed'
              ? copy.mainlineImageFailed
              : copy.continuationUnknown
          void withRest(rest => rest.request('POST', `/channels/${request.threadId}/messages`, { content: notice, flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG, allowed_mentions: ALLOWED_MENTIONS_NONE }))
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
    /**
     * Reconcile an unobservable message send (rest.ts contract): the send
     * carried a nonce, so a message that actually landed is findable among
     * the channel's recent messages — authored by this bot. `undefined`
     * means the outcome stays unobservable (no evidence either way).
     */
    const findSentMessageByNonce = async (
      rest: SharedRestClient,
      channelId: string,
      nonce: string,
    ): Promise<string | undefined> => {
      // The list body is untrusted wire data: narrow every row by shape.
      const listed = await rest.request<unknown>('GET', `/channels/${channelId}/messages?limit=50`)
      if (listed.outcome !== 'completed' || !Array.isArray(listed.body)) return undefined
      for (const row of listed.body) {
        if (typeof row !== 'object' || row === null) continue
        const record = row as Record<string, unknown>
        if (record['nonce'] !== nonce) continue
        const author = record['author']
        if (typeof author !== 'object' || author === null) continue
        if ((author as Record<string, unknown>)['id'] !== applicationIdRef.current) continue
        if (typeof record['id'] === 'string') return record['id']
      }
      return undefined
    }
    const bindChannelKey = (guildId: string, channelId: string): string =>
      channelBindingKey({ applicationId: applicationIdRef.current, guildId, channelId })
    /** The guild channel already serving this Workspace, if any (one-project-one-channel lookup). */
    const findBoundChannelFor = (guildId: string, workspaceId: string): string | undefined => {
      for (const [key, binding] of channelTable.entries()) {
        if (binding.workspaceId !== workspaceId) continue
        const scope = parseChannelBindingKey(key)
        if (scope?.guildId === guildId) return scope.channelId
      }
      return undefined
    }
    /**
     * Ensure the Workspace's home channel exists under the adapter category
     * and serves this Workspace (one-project-one-channel: the
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
        // The control channel (general, the control-channel analog) is
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

    // ── Reconciliation (reconciliation spec): on READY, verify every
    // persisted mapping against the DSH baseline and Discord's live
    // surface. Retirement ever deletes only adapter records; unverifiable
    // mappings stay blocked (logged) rather than guessed away.
    let reconciling = false
    const reconcileOnReady = async (): Promise<void> => {
      if (reconciling) return
      reconciling = true
      try {
        const rest = await sharedRest()
        if (rest === undefined) return
        const catalog = await catalogPort.listWorkspaces()
        if (catalog.outcome !== 'completed') {
          rpcLog('discord_reconcile_blocked', 'workspace-catalog-unavailable')
          return
        }
        const sessionIds = await listSessionIds(apiProxy, { log: rpcLog })
        if (sessionIds.outcome !== 'completed') {
          rpcLog('discord_reconcile_blocked', 'session-list-unavailable')
          return
        }
        for (const guildId of current.allowedGuildIds) {
          const facts: Record<string, 'ok' | 'missing' | 'unknown'> = {}
          const channelRows: GuildChannel[] = []
          const channels = await rest.request<GuildChannel[]>('GET', `/guilds/${guildId}/channels`)
          const listed = channels.outcome === 'completed'
          if (listed) {
            channelRows.push(...channels.body)
            for (const channel of channels.body) facts[channel.id] = 'ok'
            const threads = await rest.request<{ threads?: Array<{ id: string }> } | undefined>('GET', `/guilds/${guildId}/threads/active`)
            if (threads.outcome === 'completed' && Array.isArray(threads.body?.threads)) {
              for (const thread of threads.body.threads) facts[thread.id] = 'ok'
            }
          }
          // This guild's bindings only: another guild's pass must never
          // judge (or retire) this guild's mappings against its own facts.
          const channelKeyById = new Map<string, string>()
          const threadKeyById = new Map<string, string>()
          for (const key of channelTable.keys()) {
            const scope = parseChannelBindingKey(key)
            if (scope?.guildId !== guildId || scope.channelId === '') continue
            channelKeyById.set(scope.channelId, key)
          }
          for (const key of threadTable.keys()) {
            const scope = parseThreadBindingKey(key)
            if (scope?.guildId !== guildId || scope.threadId === '') continue
            threadKeyById.set(scope.threadId, key)
          }
          // Verified absence: the listing succeeded and the channel is gone.
          if (listed) {
            for (const channelId of channelKeyById.keys()) {
              if (facts[channelId] === undefined) facts[channelId] = 'missing'
            }
          }

          // Default surface (16.34/16.37): the adapter's category and the
          // general control channel are ensured on every READY. Bound home
          // channels are NOT recreated — a Discord-side deletion is user
          // intent, so the verified absence marked above retires the
          // mapping in the plan below instead.
          const category = channelRows.find(channel => channel.type === 4 && channel.name.toLowerCase() === CATEGORY_NAME.toLowerCase())
            ?? await (async () => {
              const made = await rest.request<GuildChannel>('POST', `/guilds/${guildId}/channels`, { name: CATEGORY_NAME, type: 4 })
              if (made.outcome !== 'completed') {
                // Usually HTTP 403: the bot's roles lack Manage Channels.
                rpcLog('discord_category_ensure_failed', { guildId, cause: made.outcome === 'rejected' ? `HTTP ${String(made.status)}` : made.reason })
                return undefined
              }
              return made.body
            })()
          if (category !== undefined && channelRows.find(channel => channel.type === 0 && channel.name.toLowerCase() === 'general' && channel.parent_id === category.id) === undefined) {
            const made = await rest.request('POST', `/guilds/${guildId}/channels`, { name: 'general', type: 0, parent_id: category.id })
            if (made.outcome === 'completed') rpcLog('discord_control_channel_created', { guildId })
            else rpcLog('discord_control_channel_create_failed', { guildId, cause: made.outcome === 'rejected' ? `HTTP ${String(made.status)}` : made.reason })
          }

          const plan = planBindingReconciliation({
            channelBindings: [...channelTable.entries()].map(([key, record]) => {
              const scope = parseChannelBindingKey(key)
              return { channelId: scope?.channelId ?? '', ...record }
            }).filter(binding => binding.channelId !== '' && channelKeyById.has(binding.channelId)),
            threadBindings: [...threadTable.entries()].map(([key, record]) => {
              const scope = parseThreadBindingKey(key)
              return { threadId: scope?.threadId ?? '', ...record }
            }).filter(binding => binding.threadId !== '' && threadKeyById.has(binding.threadId)),
            baseline: {
              workspaces: catalog.workspaces.map(workspace => ({ workspaceId: workspace.id, title: workspace.title, path: '' })),
              sessionIds: sessionIds.ids,
            },
            discord: { channels: facts },
          })
          for (const action of plan.channelActions) {
            if (action.action !== 'retire') continue
            const key = channelKeyById.get(action.channelId)
            if (key === undefined) continue
            await channelTable.delete(key)
            rpcLog('discord_reconcile_channel_retired', { channelId: action.channelId, reason: action.reason })
          }
          for (const action of plan.threadActions) {
            if (action.action !== 'retire') continue
            const key = threadKeyById.get(action.threadId)
            if (key === undefined) continue
            await threadTable.delete(key)
            rpcLog('discord_reconcile_thread_retired', { threadId: action.threadId, reason: action.reason })
          }
        }
        rpcLog('discord_reconcile_done', {})
      } finally {
        reconciling = false
      }
    }

    // ── Retention sweep: completed intents age out on the durable table;
    // interaction records are still process-local stubs and thus omitted.
    const retentionTimer = setInterval(() => {
      const plan = sweepExpired(
        { intents: [...intentTable.entries()].map(([key, record]) => [key, record]), resolvedInteractions: [] },
        { nowMs: Date.now() },
      )
      for (const key of plan.intentKeys) {
        void intentTable.delete(key).then(() => {
          rpcLog('discord_retention_intent_expired', { key })
        })
      }
    }, 6 * 60 * 60_000)
    ctx.effect(() => () => { clearInterval(retentionTimer) }, 'discord retention sweep')
    // Approval/question expiry: 30s sweep — approvals auto-reject before
    // their controls expire; question expiry cancels the owning turn.
    const expiryTimer = setInterval(() => {
      void sweepExpiredApprovals({
        store: approvalsStore,
        port: approvalRespondPort,
        controls: { disable: key => askWiring.disableControl(key) },
        nowMs: () => Date.now(),
      }).catch((cause: unknown) => { rpcLog('discord_approval_expiry_threw', String(cause)) })
      void sweepExpiredQuestions({
        store: questionsStore,
        cancelPort: questionCancelPort,
        controls: { disable: key => askWiring.disableControl(key) },
        nowMs: () => Date.now(),
      }).catch((cause: unknown) => { rpcLog('discord_question_expiry_threw', String(cause)) })
    }, 30_000)
    ctx.effect(() => () => { clearInterval(expiryTimer) }, 'discord interaction expiry sweep')


    // DSH approval respond face: the client-response echoes the ask's rpcId.
    const clientRespond = createClientRespondPort(
      apiProxy as unknown as { respond(message: unknown): Promise<unknown> },
      { log: rpcLog },
    )
    const approvalRespondPort: DshApprovalRespondPort = {
      respond: async ({ rpcId, sessionId, approvalId, outcome }) => {
        const receipt = await clientRespond.respond(rpcId, { sessionId, approvalId, outcome })
        rpcLog('discord_approval_respond_receipt', { rpcId, approvalId, outcome, receipt })
        return receipt
      },
    }
    const queueSnapshots: Map<string, Array<{ id: string; summary: string }>> = new Map()
    /** Delete every adapter-owned record for one guild (DSH untouched). */
    const forgetGuild = async (guildId: string): Promise<void> => {
      const plan = guildKeysToForget({
        guildId,
        channelBindingKeys: [...channelTable.keys()],
        threadBindingKeys: [...threadTable.keys()],
      })
      for (const key of plan.channelKeys) await channelTable.delete(key)
      for (const key of plan.threadKeys) await threadTable.delete(key)
      rpcLog('discord_guild_forget_deleted', { guildId, channels: plan.channelKeys.length, threads: plan.threadKeys.length })
    }

    const questionRespondPort = {
      respond: async (input: { rpcId: string; sessionId: string; answer: { answers: Array<{ id: string; selected: string[]; custom?: string }> } }) => {
        const receipt = await clientRespond.respond(input.rpcId, { sessionId: input.sessionId, answer: input.answer })
        rpcLog('discord_question_respond_receipt', { rpcId: input.rpcId, receipt })
        return receipt
      },
    }
    const questionRoutingDeps: QuestionRoutingDeps = {
      registry: sharedRegistry,
      store: questionsStore,
      port: questionRespondPort,
      nowMs: () => Date.now(),
      controls: { disable: key => askWiring.disableControl(key) },
    }
    const interactionRouter = createInteractionRouter({
      policy,
      applicationId: () => applicationIdRef.current,
      registry: sharedRegistry,
      copy,
      approvals: approvalsStore,
      approvalRespondPort,
      turnTracker,
      queueSnapshots,
      forgetGuild,
      componentFollowUp,
      disableControl: key => askWiring.disableControl(key),
      handleQuestionComponent: input => handleSelectInput(questionRoutingDeps, input),
      handleQuestionModal: input => handleModalSubmit(questionRoutingDeps, input),
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
      purgeChannelBinding: async (guildId, channelId) => {
        await channelTable.delete(bindChannelKey(guildId, channelId))
        rpcLog('discord_reconcile_channel_retired', { channelId, reason: 'discord-deleted' })
      },
      model: createModelPort(apiProxy, { log: rpcLog }),
      modelSelectOperatorOnly: () => current.modelSelectOperatorOnly,
      resumeCandidates: createResumeCandidatesPort({
        listSessions: () => listSessionSummaries(apiProxy, { log: rpcLog }),
        boundSessionIds: () => {
          const bound = new Set<string>()
          for (const [, record] of threadTable.entries()) bound.add(record.sessionId)
          return bound
        },
        copy,
      }),
      resumeSession: async ({ sessionId, workspaceId, guildId, parentChannelId, actorId }) => {
        const rest = await sharedRest()
        if (rest === undefined) return { outcome: 'failed' }
        // threadBindings is the Discord-ownership record: a session with a
        // binding already lives in a thread (16.44; the owners-store wiring
        // stays deferred per 16.28).
        const existingThread = threadForSession(sessionId)
        if (existingThread !== undefined) return { outcome: 'already-bound', threadId: existingThread }
        // The control channel never carries sessions: refuse explicitly so
        // the user is pointed at the workspace channel (16.44 rev).
        const listedChannels = await rest.request<Array<{ id: string; name: string; type: number; parent_id?: string }>>('GET', `/guilds/${guildId}/channels`)
        if (listedChannels.outcome === 'completed') {
          const category = listedChannels.body.find(channel => channel.type === 4 && channel.name.toLowerCase() === CATEGORY_NAME.toLowerCase())
          const control = category !== undefined
            ? listedChannels.body.find(channel => channel.type === 0 && channel.parent_id === category.id && channel.name.toLowerCase() === 'general')
            : undefined
          if (control !== undefined && control.id === parentChannelId) {
            return { outcome: 'refused-control-channel' }
          }
        }
        const summaries = await listSessionSummaries(apiProxy, { log: rpcLog })
        if (summaries.outcome !== 'completed') return { outcome: 'failed' }
        const summary = summaries.sessions.find(candidate => candidate.sessionId === sessionId)
        if (summary === undefined || summary.blank) return { outcome: 'failed' }
        // Spec scenario "Subagent Session selected": a subagent spawn is
        // never a top-level writable thread, even if handed in directly
        // (the candidates already hide it — 16.48).
        if (summary.origin === 'subagent') return { outcome: 'refused-subagent' }
        // Same defense for archived sessions (16.49): adoption would
        // succeed and the thread would never see a turn.
        const catalog = await catalogPort.listWorkspaces()
        if (catalog.outcome === 'completed'
          && catalog.archivedSessionIds.includes(sessionId)) {
          return { outcome: 'refused-archived' }
        }
        const title = summary.title ?? `Resume ${sessionId.slice(0, 8)}`
        // Anchor post: a durable marker the resume thread hangs off.
        const anchor = await rest.request<{ id?: string }>('POST', `/channels/${parentChannelId}/messages`, {
          content: copy.sessionResumeAnchor(safeTitle(title)),
          flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG,
          allowed_mentions: ALLOWED_MENTIONS_NONE,
        })
        if (anchor.outcome === 'rejected') {
          rpcLog('discord_session_resume_anchor_failed', { sessionId, status: `HTTP ${String(anchor.status)}` })
          return { outcome: 'failed' }
        }
        if (anchor.outcome === 'unknown' || typeof anchor.body.id !== 'string') {
          rpcLog('discord_session_resume_anchor_unknown', { sessionId })
          return { outcome: 'failed' }
        }
        const thread = await rest.request<{ id?: string }>('POST', `/channels/${parentChannelId}/messages/${anchor.body.id}/threads`, {
          name: safeTitle(title),
        })
        if (thread.outcome === 'rejected') {
          rpcLog('discord_session_resume_thread_failed', { sessionId, status: `HTTP ${String(thread.status)}` })
          return { outcome: 'failed' }
        }
        if (thread.outcome === 'unknown' || typeof thread.body.id !== 'string') {
          rpcLog('discord_session_resume_thread_unknown', { sessionId })
          return { outcome: 'failed' }
        }
        await threadBindingStore.bind(threadBindingKey({ applicationId: applicationIdRef.current, guildId, threadId: thread.body.id }), {
          sessionId,
          workspaceId,
          createdBy: actorId,
          createdAtMs: Date.now(),
        })
        rpcLog('discord_session_resumed', { sessionId, threadId: thread.body.id, title })
        return { outcome: 'started', threadId: thread.body.id }
      },
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
      applicationId: () => applicationIdRef.current,
      mainline,
      bindings,
      unboundNotice: (request) => {
        const content = request.audience === 'administrator'
          ? copy.unboundNoticeAdministrator
          : copy.unboundNoticeMember
        void withRest(async (rest) => {
          const sent = await rest.request('POST', `/channels/${request.channelId}/messages`, { content, flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG, allowed_mentions: ALLOWED_MENTIONS_NONE })
          if (sent.outcome !== 'completed') {
            rpcLog('discord_unbound_notice_send_failed', sent.outcome === 'rejected' ? `HTTP ${String(sent.status)}` : sent.reason)
          }
        }).catch((cause: unknown) => {
          rpcLog('discord_unbound_notice_threw', String(cause))
        })
      },
      approvals: approvalsStore,
      questions: questionsStore,
      status: statusTracker,
      registry: sharedRegistry,
      onReady: () => reconcileOnReady(),
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
    registerCommands = async (): Promise<void> => {
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
      for (const [key, record] of threadTable.entries()) {
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
          // The nonce lets an unobservable send be reconciled instead of
          // blindly retried (rest.ts contract): a message that actually
          // landed is found by its nonce and reported completed.
          const nonce = newNonce()
          const sent = await rest.request<{ id?: string } | undefined>('POST', `/channels/${request.channelId}/messages`, {
            content: request.content,
            flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG,
            allowed_mentions: ALLOWED_MENTIONS_NONE,
            nonce,
          })
          if (sent.outcome === 'completed' && typeof sent.body?.id === 'string') {
            return { outcome: 'completed', messageId: sent.body.id }
          }
          if (sent.outcome === 'unknown') {
            const reconciled = await findSentMessageByNonce(rest, request.channelId, nonce)
            if (reconciled !== undefined) return { outcome: 'completed', messageId: reconciled }
            rpcLog('discord_live_send_unknown', { channelId: request.channelId })
            return { outcome: 'unknown' }
          }
          if (sent.outcome === 'rejected') {
            rpcLog('discord_live_send_failed', { channelId: request.channelId, status: sent.status, error: sent.error })
          } else {
            rpcLog('discord_live_send_failed', { channelId: request.channelId, outcome: sent.outcome })
          }
          return { outcome: 'failed' }
        },
        edit: async (request) => {
          const rest = await sharedRest()
          if (rest === undefined) return { outcome: 'failed' }
          const edited = await rest.request('PATCH', `/channels/${request.channelId}/messages/${request.messageId}`, {
            content: request.content,
            flags: DISCORD_SUPPRESS_NOTIFICATIONS_FLAG,
            allowed_mentions: ALLOWED_MENTIONS_NONE,
          })
          if (edited.outcome === 'rejected') {
            rpcLog('discord_live_edit_failed', { channelId: request.channelId, status: edited.status, error: edited.error })
          }
          return edited.outcome === 'completed' ? { outcome: 'completed' } : { outcome: 'failed' }
        },
        typing: async (channelId) => {
          const rest = await sharedRest()
          if (rest === undefined) return
          await rest.request('POST', `/channels/${channelId}/typing`)
        },
        delete: async (request) => {
          const rest = await sharedRest()
          if (rest === undefined) return { outcome: 'failed' }
          const deleted = await rest.request('DELETE', `/channels/${request.channelId}/messages/${request.messageId}`)
          return deleted.outcome === 'completed' ? { outcome: 'completed' } : { outcome: 'failed' }
        },
        renameThread: async (request) => {
          const rest = await sharedRest()
          if (rest === undefined) return { outcome: 'failed' }
          const renamed = await rest.request('PATCH', `/channels/${request.channelId}`, { name: request.name })
          return renamed.outcome === 'completed' ? { outcome: 'completed' } : { outcome: 'failed' }
        },
      },
      threadName: async (channelId) => {
        const rest = await sharedRest()
        if (rest === undefined) return undefined
        const got = await rest.request<{ name?: string } | undefined>('GET', `/channels/${channelId}`)
        return got.outcome === 'completed' && typeof got.body?.name === 'string' ? got.body.name : undefined
      },
      updateIntervalMs: current.streamUpdateIntervalMs,
      typingIntervalMs: current.typingIntervalMs,
      approvalTimeoutMs: current.approvalTimeoutMs,
      questionTimeoutMs: current.questionTimeoutMs,
      verbosity: current.defaultVerbosity,
      log: rpcLog,
      interruptedMarker: () => copy.interruptedMarker,
      onQueueSnapshot: (sessionId, items) => { queueSnapshots.set(sessionId, items) },
      onTurnEnded: (sessionId) => {
        const turn = turnTracker.active(sessionId)
        if (turn !== undefined) turnTracker.complete(turn.requestId)
        rpcLog('discord_turn_ended', { sessionId, hadActiveTurn: turn !== undefined })
      },
      requests: askWiring,
    })
    ctx.effect(() => () => { liveRef.current?.dispose() }, 'dsh-discord live render')
    ctx.effect(() => () => { runtimeRef.current?.dispose() }, 'dsh-discord composed runtime')

  })().catch((cause: unknown) => {
    console.error('[dsh-discord] composition failed:', cause)
    emitLog(ctx, 'warn', { event: 'discord_compose_failed', cause: String(cause) })
    statusTracker.setGateway('disconnected')
  })


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
