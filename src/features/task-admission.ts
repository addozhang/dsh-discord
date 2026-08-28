/**
 * New-task admission (design.md §4). In a bound project channel, a bot
 * mention carrying non-empty text or a supported image is the canonical
 * new-task interface: it admits one task against the channel's current
 * workspace. Empty mentions answer ephemerally, silent messages are ignored,
 * and unbound channels defer to the bind-affordance flow. Authorization is
 * an input fact — the upstream guard already refused everyone else.
 */

import type { AccessDecision } from '../policy/authorization.js'

export type NewTaskAdmission =
  | { outcome: 'admit-new-task'; workspaceId: string; prompt: string }
  | { outcome: 'empty-mention'; response: 'ephemeral' }
  | { outcome: 'defer-unbound' }
  | { outcome: 'ignore' }

export function admitNewTask(input: {
  decision: AccessDecision
  isBound: boolean
  channelWorkspaceId: string | undefined
  mentionedBot: boolean
  content: string
  hasSupportedImage: boolean
}): NewTaskAdmission {
  if (!input.decision.allowed) return { outcome: 'ignore' }
  if (!input.isBound || input.channelWorkspaceId === undefined) return { outcome: 'defer-unbound' }
  if (!input.mentionedBot) return { outcome: 'ignore' }

  const prompt = input.content.trim()
  if (prompt === '' && !input.hasSupportedImage) {
    return { outcome: 'empty-mention', response: 'ephemeral' }
  }
  return { outcome: 'admit-new-task', workspaceId: input.channelWorkspaceId, prompt }
}
