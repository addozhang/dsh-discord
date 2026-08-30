/**
 * The interaction router (extracted from the Host composition root so the
 * whole command/component surface is testable against the Discord API twin).
 * Every path re-checks authorization where the event alone cannot prove it
 * (workspace-administrator level, catalog freshness), answers interactions
 * through the deferred-ack + ephemeral-followup pattern, and maps every DSH
 * outcome onto caller-facing copy without ever retrying.
 */

import type { ComponentRegistry } from '../discord/components.js'
import type { SharedRestClient } from '../discord/rest.js'
import { evaluateAuthorization, levelAtLeast, type PolicyTable } from '../policy/authorization.js'
import { OUTBOUND_EPHEMERAL_FLAGS } from '../policy/disclosure.js'
import { workspaceAutocompleteChoices, createProjectListView, type ProjectListPort } from './project-list.js'
import { projectInfo } from './project-info.js'
import type { WorkspaceResolver } from './project-bind.js'
import type { CancelOutcome, PromptOutcome, QueueRemoveOutcome, WorkspaceDetailOutcome } from '../dsh/api-proxy-face.js'
import { planSteer } from './steer-control.js'
import { planStop } from './stop-control.js'
import type { TurnTracker } from './turn-ownership.js'
import { handleApprovalClick, type ApprovalClickOutcome, type DshApprovalRespondPort } from './approval-routing.js'
import type { QuestionInteractionOutcome } from './question-routing.js'
import type { ApprovalStore } from './approval-store.js'
import type { ChannelBinding } from '../state/records.js'
import type { NormalizedInteraction } from '../gateway/inbound.js'
import type { CopyTable } from '../i18n.js'

/** The DSH faces the control commands submit through (apiProxy-backed). */
export interface InteractionDshFace {
  cancel(sessionId: string): Promise<CancelOutcome>
  steer(sessionId: string, prompt: string): Promise<PromptOutcome>
  removeQueueItem(sessionId: string, itemId: string): Promise<QueueRemoveOutcome>
  readWorkspaceDetail(reference: string): Promise<WorkspaceDetailOutcome>
}

export interface InteractionRouterDeps {
  policy: () => PolicyTable
  applicationId: () => string
  /** The shared component registry (render + click routing use one instance). */
  registry: ComponentRegistry
  /** Discord-visible copy, resolved per access (language can change live). */
  copy: CopyTable
  approvals: ApprovalStore
  approvalRespondPort: DshApprovalRespondPort
  turnTracker: TurnTracker
  /** Latest mux queue snapshots per session — the /queue surface's source. */
  queueSnapshots: Map<string, Array<{ id: string; summary: string }>>
  dsh: InteractionDshFace
  catalogPort: ProjectListPort
  resolver: WorkspaceResolver
  channelBinding: (guildId: string, channelId: string) => ChannelBinding | undefined
  findBoundChannelFor: (guildId: string, workspaceId: string) => string | undefined
  sessionForThread: (guildId: string, threadId: string) => string | undefined
  ensureWorkspaceChannel: (options: {
    guildId: string
    workspaceId: string
    title: string
    actorId: string
  }) => Promise<{ channelId: string; created: boolean } | undefined>
  /** Delete every adapter-owned record for one guild (DSH untouched). */
  forgetGuild: (guildId: string) => Promise<void>
  /** Ephemeral failure/guidance followup on a component interaction. */
  componentFollowUp: (interactionId: string, interactionToken: string, content: string) => Promise<void>
  /** Retire a rendered control (remove its components on the source message). */
  disableControl: (key: string) => Promise<void>
  /** Question select/submit clicks and modal submits (module-tested routing). */
  handleQuestionComponent: (input: {
    customId: string
    userId: string
    threadId: string
    values: string[]
  }) => Promise<QuestionInteractionOutcome>
  handleQuestionModal: (input: {
    customId: string
    userId: string
    threadId: string
    text: string
  }) => QuestionInteractionOutcome
  rest: () => Promise<SharedRestClient | undefined>
  log: (event: string, detail?: unknown) => void
  warn: (event: string, detail?: unknown) => void
}

type RouterEvent = NormalizedInteraction

export function createInteractionRouter(deps: InteractionRouterDeps): {
  route(event: NormalizedInteraction, interactionToken?: string): Promise<void>
} {
  /** Authorize one interaction against the live policy table. */
  function authorize(event: RouterEvent) {
    return evaluateAuthorization(deps.policy(), {
      guildId: event.guildId,
      userId: event.actorId,
      roleIds: event.roleIds,
      memberPermissions: event.memberPermissions,
      isBot: event.isBot,
    })
  }

  async function routeAutocomplete(event: RouterEvent, interactionToken: string): Promise<void> {
    if (event.commandName !== 'project') return
    const decision = authorize(event)
    const choices: Array<{ name: string; value: string }> = []
    if (decision.allowed) {
      const wireOptions = event.data['options'] as Array<{ name: string; options?: Array<{ name: string; value?: string; focused?: boolean }> }> | undefined
      const sub = Array.isArray(wireOptions) ? wireOptions[0] : undefined
      const focused = Array.isArray(sub?.options) ? sub.options.find(option => option.focused === true) : undefined
      const query = typeof focused?.value === 'string' ? focused.value : ''
      const catalog = await deps.catalogPort.listWorkspaces()
      if (catalog.outcome === 'completed') {
        choices.push(...workspaceAutocompleteChoices(catalog.workspaces, query).slice(0, 25))
      }
    }
    const rest = await deps.rest()
    if (rest === undefined) return
    const posted = await rest.request('POST', `/interactions/${event.interactionId}/${interactionToken}/callback`, {
      type: 8,
      data: { choices },
    })
    if (posted.outcome !== 'completed') {
      deps.log('discord_autocomplete_failed', posted.outcome === 'rejected' ? `HTTP ${String(posted.status)}` : posted.reason)
    }
  }

  async function routeSlashCommand(event: RouterEvent, interactionToken: string): Promise<void> {
    const rest = await deps.rest()
    if (rest === undefined) { deps.log('discord_ack_failed', 'missing-token'); return }
    const ack = await rest.request('POST', `/interactions/${event.interactionId}/${interactionToken}/callback`, { type: 5, data: { flags: 64 } })
    if (ack.outcome !== 'completed') { deps.log('discord_ack_failed', ack.outcome); return }
    // Deferred-ack followups must never fail silently: the REST client
    // resolves (never rejects) 4xx outcomes, so a void'ed call would drop
    // the failure without a trace.
    const followUp = async (content: string, components?: Array<unknown>): Promise<void> => {
      const posted = await rest.request('POST', `/webhooks/${deps.applicationId()}/${interactionToken}`, {
        content,
        flags: OUTBOUND_EPHEMERAL_FLAGS,
        ...(components === undefined ? {} : { components }),
      })
      if (posted.outcome !== 'completed') {
        deps.log('discord_followup_failed', posted.outcome === 'rejected' ? `HTTP ${String(posted.status)}` : posted.reason)
      }
    }
    const buttonRow = (confirmId: string, cancelId: string): Array<unknown> => [{
      type: 1,
      components: [
        { type: 2, style: 3, label: deps.copy.bindConfirmButton, custom_id: confirmId },
        { type: 2, style: 4, label: deps.copy.bindCancelButton, custom_id: cancelId },
      ],
    }]
    try {
      if (event.commandName === 'project') {
        const options = event.data['options'] as Array<{ name: string; options?: Array<{ name: string; value?: string }> }> | undefined
        const subcommand = Array.isArray(options) ? options[0] : undefined
        const subName = subcommand?.name
        if (subName === 'bind') {
          // Add-project semantics: bind provisions (or reuses)
          // the Workspace's home channel under the adapter category.
          // The current channel — e.g. the control channel — is never
          // captured; only the opaque ws: reference crosses the wire.
          const decision = authorize(event)
          if (!decision.allowed || !levelAtLeast(decision.level, 'workspace-administrator')) {
            await followUp(deps.copy.bindAdminOnly)
            return
          }
          const wireOptions = Array.isArray(subcommand?.options) ? subcommand.options : []
          const reference = wireOptions.find(option => option.name === 'workspace')?.value
          if (typeof reference !== 'string' || reference === '') {
            await followUp(deps.copy.bindUsage)
            return
          }
          const resolvedWorkspace = await deps.resolver.resolve(reference)
          if (resolvedWorkspace.outcome !== 'found') {
            await followUp(resolvedWorkspace.outcome === 'stale'
              ? deps.copy.bindWorkspaceGone
              : resolvedWorkspace.outcome === 'unknown'
                ? deps.copy.bindWorkspaceUnknown
                : deps.copy.bindWorkspaceUnavailable)
            return
          }
          const { id: workspaceId, title } = resolvedWorkspace.workspace
          const existing = deps.findBoundChannelFor(event.guildId, workspaceId)
          if (existing !== undefined) {
            // Idempotent: one workspace, one channel.
            await followUp(deps.copy.bindChannelExists(title, existing))
            return
          }
          const expiresAtMs = Date.now() + 15 * 60 * 1000
          const confirmId = deps.registry.register({ kind: 'project-bind', action: 'confirm', workspaceId, workspaceTitle: title, guildId: event.guildId, actorId: event.actorId, expiresAtMs })
          const cancelId = deps.registry.register({ kind: 'project-bind', action: 'cancel', workspaceId, workspaceTitle: title, guildId: event.guildId, actorId: event.actorId, expiresAtMs })
          deps.log('discord_project_bind_planned', { interactionId: event.interactionId, workspaceId })
          await followUp(deps.copy.bindConfirmPrompt(title), buttonRow(confirmId, cancelId))
          return
        }
        if (subName === 'list') {
          deps.log('discord_project_list_start', { interactionId: event.interactionId })
          const view = await createProjectListView(deps.catalogPort, { selectionId: event.interactionId })
          if (view.outcome !== 'ok') {
            await followUp(view.reason === 'workspace-catalog-unknown'
              ? deps.copy.infoUnknown
              : deps.copy.infoUnavailable)
            return
          }
          // Names only: the bind option autocompletes live candidates,
          // so ids never need to be read, copied, or typed.
          const rows = view.items.map(item => `• ${item.label}`)
          const pager = view.pageCount > 1 ? deps.copy.listPager(view.pageIndex + 1, view.pageCount) : ''
          await followUp(rows.length === 0 ? deps.copy.listEmpty : [deps.copy.listHeader, ...rows].join('\n') + pager)
          return
        }
        if (subName === 'info') {
          // Info describes THIS channel's bound workspace. Any authorized
          // member sees the identity plus the canonical path (amended
          // design §3 / 16.1); the response is ephemeral either way.
          const decision = authorize(event)
          const binding = deps.channelBinding(event.guildId, event.channelId)
          if (binding === undefined) {
            // Bind provisions the Workspace's home channel — most
            // channels, including the control channel, are unbound.
            await followUp(decision.allowed
              ? deps.copy.infoUnboundAllowed
              : deps.copy.infoUnbound)
            return
          }
          const detail = await deps.dsh.readWorkspaceDetail(binding.workspaceId)
          if (!decision.allowed) {
            // Refuse identity disclosure to non-members even when bound.
            await followUp(deps.copy.infoMemberOnly)
            return
          }
          if (detail.outcome !== 'found') {
            await followUp(detail.outcome === 'unknown'
              ? deps.copy.infoUnknown
              : detail.outcome === 'stale'
                ? deps.copy.infoStale
                : deps.copy.infoUnavailable)
            return
          }
          const view = projectInfo({
            decision,
            workspace: { id: detail.workspace.id, title: detail.workspace.title, path: detail.workspace.path },
          })
          if (view.outcome !== 'info') {
            await followUp(deps.copy.infoMemberOnly)
            return
          }
          const lines = [
            `**${view.workspace.label}**`,
            deps.copy.infoRevision(String(binding.revision), binding.boundBy),
          ]
          if (view.workspace.path !== undefined) lines.push(deps.copy.infoPath(view.workspace.path))
          await followUp(lines.join('\n'))
          return
        }
        await followUp(deps.copy.unknownSubcommand)
        return
      }
      // ── Session control commands (session-control spec) ─────────────
      // Every control path resolves the calling thread's session binding
      // first; ownership comes from the turn tracker's request IDs, never
      // from a session's running status.
      if (event.commandName === 'stop' || event.commandName === 'steer') {
        const sessionId = deps.sessionForThread(event.guildId, event.channelId)
        if (sessionId === undefined) {
          await followUp(deps.copy.stopNotSessionThread)
          return
        }
        if (event.commandName === 'stop') {
          const result = await planStop(
            {
              cancel: async ({ sessionId: id }) => {
                const cancelled = await deps.dsh.cancel(id)
                return cancelled.outcome === 'accepted'
                  ? { outcome: 'accepted' as const, pendingPreserved: true }
                  : cancelled.outcome === 'rejected'
                    ? { outcome: 'rejected' as const, reason: cancelled.reason }
                    : { outcome: 'unknown' as const }
              },
            },
            deps.turnTracker,
            { sessionId, threadId: event.channelId },
          )
          if (result.outcome === 'refused') {
            await followUp(result.reason === 'no-active-turn'
              ? deps.copy.stopNothingRunning
              : deps.copy.stopNotOwner)
            return
          }
          if (result.outcome === 'cancelled') {
            await followUp(result.pendingPreserved ? deps.copy.stopStoppedQueuePreserved : deps.copy.stopStopped)
            return
          }
          await followUp(result.outcome === 'rejected'
            ? deps.copy.stopRejected
            : deps.copy.stopUnknown)
          return
        }
        // /steer <prompt>
        const steerText = typeof event.data['options'] === 'object'
          ? (event.data['options'] as Array<{ name?: unknown; value?: unknown }>).find(option => option.name === 'prompt')?.value
          : undefined
        const prompt = typeof steerText === 'string' ? steerText.trim() : ''
        if (prompt === '') {
          await followUp(deps.copy.steerUsage)
          return
        }
        const result = await planSteer(
          {
            steer: async ({ sessionId: id }) => {
              const steered = await deps.dsh.steer(id, prompt)
              return steered.outcome === 'accepted'
                ? { outcome: 'accepted' as const }
                : steered.outcome === 'rejected'
                  ? { outcome: 'rejected' as const, reason: steered.reason }
                  : { outcome: 'unknown' as const }
            },
          },
          deps.turnTracker,
          { sessionId, threadId: event.channelId, prompt },
        )
        if (result.outcome === 'refused') {
          await followUp(result.reason === 'no-active-turn'
            ? deps.copy.steerNothingRunning
            : deps.copy.steerNotOwner)
          return
        }
        await followUp(result.outcome === 'accepted'
          ? deps.copy.steerQueued
          : result.outcome === 'rejected'
            ? deps.copy.steerRejected
            : deps.copy.steerUnknown)
        return
      }
      if (event.commandName === 'queue') {
        const sessionId = deps.sessionForThread(event.guildId, event.channelId)
        if (sessionId === undefined) {
          await followUp(deps.copy.queueNotSessionThread)
          return
        }
        const wireOptions = event.data['options'] as Array<{ name?: unknown; options?: Array<{ name?: unknown; value?: unknown }> }> | undefined
        const sub = Array.isArray(wireOptions) ? wireOptions[0] : undefined
        if (sub?.name === 'remove') {
          const raw = Array.isArray(sub.options) ? sub.options.find(option => option.name === 'item')?.value : undefined
          const reference = typeof raw === 'string' ? raw.trim() : ''
          if (reference === '') {
            await followUp(deps.copy.queueRemoveUsage)
            return
          }
          const snapshot = deps.queueSnapshots.get(sessionId)
          const byPosition = /^\d+$/.test(reference)
            ? snapshot?.[Number.parseInt(reference, 10) - 1]
            : snapshot?.find(item => item.id === reference)
          if (byPosition === undefined) {
            await followUp(deps.copy.queueItemNotFound)
            return
          }
          const removed = await deps.dsh.removeQueueItem(sessionId, byPosition.id)
          if (removed.outcome === 'accepted') {
            await followUp(deps.copy.queueRemoved(byPosition.summary))
            return
          }
          await followUp(removed.outcome === 'rejected'
            ? deps.copy.queueRemoveRejected
            : deps.copy.queueRemoveUnknown)
          return
        }
        // /queue list — the mux snapshot cache is the data source.
        const snapshot = deps.queueSnapshots.get(sessionId)
        if (snapshot === undefined) {
          await followUp(deps.copy.queueNoData)
          return
        }
        if (snapshot.length === 0) {
          await followUp(deps.copy.queueEmpty)
          return
        }
        const rows = snapshot.map((item, index) => `${String(index + 1)}. ${item.summary}`)
        await followUp([deps.copy.queueHeader, ...rows, '', deps.copy.queueRemoveHint].join('\n'))
        return
      }
      if (event.commandName === 'guild') {
        const options = event.data['options'] as Array<{ name: string; options?: Array<{ name: string; value?: string }> }> | undefined
        const subName = Array.isArray(options) ? options[0]?.name : undefined
        if (subName !== 'forget') {
          await followUp(deps.copy.unknownSubcommand)
          return
        }
        // Guild forget mutates adapter-owned state for the whole guild:
        // Host-operator authority ONLY (binding-state spec; decision 16.7).
        const isOperator = deps.policy().hostOperatorUserIds.includes(event.actorId)
        if (!isOperator) {
          await followUp(deps.copy.forgetOperatorOnly)
          return
        }
        const expiresAtMs = Date.now() + 15 * 60 * 1000
        const confirmId = deps.registry.register({ kind: 'guild-forget', action: 'confirm', guildId: event.guildId, actorId: event.actorId, expiresAtMs })
        await followUp(deps.copy.forgetConfirmPrompt, [{
          type: 1,
          components: [{ type: 2, style: 4, label: deps.copy.forgetConfirmButton, custom_id: confirmId }],
        }])
        return
      }
    } catch (cause) {
      console.error('[dsh-discord] slash handler failed:', cause)
      await followUp(deps.copy.commandFailed).catch(() => {})
    }
  }

  async function routeBindComponent(event: RouterEvent, interactionToken: string): Promise<void> {
    const customId = event.data['custom_id']
    if (typeof customId !== 'string') return
    const resolved = deps.registry.resolve(customId, Date.now())
    const bindContext = resolved.found ? resolved.context : undefined
    if (bindContext?.['kind'] !== 'project-bind') return
    const rest = await deps.rest()
    if (rest === undefined) { deps.log('discord_ack_failed', 'missing-token'); return }
    // Deferred update ack (type 6): keeps the ephemeral visible while the
    // commit resolves; the result arrives as a fresh ephemeral followup.
    const clicked = await rest.request('POST', `/interactions/${event.interactionId}/${interactionToken}/callback`, { type: 6 })
    if (clicked.outcome !== 'completed') { deps.log('discord_ack_failed', clicked.outcome); return }
    const followUpResult = async (content: string): Promise<void> => {
      const posted = await rest.request('POST', `/webhooks/${deps.applicationId()}/${interactionToken}`, { content, flags: OUTBOUND_EPHEMERAL_FLAGS })
      if (posted.outcome !== 'completed') {
        deps.log('discord_followup_failed', posted.outcome === 'rejected' ? `HTTP ${String(posted.status)}` : posted.reason)
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
      await followUpResult(deps.copy.confirmNotOwner)
      return
    }
    if (bindContext['action'] !== 'confirm') {
      await followUpResult(deps.copy.bindCancelled)
      return
    }
    // The write happens only now, on explicit confirmation: provision
    // (or reuse) the Workspace's home channel and bind it — the channel
    // the command was typed in is never captured.
    const ensuredChannel = await deps.ensureWorkspaceChannel({
      guildId: boundGuildId,
      workspaceId,
      title: workspaceTitle,
      actorId: event.actorId,
    }).catch((cause: unknown) => {
      deps.log('discord_workspace_channel_ensure_threw', String(cause))
      return undefined
    })
    if (ensuredChannel === undefined) {
      await followUpResult(deps.copy.bindChannelFailed)
      return
    }
    deps.log('discord_project_bind_commit', { workspaceId, channelId: ensuredChannel.channelId, created: ensuredChannel.created })
    await followUpResult(ensuredChannel.created
      ? deps.copy.bindChannelCreated(workspaceTitle, ensuredChannel.channelId)
      : deps.copy.bindChannelExisting(workspaceTitle, ensuredChannel.channelId))
  }

  async function routeGuildForGetComponent(event: RouterEvent, interactionToken: string): Promise<void> {
    const customId = event.data['custom_id']
    if (typeof customId !== 'string') return
    const resolved = deps.registry.resolve(customId, Date.now())
    const context = resolved.found ? resolved.context : undefined
    if (context?.['kind'] !== 'guild-forget') return
    const rest = await deps.rest()
    if (rest === undefined) { deps.log('discord_ack_failed', 'missing-token'); return }
    const clicked = await rest.request('POST', `/interactions/${event.interactionId}/${interactionToken}/callback`, { type: 6 })
    if (clicked.outcome !== 'completed') { deps.log('discord_ack_failed', clicked.outcome); return }
    const owner = context['actorId']
    const guildId = context['guildId']
    if (owner !== event.actorId || typeof guildId !== 'string' || guildId !== event.guildId) {
      const denied = await rest.request('POST', `/webhooks/${deps.applicationId()}/${interactionToken}`, { content: deps.copy.confirmNotOwner, flags: OUTBOUND_EPHEMERAL_FLAGS })
      if (denied.outcome !== 'completed') deps.log('discord_followup_failed', denied.outcome)
      return
    }
    await deps.forgetGuild(guildId)
    deps.log('discord_guild_forget_commit', { guildId })
    const posted = await rest.request('POST', `/webhooks/${deps.applicationId()}/${interactionToken}`, {
      content: deps.copy.forgetDone,
      flags: OUTBOUND_EPHEMERAL_FLAGS,
    })
    if (posted.outcome !== 'completed') deps.log('discord_followup_failed', posted.outcome)
  }

  async function settleQuestionInteraction(
    event: RouterEvent,
    interactionToken: string,
    outcome: QuestionInteractionOutcome,
  ): Promise<void> {
    if (outcome.outcome === 'modal-requested') {
      const rest = await deps.rest()
      if (rest === undefined) return
      const modal = outcome.modal
      await rest.request('POST', `/interactions/${event.interactionId}/${interactionToken}/callback`, {
        type: 9,
        data: {
          custom_id: modal.custom_id,
          components: [{
            type: 1,
            components: [{
              type: 4,
              custom_id: 'answer',
              style: 2,
              label: modal.textInput.label,
              min_length: modal.textInput.min_length,
              max_length: modal.textInput.max_length,
              required: true,
            }],
          }],
        },
      })
      return
    }
    // Every other outcome settles as a deferred update plus an ephemeral
    // followup; the rendered controls retire only on terminal outcomes.
    const rest = await deps.rest()
    if (rest === undefined) return
    await rest.request('POST', `/interactions/${event.interactionId}/${interactionToken}/callback`, { type: 6 })
    const notice: string | undefined =
      outcome.outcome === 'submitted' ? deps.copy.questionSubmitted
      : outcome.outcome === 'denied' ? deps.copy.questionDenied
      : outcome.outcome === 'already-resolved' ? deps.copy.questionAlreadyResolved
      : outcome.outcome === 'incomplete' ? deps.copy.questionIncomplete
      : outcome.outcome === 'invalid-answer' ? deps.copy.questionInvalid(outcome.reason)
      : outcome.outcome === 'unresolved' ? deps.copy.questionUnresolved
      : outcome.outcome === 'resolved-elsewhere' ? deps.copy.questionResolvedElsewhere
      : undefined
    if (notice !== undefined) await deps.componentFollowUp(event.interactionId, interactionToken, notice)
  }

  return {
    async route(event, interactionToken) {
      deps.log('discord_slash_dispatch', {
        interactionId: event.interactionId,
        commandName: event.commandName,
        hasToken: interactionToken !== undefined,
      })
      if (event.interactionType === 4 && interactionToken !== undefined) {
        await routeAutocomplete(event, interactionToken)
        return
      }
      if (event.interactionType === 2 && interactionToken !== undefined) {
        await routeSlashCommand(event, interactionToken)
        return
      }
      if (event.interactionType === 5 && interactionToken !== undefined) {
        const modalCustomId = event.data['custom_id']
        if (typeof modalCustomId !== 'string') return
        try {
          const text = event.modalFields.find(field => field.customId === 'answer')?.value ?? ''
          const outcome = deps.handleQuestionModal({
            customId: modalCustomId,
            userId: event.actorId,
            threadId: event.channelId,
            text,
          })
          deps.log('discord_question_modal_submit', { outcome: outcome.outcome, userId: event.actorId })
          await settleQuestionInteraction(event, interactionToken, outcome)
        } catch (cause) {
          deps.warn('discord_question_modal_failed', String(cause))
          const rest = await deps.rest()
          if (rest !== undefined) {
            await rest.request('POST', `/interactions/${event.interactionId}/${interactionToken}/callback`, { type: 6 }).catch(() => {})
            await deps.componentFollowUp(event.interactionId, interactionToken, deps.copy.commandFailed).catch(() => {})
          }
        }
        return
      }
      if (event.interactionType !== 3) return
      const customId = event.data['custom_id']
      if (typeof customId !== 'string') return
      if (interactionToken === undefined) return
      const resolved = deps.registry.resolve(customId, Date.now())
      const bindContext = resolved.found ? resolved.context : undefined
      if (bindContext?.['kind'] === 'project-bind') {
        await routeBindComponent(event, interactionToken)
        return
      }
      if (bindContext?.['kind'] === 'guild-forget') {
        await routeGuildForGetComponent(event, interactionToken)
        return
      }
      // A not-found custom_id means the control was never registered or has
      // been retired by its TTL (approval/question contexts stay resolvable
      // until claim). Kimaki discipline: an expired click still gets the
      // deferred ack plus an explicit ephemeral rerun hint — never silence.
      if (bindContext === undefined) {
        const rest = await deps.rest()
        if (rest !== undefined) {
          await rest.request('POST', `/interactions/${event.interactionId}/${interactionToken}/callback`, { type: 6 }).then(acked => {
            if (acked.outcome !== 'completed') deps.log('discord_ack_failed', acked.outcome)
          }).catch(() => {})
          await deps.componentFollowUp(event.interactionId, interactionToken, deps.copy.expiredControl).catch(() => {})
        }
        return
      }
      const isQuestionControl: boolean = 'questionRpcId' in bindContext
      const isApprovalControl: boolean = 'approvalId' in bindContext
      if (isQuestionControl) {
        // A throw here must still ack the click, or Discord renders the
        // interaction-failed state on the control message.
        try {
          const outcome = await deps.handleQuestionComponent({
            customId,
            userId: event.actorId,
            threadId: event.channelId,
            values: event.selectValues,
          })
          deps.log('discord_question_click', { outcome: outcome.outcome, userId: event.actorId, complete: outcome.outcome === 'recorded' ? outcome.complete : undefined })
          await settleQuestionInteraction(event, interactionToken, outcome)
        } catch (cause) {
          deps.warn('discord_question_click_failed', String(cause))
          const rest = await deps.rest()
          if (rest !== undefined) {
            await rest.request('POST', `/interactions/${event.interactionId}/${interactionToken}/callback`, { type: 6 }).then(acked => {
              if (acked.outcome !== 'completed') deps.log('discord_ack_failed', acked.outcome)
            }).catch(() => {})
            await deps.componentFollowUp(event.interactionId, interactionToken, deps.copy.commandFailed).catch(() => {})
          }
        }
        return
      }
      if (isApprovalControl) {
        // Ack the click BEFORE the DSH round-trip: component interactions
        // must receive an initial response within 3s or every followup 404s.
        const rest0 = await deps.rest()
        if (rest0 !== undefined) {
          const acked = await rest0.request('POST', `/interactions/${event.interactionId}/${interactionToken}/callback`, { type: 6 })
          if (acked.outcome !== 'completed') deps.log('discord_ack_failed', acked.outcome)
        }
        let outcome: ApprovalClickOutcome
        try {
          outcome = await handleApprovalClick(
            {
              registry: deps.registry,
              store: deps.approvals,
              port: deps.approvalRespondPort,
              nowMs: () => Date.now(),
            },
            { customId, userId: event.actorId, threadId: event.channelId },
          )
        } catch (cause) {
          deps.warn('discord_approval_click_failed', String(cause))
          return
        }
        const approvalId = typeof bindContext['approvalId'] === 'string' ? bindContext['approvalId'] : ''
        deps.log('discord_approval_click', { outcome: outcome.outcome, userId: event.actorId, approvalId })
        if (outcome.outcome === 'submitted' || outcome.outcome === 'already-resolved' || outcome.outcome === 'unresolved') {
          await deps.disableControl(approvalId)
        }
        if (outcome.outcome === 'denied') {
          await deps.componentFollowUp(event.interactionId, interactionToken, deps.copy.confirmNotOwner)
        } else if (outcome.outcome === 'unresolved') {
          await deps.componentFollowUp(event.interactionId, interactionToken, deps.copy.unresolvedAck)
        } else if (outcome.outcome === 'submitted') {
          await deps.componentFollowUp(event.interactionId, interactionToken, deps.copy.submittedAck)
        }
        return
      }
    },
  }
}
