/**
 * `/project info` (design.md §13). Members get the workspace title and its
 * opaque id; the canonical path is disclosed only when the caller carries
 * Workspace-administrator authority, and even then the response stays
 * ephemeral — a path never lands in channel metadata or public messages.
 */

import { levelAtLeast, type AccessDecision } from '../policy/authorization.js'
import { describeWorkspace, type WorkspaceDetail, type WorkspaceEntry } from '../policy/disclosure.js'

export type ProjectInfoView =
  | { outcome: 'info'; workspace: WorkspaceDetail; response: 'ephemeral' }
  | { outcome: 'refused'; reason: 'not-authorized' }

/**
 * Build the info view for one workspace. The path's presence is decided by
 * the caller's ranked authority, and the disclosure policy owns the exact
 * shape — this module only proves the authority and marks the response
 * ephemeral.
 */
export function projectInfo(input: { decision: AccessDecision; workspace: WorkspaceEntry }): ProjectInfoView {
  if (!input.decision.allowed) {
    return { outcome: 'refused', reason: 'not-authorized' }
  }
  const includePath = levelAtLeast(input.decision.level, 'workspace-administrator')
  return {
    outcome: 'info',
    workspace: describeWorkspace(input.workspace, { includePath }),
    response: 'ephemeral',
  }
}
