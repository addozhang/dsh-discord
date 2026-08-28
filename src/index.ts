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
import { createRestClient } from './discord/rest.js'
import { buildCommandRegistrations } from './discord/commands.js'
import { startDiscordAdapter, type BindingsProbe, type DiscordAdapterRuntime } from './compose.js'
import { createWorkspaceCatalogPort, createWorkspaceResolver, promptSession, type DshApiProxyFace } from './dsh/api-proxy-face.js'
import { createProjectListView } from './features/project-list.js'
import { createProjectBindFlow, type ProjectBindPlan } from './features/project-bind.js'
import { createApprovalStore } from './features/approval-store.js'
import { createQuestionStore } from './features/question-store.js'
import { handleApprovalClick, type DshApprovalRespondPort } from './features/approval-routing.js'
import { channelBindingKey } from './state/domain.js'
import { createBindingStore } from './state/bindings.js'
import type { ChannelBinding } from './state/records.js'
import { evaluateAuthorization, type PolicyTable } from './policy/authorization.js'
import { workspaceReference } from './policy/disclosure.js'
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

  // The bind flow's two phases plan against the live catalog and commit
  // through the revision-fenced store; the Discord confirm button carries
  // only an opaque registry id between the phases.
  const bindFlow = createProjectBindFlow({
    resolver: createWorkspaceResolver(apiProxy, { log: rpcLog }),
    bindings: bindingStore,
  })

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
      const token = (await resolveDiscordBotToken(credentials)) ?? ''
      const rest = createRestClient({ token })
      const me = await rest.request<{ id: string }>('GET', '/users/@me')
      if (me.outcome !== 'completed') throw new TypeError('cannot resolve bot identity')
      return me.body.id
    },
    intents: GATEWAY_INTENTS,
    allowedGuildIds: [...current.allowedGuildIds],
    bindings,
    ensureGuildChannels: async (guildId) => {
      const token = (await resolveDiscordBotToken(credentials)) ?? ''
      if (token === '') return
      const rest = createRestClient({ token })
      const channels = await rest.request<Array<{ id: string; name: string; type: number; parent_id?: string }>>('GET', `/guilds/${guildId}/channels`)
      if (channels.outcome !== 'completed') return
      const CATEGORY_NAME = 'DeepSeek Harness'
      const CHANNEL_NAME = 'general'
      let category: { id: string; name: string; type: number; parent_id?: string } | undefined = channels.body.find((c) => c.type === 4 && c.name.toLowerCase() === CATEGORY_NAME.toLowerCase())
      if (category === undefined) {
        const made = await rest.request<{ id: string; name: string; type: number }>('POST', `/guilds/${guildId}/channels`, { name: CATEGORY_NAME, type: 4 })
        if (made.outcome !== 'completed') return
        category = made.body
      }
      const hasControl = channels.body.some((c) => c.type === 0 && c.name.toLowerCase() === CHANNEL_NAME && c.parent_id === category.id)
      if (hasControl) return
      // Never touch channels outside our category: create our own only.
      await rest.request('POST', `/guilds/${guildId}/channels`, { name: CHANNEL_NAME, type: 0, parent_id: category.id })
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
      if (event.kind === 'interaction' && event.interactionType === 2 && interactionToken !== undefined) {
        const rest = createRestClient({ token: (await resolveDiscordBotToken(credentials)) ?? '' })
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
              // `/project bind workspace:<ws:id>`: plan against the live
              // catalog, then hand the decision to an ephemeral confirm
              // button. Only the opaque registry id crosses the wire.
              const wireOptions = Array.isArray(subcommand?.options) ? subcommand.options : []
              const reference = wireOptions.find(option => option.name === 'workspace')?.value
              if (typeof reference !== 'string' || reference === '') {
                await followUp('用法：/project bind workspace:<从 /project list 复制的引用>')
                return
              }
              const decision = evaluateAuthorization(policy(), {
                guildId: event.guildId,
                userId: event.actorId,
                roleIds: event.roleIds,
                memberPermissions: event.memberPermissions,
                isBot: event.isBot,
              })
              const plan = await bindFlow.plan({
                decision,
                scope: {
                  applicationId: applicationIdRef.current,
                  guildId: event.guildId,
                  channelId: event.channelId,
                },
                actorId: event.actorId,
                reference,
                confirmed: false,
              })
              if (plan.outcome !== 'planned') {
                await followUp(plan.reason === 'not-authorized'
                  ? '⛔ 只有工作区管理员可以绑定频道。'
                  : plan.reason === 'workspace-no-longer-registered'
                    ? '⚠️ 该工作区已不存在，请用 /project list 重新选择。'
                    : '⚠️ 工作区目录暂时不可用，请稍后重试。')
                return
              }
              const expiresAtMs = Date.now() + 15 * 60 * 1000
              const confirmId = runtime.registry.register({ kind: 'project-bind', action: 'confirm', plan, actorId: event.actorId, expiresAtMs })
              const cancelId = runtime.registry.register({ kind: 'project-bind', action: 'cancel', plan, actorId: event.actorId, expiresAtMs })
              rpcLog('discord_project_bind_planned', { interactionId: event.interactionId, workspaceId: plan.workspaceId })
              await followUp(`将把当前频道绑定到工作区 \`${reference}\`？`, buttonRow(confirmId, cancelId))
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
              const rows = view.items.map(item => `• ${item.label} — \`${item.value}\``)
              const pager = view.pageCount > 1 ? `\n（第 ${String(view.pageIndex + 1)}/${String(view.pageCount)} 页）` : ''
              await followUp(rows.length === 0 ? '（没有已注册的工作区）' : ['**可用工作区**', ...rows].join('\n') + pager)
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
        const rest = createRestClient({ token: (await resolveDiscordBotToken(credentials)) ?? '' })
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
        const plan = bindContext['plan'] as ProjectBindPlan | undefined
        const owner = bindContext['actorId']
        if (plan === undefined || plan.outcome !== 'planned' || owner !== event.actorId) {
          // Another member's button: deny ephemerally and leave the control
          // pending for its rightful owner.
          await followUpResult('⛔ 此确认不属于你。')
          return
        }
        const cancelled = bindContext['action'] !== 'confirm'
        const result = await bindFlow.commit(plan, { cancelled })
        rpcLog('discord_project_bind_commit', { action: bindContext['action'], outcome: result.outcome })
        if (result.outcome === 'bound') {
          await followUpResult(`✅ 已绑定到工作区 \`${workspaceReference(result.binding.workspaceId)}\`（修订 ${String(result.binding.revision)}）。`)
          return
        }
        await followUpResult(cancelled
          ? '已取消，绑定未变更。'
          : '⚠️ 绑定状态已变化，请重新执行 /project bind。')
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
      const token = (await resolveDiscordBotToken(credentials)) ?? ''
      if (token === '') return
      const rest = createRestClient({ token })
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
