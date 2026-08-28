/**
 * `/project info` (design.md §3, §13). Any authorized member sees the
 * Workspace identity and its canonical path — paths are not treated as
 * sensitive for this self-hosted, trusted-Guild product — and the response
 * is always ephemeral. A path never lands in durable channel metadata.
 */

import type { AccessDecision } from '../policy/authorization.js'
import { describeWorkspace, type WorkspaceDetail, type WorkspaceEntry } from '../policy/disclosure.js'

export type ProjectInfoView =
  | { outcome: 'info'; workspace: WorkspaceDetail; response: 'ephemeral' }
  | { outcome: 'refused'; reason: 'not-authorized' }

/**
 * Build the info view for one workspace. Authorization proves membership;
 * the disclosure policy owns the exact rendered shape, and the response is
 * always ephemeral.
 */
export function projectInfo(input: { decision: AccessDecision; workspace: WorkspaceEntry }): ProjectInfoView {
  if (!input.decision.allowed) {
    return { outcome: 'refused', reason: 'not-authorized' }
  }
  return {
    outcome: 'info',
    workspace: describeWorkspace(input.workspace, { includePath: true }),
    response: 'ephemeral',
  }
}
