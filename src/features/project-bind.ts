/**
 * `/project bind <workspace>` (design.md §4, §13). Workspace administrators
 * bind the current project channel to a registered DSH Workspace. The flow is
 * two-phase: `plan` authorizes, resolves the selection against the live
 * catalog (a since-deleted Workspace is reported stale), and snapshots the
 * existing binding's revision; `commit` writes through the revision-fenced
 * store only after explicit confirmation. Everything is a value: a refused
 * member, a stale workspace, a cancelled confirmation, and a lost race never
 * leave a partial write behind.
 */

import { levelAtLeast, type AccessDecision } from '../policy/authorization.js'
import type { ChannelBinding } from '../state/records.js'
import type { ChannelBindingScope } from '../state/domain.js'
import type { ChannelBindingStore } from '../state/bindings.js'

/** How the feature verifies a selection still exists in the DSH catalog. */
export interface WorkspaceResolver {
  resolve(reference: string): Promise<
    | { outcome: 'found'; workspace: { id: string; title: string } }
    | { outcome: 'stale' }
    | { outcome: 'failed' }
    | { outcome: 'unknown' }
  >
}

export interface ProjectBindDeps {
  resolver: WorkspaceResolver
  bindings: ChannelBindingStore
}

export interface ProjectBindPlanRequest {
  decision: AccessDecision
  scope: ChannelBindingScope
  /** Discord user id performing the bind (recorded as `boundBy`). */
  actorId: string
  /** The opaque selection value (`ws:<id>`) chosen in the list. */
  reference: string
  /** Whether the confirmation control was already answered affirmatively. */
  confirmed: boolean
}

export type ProjectBindPlan =
  | {
      outcome: 'planned'
      scope: ChannelBindingScope
      actorId: string
      workspaceId: string
      /** Revision the commit must fence against; undefined for a fresh bind. */
      previousRevision: number | undefined
    }
  | { outcome: 'refused'; reason: 'not-authorized' | 'workspace-no-longer-registered' | 'workspace-catalog-unavailable' }

export type ProjectBindResult =
  | { outcome: 'bound'; binding: ChannelBinding }
  | { outcome: 'cancelled' }
  | { outcome: 'stale-revision' }

export function createProjectBindFlow(deps: ProjectBindDeps): {
  plan(request: ProjectBindPlanRequest): Promise<ProjectBindPlan>
  commit(plan: ProjectBindPlan, options?: { cancelled?: boolean }): Promise<ProjectBindResult>
} {
  const channelKey = (scope: ChannelBindingScope): string =>
    `app:${scope.applicationId}:guild:${scope.guildId}:channel:${scope.channelId}`

  async function plan(request: ProjectBindPlanRequest): Promise<ProjectBindPlan> {
    // Authorization precedes every other step, including the catalog read.
    if (!request.decision.allowed || !levelAtLeast(request.decision.level, 'workspace-administrator')) {
      return { outcome: 'refused', reason: 'not-authorized' }
    }

    const resolved = await deps.resolver.resolve(request.reference)
    if (resolved.outcome === 'stale') {
      return { outcome: 'refused', reason: 'workspace-no-longer-registered' }
    }
    if (resolved.outcome !== 'found') {
      return { outcome: 'refused', reason: 'workspace-catalog-unavailable' }
    }

    const current = deps.bindings.get(channelKey(request.scope))
    return {
      outcome: 'planned',
      scope: request.scope,
      actorId: request.actorId,
      workspaceId: resolved.workspace.id,
      previousRevision: current?.revision,
    }
  }

  async function commit(plan: ProjectBindPlan, options: { cancelled?: boolean } = {}): Promise<ProjectBindResult> {
    if (plan.outcome !== 'planned') return { outcome: 'cancelled' }
    if (options.cancelled === true) return { outcome: 'cancelled' }

    const key = channelKey(plan.scope)
    const record = {
      workspaceId: plan.workspaceId,
      boundBy: plan.actorId,
      boundAtMs: Date.now(),
    }
    const result = plan.previousRevision === undefined
      ? await deps.bindings.bind(key, record)
      : await deps.bindings.bind(key, record, { expectedRevision: plan.previousRevision })

    if (!result.ok) {
      // already-bound cannot occur across a fenced expectedRevision commit;
      // a lost race surfaces as stale-revision for the caller to re-plan.
      return { outcome: 'stale-revision' }
    }
    return { outcome: 'bound', binding: result.binding }
  }

  return { plan, commit }
}
