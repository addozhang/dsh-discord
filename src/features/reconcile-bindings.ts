/**
 * Binding reconciliation (design.md §11 steps 1–2, 8–9; task 15.1/15.2). At
 * startup every persisted mapping is checked against the DSH Workspace and
 * Session baseline and the Discord channel surface. Retirement ever removes
 * only the adapter's own record — Host Workspaces and Sessions are never
 * deleted by the adapter — and a mapping the adapter cannot verify right now
 * stays in a blocked state for a later sweep instead of being guessed away.
 */

import type { ChannelBinding, ThreadBinding } from '../state/records.js'

/** The DSH baseline the adapter reconciles against (workspace.list / session list). */
export interface DshBaseline {
  workspaces: ReadonlyArray<{ workspaceId: string; title: string; path: string }>
  sessionIds: ReadonlySet<string> | readonly string[]
}

/** Discord channel reachability as observed through the REST surface. */
export type DiscordChannelStatus = 'ok' | 'missing' | 'unknown'

export interface DiscordChannelFacts {
  channels: Readonly<Record<string, DiscordChannelStatus>>
}

export type ChannelBindingAction =
  | { channelId: string; action: 'keep' }
  | { channelId: string; action: 'keep-blocked'; reason: 'discord-unverified' }
  | { channelId: string; action: 'retire'; reason: 'workspace-missing' | 'discord-deleted' }
  | { channelId: string; action: 'update-metadata'; metadata: { title: string; path: string } }

export type ThreadBindingAction =
  | { threadId: string; action: 'keep' }
  | { threadId: string; action: 'keep-blocked'; reason: 'discord-unverified' }
  | { threadId: string; action: 'retire'; reason: 'workspace-missing' | 'session-missing' | 'discord-deleted' }

export interface BindingReconciliationInput {
  channelBindings: ReadonlyArray<ChannelBinding & { channelId: string }>
  threadBindings: ReadonlyArray<ThreadBinding & { threadId: string }>
  baseline: DshBaseline
  discord: DiscordChannelFacts
  /** The adapter's cached Workspace labels; a mismatch plans a refresh. */
  cachedWorkspaceMetadata?: Readonly<Record<string, { title: string; path: string }>> | undefined
}

export interface BindingReconciliationPlan {
  channelActions: ChannelBindingAction[]
  threadActions: ThreadBindingAction[]
}

function workspaceSet(baseline: DshBaseline): Map<string, { title: string; path: string }> {
  return new Map(baseline.workspaces.map(workspace => [workspace.workspaceId, { title: workspace.title, path: workspace.path }]))
}

function sessionSet(baseline: DshBaseline): Set<string> {
  return new Set(baseline.sessionIds)
}

/** Plan one reconciliation pass. Pure: callers decide how actions are applied. */
export function planBindingReconciliation(input: BindingReconciliationInput): BindingReconciliationPlan {
  const workspaces = workspaceSet(input.baseline)
  const sessions = sessionSet(input.baseline)

  const channelActions: ChannelBindingAction[] = input.channelBindings.map((binding) => {
    const workspace = workspaces.get(binding.workspaceId)
    if (workspace === undefined) {
      return { channelId: binding.channelId, action: 'retire' as const, reason: 'workspace-missing' as const }
    }
    const status = input.discord.channels[binding.channelId]
    if (status === 'missing') {
      return { channelId: binding.channelId, action: 'retire' as const, reason: 'discord-deleted' as const }
    }
    if (status === 'unknown') {
      return { channelId: binding.channelId, action: 'keep-blocked' as const, reason: 'discord-unverified' as const }
    }
    const cached = input.cachedWorkspaceMetadata?.[binding.workspaceId]
    if (cached !== undefined && (cached.title !== workspace.title || cached.path !== workspace.path)) {
      return { channelId: binding.channelId, action: 'update-metadata' as const, metadata: workspace }
    }
    return { channelId: binding.channelId, action: 'keep' as const }
  })

  const threadActions: ThreadBindingAction[] = input.threadBindings.map((binding) => {
    if (!workspaces.has(binding.workspaceId)) {
      return { threadId: binding.threadId, action: 'retire' as const, reason: 'workspace-missing' as const }
    }
    if (!sessions.has(binding.sessionId)) {
      return { threadId: binding.threadId, action: 'retire' as const, reason: 'session-missing' as const }
    }
    const status = input.discord.channels[binding.threadId]
    if (status === 'missing') {
      return { threadId: binding.threadId, action: 'retire' as const, reason: 'discord-deleted' as const }
    }
    if (status === 'unknown') {
      return { threadId: binding.threadId, action: 'keep-blocked' as const, reason: 'discord-unverified' as const }
    }
    return { threadId: binding.threadId, action: 'keep' as const }
  })

  return { channelActions, threadActions }
}
