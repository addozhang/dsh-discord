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
import { startDiscordAdapter, type BindingsProbe, type DiscordAdapterRuntime } from './compose.js'
import { createApprovalStore } from './features/approval-store.js'
import { createQuestionStore } from './features/question-store.js'
import { handleApprovalClick, type DshApprovalRespondPort } from './features/approval-routing.js'
import { createChannelBindingService } from './state/channel-bindings.js'
import { createBindingStore } from './state/bindings.js'
import type { ChannelBinding } from './state/records.js'
import type { PolicyTable } from './policy/authorization.js'
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
  installDiscordSettings(ctx, current, (next) => {
    current = next
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
  const apiProxy = ctx.get('apiProxy') as unknown as {
    respond: (rpcId: string, payload: unknown) => Promise<unknown>
    sessions: {
      prompt(request: {
        rpcId: string
        payload: { sessionId: string; mode: 'queue'; content: Array<{ type: 'text'; text: string }> }
      }): Promise<unknown>
    }
  }
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
  const rows = new Map<string, ChannelBinding>()
  const bindingStore = createBindingStore<ChannelBinding>({
    get: key => rows.get(key),
    put: (key, record) => { rows.set(key, record); return Promise.resolve() },
    delete: key => Promise.resolve(rows.delete(key)),
  })
  const channelBindings = createChannelBindingService({ store: bindingStore, applicationId: 'dsh-discord' })
  const bindings: BindingsProbe = {
    workspaceForChannel: channelId =>
      channelBindings.resolve({ applicationId: 'dsh-discord', guildId: '', channelId })?.workspaceId,
    sessionForThread: () => undefined,
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
      const socket = new WebSocket(url)
      return {
        url,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        close: (code?: number) => { socket.close(code ?? 1000) },
        terminate: () => { socket.close(1000) },
        send: (data: string) => { socket.send(data) },
      }
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
    bindings,
    submitPrompt: {
      submit: async (request) => {
        const response = await apiProxy.sessions.prompt({
          rpcId: crypto.randomUUID(),
          payload: {
            sessionId: request.sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: request.prompt }],
          },
        }) as { payload?: { accepted?: boolean } } | undefined
        if (response?.payload?.accepted === true) return { outcome: 'accepted' }
        return { outcome: 'unknown' }
      },
    },
    approvals: createApprovalStore({ get: () => undefined, put: async () => {} }),
    questions: createQuestionStore(),
    status: statusTracker,
    routeInteraction: (event) => {
      const runtime = runtimeRef.current
      if (runtime === undefined) return
      // Component clicks (type 3) carry the opaque custom_id; routing
      // resolves it through the shared registry and submits via respond.
      if (event.kind !== 'interaction' || event.interactionType !== 3) return
      const customId = event.data['custom_id']
      if (typeof customId !== 'string') return
      const activeRuntime = runtime
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
