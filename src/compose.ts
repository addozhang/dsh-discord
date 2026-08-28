/**
 * The adapter composition root (review C1). Assembles the runtime the
 * module-level features could not wire themselves into: bot token → Gateway
 * → authorized ingress → business router → Discord REST / DSH apiProxy,
 * plus the settings-card status feed. Everything injected is a port;
 * everything started here is torn down by the returned disposer.
 *
 * Fail-closed by construction: without a resolvable bot token nothing
 * connects, and the status reports exactly that instead of pretending.
 */

import { startGateway, type GatewayDispatch, type GatewayHandle, type GatewaySocketFactory } from './gateway/gateway.js'
import { createAuthorizedIngress } from './policy/guard.js'
import type { PolicyTable } from './policy/authorization.js'
import type { NormalizedInboundEvent } from './gateway/ingress.js'
import { createComponentRegistry, type ComponentRegistry } from './discord/components.js'
import type { AdapterStatusTracker } from './features/adapter-status.js'
import type { ApprovalStore } from './features/approval-store.js'
import type { QuestionStore } from './features/question-store.js'

/** Discord Gateway wss endpoint (Milestone 1: fixed v10 surface). */
export const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'

/** The DSH prompt-submission face the mention flow submits through. */
export interface PromptSubmitPort {
  submit(request: { requestId: string; sessionId: string; prompt: string }): Promise<
    | { outcome: 'accepted' }
    | { outcome: 'rejected'; reason: string }
    | { outcome: 'unknown' }
  >
}

export interface BindingsProbe {
  /** Workspace id bound to the channel, when one exists. */
  workspaceForChannel(guildId: string, channelId: string): string | undefined
  /** Session id owning the thread (writable binding), when one exists. */
  sessionForThread(guildId: string, threadId: string): string | undefined
}

export interface CompositionDeps {
  tokenProvider: () => Promise<string | undefined>
  socketFactory: GatewaySocketFactory
  policy: () => PolicyTable
  /** Resolves the bot's own user id (Discord GET /users/@me) before start. */
  selfUserIdProvider: () => Promise<string>
  /** Gateway intent bitmask (Milestone 1 fixed set). */
  intents: number
  submitPrompt: PromptSubmitPort
  bindings: BindingsProbe
  approvals: ApprovalStore
  questions: QuestionStore
  status: AdapterStatusTracker
  /**
   * Interaction (commands/components/modals) routing, wired by the Host
   * composition where the typed apiProxy respond face lives.
   */
  routeInteraction?: (event: NormalizedInboundEvent, interactionToken?: string) => void
  /** Idempotently ensure the category + control channel exist in a guild. */
  ensureGuildChannels?: (guildId: string) => Promise<void>
  /** Allowlist snapshot used to provision channels on READY. */
  allowedGuildIds?: readonly string[] | undefined
  logger?: { warn(event: string, detail?: unknown): void }
}

export interface DiscordAdapterRuntime {
  registry: ComponentRegistry
  approvals: ApprovalStore
  questions: QuestionStore
  started: boolean
  /** Why the runtime did not start (no token ⇒ fail-closed offline). */
  startError?: 'missing-token' | undefined
  dispose(): void
}

/** Business routing over one normalized, already-authorized event. */
export function routeEvent(deps: CompositionDeps, event: NormalizedInboundEvent): void {
  if (event.kind === 'message') {
    // Mention-gated prompt flow: bindings decide admit vs ignore.
    const workspaceId = deps.bindings.workspaceForChannel(event.guildId, event.channelId)
    if (workspaceId === undefined || !event.mentionedBot) return
    const prompt = event.content.trim()
    if (prompt === '') return
    const requestId = `discord:${event.messageId}`
    void deps.submitPrompt
      .submit({ requestId, sessionId: `pending:${workspaceId}`, prompt })
      .catch(() => {
        deps.logger?.warn('discord_prompt_submit_failed', { requestId })
      })
    return
  }
  deps.routeInteraction?.(event)
}

/**
 * Start the composed adapter runtime. The returned runtime is live after the
 * token resolves; `started` flips once the Gateway has been spawned.
 */
export function startDiscordAdapter(deps: CompositionDeps): DiscordAdapterRuntime {
  const registry = createComponentRegistry()
  const status = deps.status

  let gateway: GatewayHandle | undefined
  let started = false
  let startError: 'missing-token' | undefined
  let ingress: { accept(dispatch: GatewayDispatch): { accepted: boolean; event?: NormalizedInboundEvent } } | undefined

  // Kimaki-style provisioning: one category + one control channel per
  // allowed guild, created idempotently on the first READY.
  const provisioned = new Set<string>()
  function handleDispatch(dispatch: GatewayDispatch): void {
    const accepted = ingress?.accept(dispatch)
    if (accepted?.accepted === true && accepted.event !== undefined && accepted.event.kind === 'interaction') {
      const d = dispatch.d as Record<string, unknown> | undefined
      const token = typeof d?.['token'] === 'string' ? d['token'] : undefined
      deps.routeInteraction?.(accepted.event, token)
    }
    if (dispatch.t === 'READY' && deps.ensureGuildChannels !== undefined) {
      for (const guildId of deps.allowedGuildIds ?? []) {
        if (provisioned.has(guildId)) continue
        provisioned.add(guildId)
        deps.ensureGuildChannels(guildId).catch((cause: unknown) => {
          deps.logger?.warn('discord_channel_provision_failed', { guildId, cause: String(cause) })
        })
      }
    }
  }

  void (async () => {
    const token = await deps.tokenProvider()
    if (token === undefined || token === '') {
      startError = 'missing-token'
      status.setCredential({ configured: false })
      status.setGateway('disconnected')
      return
    }
    status.setCredential({ configured: true })
    const selfUserId = await deps.selfUserIdProvider()

    ingress = createAuthorizedIngress({
      selfUserId,
      policy: deps.policy,
      onEvent: (event) => { routeEvent(deps, event) },
    })

    gateway = startGateway({
      url: GATEWAY_URL,
      tokenProvider: () => deps.tokenProvider().then((value) => {
        if (value === undefined) throw new TypeError('discord bot token unavailable')
        return value
      }),
      intents: deps.intents,
      socketFactory: deps.socketFactory,
      onDispatch: handleDispatch,
      onTerminalClose: (code) => {
        status.setGateway({ kind: 'terminal-close', code })
      },
      onBackoffScheduled: () => {
        status.setGateway('connecting')
      },
    })
    started = true
    status.setGateway('connecting')
  })().catch((cause: unknown) => {
    deps.logger?.warn('discord_adapter_start_failed', String(cause))
    status.setGateway('disconnected')
  })

  return {
    registry,
    approvals: deps.approvals,
    questions: deps.questions,
    get started() { return started },
    get startError() { return startError },
    dispose() {
      gateway?.dispose()
    },
  }
}
