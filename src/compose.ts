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
import type { AccessDecision, PolicyTable } from './policy/authorization.js'
import type { NormalizedInboundEvent } from './gateway/ingress.js'
import { planUnboundMention } from './features/unbound-mention.js'
import { createComponentRegistry, type ComponentRegistry } from './discord/components.js'
import type { AdapterStatusTracker } from './features/adapter-status.js'
import type { ApprovalStore } from './features/approval-store.js'
import type { QuestionStore } from './features/question-store.js'

/** Discord Gateway wss endpoint (Milestone 1: fixed v10 surface). */
export const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'

/**
 * The session mainline (src/features/session-mainline.ts): the orchestrator
 * behind both message paths — bound-channel mentions create thread/session,
 * adapter-owned thread messages queue continuations.
 */
export interface SessionMainlinePort {
  admitMention(request: {
    applicationId: string
    guildId: string
    channelId: string
    messageId: string
    authorId: string
    workspaceId: string
    prompt: string
  }): Promise<
    | { outcome: 'admitted'; threadId: string; sessionId: string }
    | { outcome: 'thread-conflict' }
    | { outcome: 'thread-failed' }
    | { outcome: 'session-rejected' }
    | { outcome: 'session-unknown' }
    | { outcome: 'prompt-rejected' }
    | { outcome: 'prompt-unknown' }
  >
  continueInThread(request: {
    applicationId: string
    guildId: string
    threadId: string
    sessionId: string
    messageId: string
    prompt: string
  }): Promise<
    | { outcome: 'queued' }
    | { outcome: 'already-submitted' }
    | { outcome: 'conflict' }
    | { outcome: 'rejected' }
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
  /**
   * Gateway endpoint override (twin-E2E seam): defaults to the production
   * wss URL. Must expose the real Gateway wire protocol, not a fake.
   */
  gatewayUrl?: string
  /** Live accessor for the adapter's Discord application id (binding keys). */
  applicationId: () => string
  mainline: SessionMainlinePort
  bindings: BindingsProbe
  approvals: ApprovalStore
  questions: QuestionStore
  status: AdapterStatusTracker
  /**
   * Interaction (commands/components/modals) routing, wired by the Host
   * composition where the typed apiProxy respond face lives.
   */
  routeInteraction?: (event: NormalizedInboundEvent, interactionToken?: string) => void | Promise<void>
  /**
   * Public (non-ephemeral — ordinary messages have no ephemeral channel)
   * bind affordance for an authorized mention in an unbound channel
   * (session-control spec, "New task in an unbound channel"). Absent, the
   * mention is ignored as before.
   */
  unboundNotice?: (request: {
    guildId: string
    channelId: string
    actorId: string
    audience: 'administrator' | 'member'
  }) => void | Promise<void>
  /** Idempotently ensure the category + control channel exist in a guild. */
  ensureGuildChannels?: (guildId: string) => Promise<void>
  /**
   * Runs once per READY after channel provisioning: the reconciliation
   * sweep's trigger (startup mapping verification precedes accepting
   * writes for those mappings — reconciliation spec).
   */
  onReady?: () => void | Promise<void>
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
export function routeEvent(deps: CompositionDeps, event: NormalizedInboundEvent, decision: AccessDecision): void {
  if (event.kind === 'message') {
    const prompt = event.content.trim()

    // Adapter-owned thread: ordinary continuation, no mention required.
    const sessionId = deps.bindings.sessionForThread(event.guildId, event.channelId)
    if (sessionId !== undefined) {
      if (prompt === '') return
      const request = {
        applicationId: deps.applicationId(),
        guildId: event.guildId,
        threadId: event.channelId,
        sessionId,
        messageId: event.messageId,
        prompt,
      }
      void deps.mainline.continueInThread(request)
        .then((result) => {
          if (result.outcome === 'rejected' || result.outcome === 'unknown') {
            deps.logger?.warn('discord_continuation_not_queued', { ...result, messageId: event.messageId })
          }
        })
        .catch((cause: unknown) => {
          deps.logger?.warn('discord_continuation_failed', { messageId: event.messageId, cause: String(cause) })
        })
      return
    }

    // Mention-gated prompt flow: bindings decide admit vs ignore.
    const workspaceId = deps.bindings.workspaceForChannel(event.guildId, event.channelId)
    if (!event.mentionedBot) return
    if (workspaceId === undefined) {
      // Unbound channel: one public bind affordance for authorized members,
      // silent for everyone the guard already refused (spec-as-written,
      // task 16.5). No DSH call ever follows.
      const plan = planUnboundMention({ decision, isBound: false })
      if (plan.outcome === 'bind-affordance') {
        void Promise.resolve(deps.unboundNotice?.({
          guildId: event.guildId,
          channelId: event.channelId,
          actorId: event.authorId,
          audience: plan.audience,
        })).catch((cause: unknown) => {
          deps.logger?.warn('discord_unbound_notice_failed', { cause: String(cause) })
        })
      }
      return
    }
    if (prompt === '') return
    void deps.mainline.admitMention({
      applicationId: deps.applicationId(),
      guildId: event.guildId,
      channelId: event.channelId,
      messageId: event.messageId,
      authorId: event.authorId,
      workspaceId,
      prompt,
    })
      .then((result) => {
        if (result.outcome !== 'admitted') {
          deps.logger?.warn('discord_mention_not_admitted', { result, messageId: event.messageId })
        }
      })
      .catch((cause: unknown) => {
        deps.logger?.warn('discord_mention_admit_failed', { messageId: event.messageId, cause: String(cause) })
      })
    return
  }
  // Interactions are dispatched ONLY from handleDispatch (which owns the
  // interaction token); no token-less forwarding here (double-call bug).
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
    if (dispatch.t === 'READY') status.setGateway('connected')
    const accepted = ingress?.accept(dispatch)
    if (accepted?.accepted === true && accepted.event !== undefined && accepted.event.kind === 'interaction') {
      const d = dispatch.d as Record<string, unknown> | undefined
      const token = typeof d?.['token'] === 'string' ? d['token'] : undefined
      void Promise.resolve(deps.routeInteraction?.(accepted.event, token)).catch((cause: unknown) => {
        console.error('[dsh-discord] interaction handler failed:', cause)
      })
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
    if (dispatch.t === 'READY' && deps.onReady !== undefined) {
      void Promise.resolve(deps.onReady()).catch((cause: unknown) => {
        deps.logger?.warn('discord_ready_reconcile_failed', String(cause))
      })
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
      onEvent: (event, decision) => { routeEvent(deps, event, decision) },
    })

    gateway = startGateway({
      url: deps.gatewayUrl ?? GATEWAY_URL,
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
