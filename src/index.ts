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
import { buildCommandRegistrations } from './discord/commands.js'
import { startDiscordAdapter, type BindingsProbe, type DiscordAdapterRuntime } from './compose.js'
import { createWorkspaceCatalogPort, createWorkspaceResolver, readWorkspaceDetail, promptSession, type DshApiProxyFace } from './dsh/api-proxy-face.js'
import { createProjectListView, workspaceAutocompleteChoices } from './features/project-list.js'
import { projectInfo } from './features/project-info.js'
import { createApprovalStore } from './features/approval-store.js'
import { createQuestionStore } from './features/question-store.js'
import { handleApprovalClick, type DshApprovalRespondPort } from './features/approval-routing.js'
import { channelBindingKey, parseChannelBindingKey } from './state/domain.js'
import { createBindingStore } from './state/bindings.js'
import type { ChannelBinding } from './state/records.js'
import { evaluateAuthorization, levelAtLeast, type PolicyTable } from './policy/authorization.js'
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

  // Channel→Workspace bindings. M1 keeps the store process-local; the
  // durable domain table backing is exercised in the 15.9 profile pass.
  // The Discord application id equals the bot user id, resolved at start.
  const applicationIdRef: { current: string } = { current: 'dsh-discord' }
  const rows = new Map<string, ChannelBinding>()
  const bindingStore = createBindingStore<ChannelBinding>({
    get: key => rows.get(key),
    put: (key, record) => { rows.set(key, record); return Promise.resolve() },
    delete: key => Promise.resolve(rows.delete(key)),
  })
  const bindings: BindingsProbe = {
    workspaceForChannel: (guildId, channelId) =>
      bindingStore.get(channelBindingKey({
        applicationId: applicationIdRef.current, guildId, channelId,
      }))?.workspaceId,
    sessionForThread: () => undefined,
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
      sharedRestCache = { token, client: createSharedRestClient({ token }) }
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
    allowedGuildIds: [...current.allowedGuildIds],
    bindings,
    unboundNotice: (request) => {
      const content = request.audience === 'administrator'
        ? '此频道未绑定工作区。工作区管理员可运行 `/project bind` 创建并绑定项目频道。'
        : '此频道未绑定工作区；请工作区管理员运行 `/project bind`。'
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
    submitPrompt: {
      submit: async (request) => {
        // Definitive Host errors surface as rejections (the sanitized code);
        // a timeout or transport throw is `unknown` — never auto-resubmitted.
        return promptSession(apiProxy, request, { log: rpcLog })
      },
    },
    approvals: createApprovalStore({ get: () => undefined, put: async () => {} }),
    questions: createQuestionStore(),
    status: statusTracker,
    routeInteraction: async (event, interactionToken) => {
      const runtime = runtimeRef.current
      if (runtime === undefined) return
      // Slash commands (type 2): deferred ephemeral ack, then the feature
      // result as an ephemeral followup. /project list+bind close the loop.
      rpcLog('discord_slash_dispatch', {
        interactionId: (event as { interactionId?: string }).interactionId,
        commandName: (event as { commandName?: string }).commandName,
        hasToken: interactionToken !== undefined,
      })
      // Autocomplete (type 4, the Kimaki /resume pattern): live choices for
      // workspace options so no id is ever copy-pasted. Discovery is gated
      // by membership — non-members get zero choices.
      if (event.kind === 'interaction' && event.interactionType === 4 && interactionToken !== undefined) {
        if (event.commandName !== 'project') return
        const decision = evaluateAuthorization(policy(), {
          guildId: event.guildId,
          userId: event.actorId,
          roleIds: event.roleIds,
          memberPermissions: event.memberPermissions,
          isBot: event.isBot,
        })
        const choices: Array<{ name: string; value: string }> = []
        if (decision.allowed) {
          const wireOptions = event.data['options'] as Array<{ name: string; options?: Array<{ name: string; value?: string; focused?: boolean }> }> | undefined
          const sub = Array.isArray(wireOptions) ? wireOptions[0] : undefined
          const focused = Array.isArray(sub?.options) ? sub.options.find(option => option.focused === true) : undefined
          const query = typeof focused?.value === 'string' ? focused.value : ''
          const catalog = await catalogPort.listWorkspaces()
          if (catalog.outcome === 'completed') {
            choices.push(...workspaceAutocompleteChoices(catalog.workspaces, query).slice(0, 25))
          }
        }
        await withRest(async (rest) => {
          const posted = await rest.request('POST', `/interactions/${event.interactionId}/${interactionToken}/callback`, {
            type: 8,
            data: { choices },
          })
          if (posted.outcome !== 'completed') {
            rpcLog('discord_autocomplete_failed', posted.outcome === 'rejected' ? `HTTP ${String(posted.status)}` : posted.reason)
          }
        })
        return
      }
      if (event.kind === 'interaction' && event.interactionType === 2 && interactionToken !== undefined) {
        const rest = await sharedRest()
        if (rest === undefined) { rpcLog('discord_ack_failed', 'missing-token'); return }
        const ack = await rest.request('POST', `/interactions/${event.interactionId}/${interactionToken}/callback`, { type: 5, data: { flags: 64 } })
        if (ack.outcome !== 'completed') { rpcLog('discord_ack_failed', ack.outcome); return }
        // Deferred-ack followups must never fail silently: the REST client
        // resolves (never rejects) 4xx outcomes, so a void'ed call would drop
        // the failure without a trace.
        const followUp = async (
          content: string,
          components?: Array<unknown>,
        ): Promise<void> => {
          const posted = await rest.request('POST', `/webhooks/${applicationIdRef.current}/${interactionToken}`, {
            content,
            flags: 64,
            ...(components === undefined ? {} : { components }),
          })
          if (posted.outcome !== 'completed') {
            rpcLog('discord_followup_failed', posted.outcome === 'rejected' ? `HTTP ${String(posted.status)}` : posted.reason)
          }
        }
        const buttonRow = (confirmId: string, cancelId: string): Array<unknown> => [{
          type: 1,
          components: [
            { type: 2, style: 3, label: '确认绑定', custom_id: confirmId },
            { type: 2, style: 4, label: '取消', custom_id: cancelId },
          ],
        }]
        try {
          if (event.commandName === 'project') {
            const options = event.data['options'] as Array<{ name: string; options?: Array<{ name: string; value?: string }> }> | undefined
            const subcommand = Array.isArray(options) ? options[0] : undefined
            const subName = subcommand?.name
            if (subName === 'bind') {
              // Kimaki add-project semantics: bind provisions (or reuses)
              // the Workspace's home channel under the adapter category.
              // The current channel — e.g. the control channel — is never
              // captured; only the opaque ws: reference crosses the wire.
              const decision = evaluateAuthorization(policy(), {
                guildId: event.guildId,
                userId: event.actorId,
                roleIds: event.roleIds,
                memberPermissions: event.memberPermissions,
                isBot: event.isBot,
              })
              if (!decision.allowed || !levelAtLeast(decision.level, 'workspace-administrator')) {
                await followUp('⛔ 只有工作区管理员可以绑定频道。')
                return
              }
              const wireOptions = Array.isArray(subcommand?.options) ? subcommand.options : []
              const reference = wireOptions.find(option => option.name === 'workspace')?.value
              if (typeof reference !== 'string' || reference === '') {
                await followUp('用法：/project bind workspace:<从候选中选择>')
                return
              }
              const resolvedWorkspace = await resolver.resolve(reference)
              if (resolvedWorkspace.outcome !== 'found') {
                await followUp(resolvedWorkspace.outcome === 'stale'
                  ? '⚠️ 该工作区已不存在，请用 /project bind 的候选重新选择。'
                  : resolvedWorkspace.outcome === 'unknown'
                    ? '⚠️ 工作区目录未在限时内确认（结果未知），请稍后重试。'
                    : '⚠️ 工作区目录暂时不可用，请稍后重试。')
                return
              }
              const { id: workspaceId, title } = resolvedWorkspace.workspace
              const existing = findBoundChannelFor(event.guildId, workspaceId)
              if (existing !== undefined) {
                // Idempotent, Kimaki-style: one workspace, one channel.
                await followUp(`工作区「${title}」的频道已存在于：<#${existing}>`)
                return
              }
              const expiresAtMs = Date.now() + 15 * 60 * 1000
              const confirmId = runtime.registry.register({ kind: 'project-bind', action: 'confirm', workspaceId, workspaceTitle: title, guildId: event.guildId, actorId: event.actorId, expiresAtMs })
              const cancelId = runtime.registry.register({ kind: 'project-bind', action: 'cancel', workspaceId, workspaceTitle: title, guildId: event.guildId, actorId: event.actorId, expiresAtMs })
              rpcLog('discord_project_bind_planned', { interactionId: event.interactionId, workspaceId })
              await followUp(`将为工作区「${title}」创建专属频道（DeepSeek Harness 分类下）？`, buttonRow(confirmId, cancelId))
              return
            }
            if (subName === 'list') {
              rpcLog('discord_project_list_start', { interactionId: event.interactionId })
              const view = await createProjectListView(catalogPort, { selectionId: event.interactionId })
              if (view.outcome !== 'ok') {
                await followUp(view.reason === 'workspace-catalog-unknown'
                  ? '⚠️ 工作区目录未在限时内确认（结果未知），请稍后重试。'
                  : '⚠️ 无法读取工作区目录，请稍后重试。')
                return
              }
              // Names only: the bind option autocompletes live candidates,
              // so ids never need to be read, copied, or typed.
              const rows = view.items.map(item => `• ${item.label}`)
              const pager = view.pageCount > 1 ? `\n（第 ${String(view.pageIndex + 1)}/${String(view.pageCount)} 页）` : ''
              await followUp(rows.length === 0 ? '（没有已注册的工作区）' : ['**可用工作区**', ...rows].join('\n') + pager)
              return
            }
            if (subName === 'info') {
              // Info describes THIS channel's bound workspace. Members see
              // the sanitized identity; the path renders only for proven
              // workspace administrators (ephemeral either way).
              const decision = evaluateAuthorization(policy(), {
                guildId: event.guildId,
                userId: event.actorId,
                roleIds: event.roleIds,
                memberPermissions: event.memberPermissions,
                isBot: event.isBot,
              })
              const binding = bindingStore.get(bindChannelKey(event.guildId, event.channelId))
              if (binding === undefined) {
                // Bind provisions the Workspace's home channel — most
                // channels, including the control channel, are unbound.
                await followUp(decision.allowed
                  ? '此频道未绑定工作区；请到工作区的专属频道中使用（/project bind 可创建）。'
                  : '⛔ 此频道未绑定工作区。')
                return
              }
              const detail = await readWorkspaceDetail(apiProxy, binding.workspaceId, { log: rpcLog })
              if (!decision.allowed) {
                // Refuse identity disclosure to non-members even when bound.
                await followUp('⛔ 只有成员可以查看此频道的绑定。')
                return
              }
              if (detail.outcome !== 'found') {
                await followUp(detail.outcome === 'unknown'
                  ? '⚠️ 工作区目录未在限时内确认（结果未知），请稍后重试。'
                  : detail.outcome === 'stale'
                    ? '⚠️ 绑定的工作区已不存在；请用 /project bind 重新选择。'
                    : '⚠️ 无法读取工作区目录，请稍后重试。')
                return
              }
              const view = projectInfo({
                decision,
                workspace: { id: detail.workspace.id, title: detail.workspace.title, path: detail.workspace.path },
              })
              if (view.outcome !== 'info') {
                await followUp('⛔ 只有成员可以查看此频道的绑定。')
                return
              }
              const lines = [
                `**${view.workspace.label}**`,
                `修订 ${String(binding.revision)}（由 <@${binding.boundBy}> 绑定）`,
              ]
              if (view.workspace.path !== undefined) lines.push(`路径：\`${view.workspace.path}\``)
              await followUp(lines.join('\n'))
              return
            }
            await followUp('未知子命令。')
            return
          }
        } catch (cause) {
          console.error('[dsh-discord] slash handler failed:', cause)
          await followUp('⚠️ 命令处理失败，请稍后重试。').catch(() => {})
        }
        return
      }
      // Component clicks (type 3) carry the opaque custom_id. Bind
      // confirmations resolve first; everything else falls through to the
      // approval routing, which owns its own registry contexts.
      if (event.kind !== 'interaction' || event.interactionType !== 3) return
      const customId = event.data['custom_id']
      if (typeof customId !== 'string') return
      const activeRuntime = runtime
      const resolved = activeRuntime.registry.resolve(customId, Date.now())
      const bindContext = resolved.found ? resolved.context : undefined
      if (bindContext?.['kind'] === 'project-bind') {
        if (interactionToken === undefined) return
        const rest = await sharedRest()
        if (rest === undefined) { rpcLog('discord_ack_failed', 'missing-token'); return }
        // Deferred update ack (type 6): keeps the ephemeral visible while the
        // commit resolves; the result arrives as a fresh ephemeral followup.
        const clicked = await rest.request('POST', `/interactions/${event.interactionId}/${interactionToken}/callback`, { type: 6 })
        if (clicked.outcome !== 'completed') { rpcLog('discord_ack_failed', clicked.outcome); return }
        const followUpResult = async (content: string): Promise<void> => {
          const posted = await rest.request('POST', `/webhooks/${applicationIdRef.current}/${interactionToken}`, { content, flags: 64 })
          if (posted.outcome !== 'completed') {
            rpcLog('discord_followup_failed', posted.outcome === 'rejected' ? `HTTP ${String(posted.status)}` : posted.reason)
          }
        }
        const owner = bindContext['actorId']
        const workspaceId = bindContext['workspaceId']
        const workspaceTitle = bindContext['workspaceTitle']
        const boundGuildId = bindContext['guildId']
        if (
          owner !== event.actorId
          || typeof workspaceId !== 'string'
          || typeof workspaceTitle !== 'string'
          || typeof boundGuildId !== 'string'
        ) {
          // Another member's button (or a malformed context): deny
          // ephemerally and leave the control pending for its rightful owner.
          await followUpResult('⛔ 此确认不属于你。')
          return
        }
        if (bindContext['action'] !== 'confirm') {
          await followUpResult('已取消，未创建频道。')
          return
        }
        // The write happens only now, on explicit confirmation: provision
        // (or reuse) the Workspace's home channel and bind it — the channel
        // the command was typed in is never captured.
        const ensuredChannel = await ensureWorkspaceChannel({
          guildId: boundGuildId,
          workspaceId,
          title: workspaceTitle,
          actorId: event.actorId,
        }).catch((cause: unknown) => {
          rpcLog('discord_workspace_channel_ensure_threw', String(cause))
          return undefined
        })
        if (ensuredChannel === undefined) {
          await followUpResult('⚠️ 频道创建失败，请稍后重试。')
          return
        }
        rpcLog('discord_project_bind_commit', { workspaceId, channelId: ensuredChannel.channelId, created: ensuredChannel.created })
        await followUpResult(ensuredChannel.created
          ? `✅ 已为工作区「${workspaceTitle}」创建频道：<#${ensuredChannel.channelId}>`
          : `工作区「${workspaceTitle}」的频道已存在于：<#${ensuredChannel.channelId}>`)
        return
      }
      void handleApprovalClick(
        {
          registry: activeRuntime.registry,
          store: activeRuntime.approvals,
          port: approvalRespondPort,
          nowMs: () => Date.now(),
        },
        { customId, userId: event.actorId, threadId: event.channelId },
      ).catch((cause: unknown) => {
        emitLog(ctx, 'warn', { event: 'discord_approval_click_failed', cause: String(cause) })
      })
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
