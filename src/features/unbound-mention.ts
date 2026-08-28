/**
 * Unbound-channel mentions and Workspace creation (design.md §4, Non-Goals).
 * A mention in an unbound channel never creates a Session: it answers with an
 * ephemeral bind affordance whose guidance depends on the actor's authority.
 * Workspace creation is a Milestone-1 non-goal, so the request is refused
 * explicitly — the filesystem port exists only to prove no mutation can
 * happen, and the refusal is ephemeral like every other denial.
 */

import type { AccessDecision } from '../policy/authorization.js'

/** What the unbound-mention handler should render. */
export type UnboundMentionPlan =
  | { outcome: 'bind-affordance'; audience: 'administrator' | 'member' }
  | { outcome: 'none' }

/**
 * Decide the response for a mention arriving on an unbound channel. Denied
 * and non-granted actors were already refused upstream; for them (and for
 * bound channels) there is nothing to add.
 */
export function planUnboundMention(input: { decision: AccessDecision; isBound: boolean }): UnboundMentionPlan {
  if (input.isBound) return { outcome: 'none' }
  if (!input.decision.allowed) return { outcome: 'none' }
  return {
    outcome: 'bind-affordance',
    audience: input.decision.level === 'member' ? 'member' : 'administrator',
  }
}

/**
 * The filesystem-shaped surface the creation flow WOULD use. Declared only so
 * the refusal can be tested against it: an implementation reaching for the
 * filesystem is a spec violation.
 */
export interface FilesystemPort {
  stat(path: string): Promise<unknown>
  mkdir(path: string): Promise<unknown>
}

export type WorkspaceCreationResult = {
  outcome: 'refused'
  reason: 'workspace-creation-unavailable'
  response: 'ephemeral'
}

/**
 * Milestone 1 never creates directories or registers new Workspaces: refuse
 * explicitly, touch nothing, and answer ephemerally.
 */
export function planWorkspaceCreation(
  _request: { requestedPath: string; actorId: string },
  deps: { filesystem: FilesystemPort },
): Promise<WorkspaceCreationResult> {
  void deps.filesystem
  return Promise.resolve({ outcome: 'refused', reason: 'workspace-creation-unavailable', response: 'ephemeral' })
}
