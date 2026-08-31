/**
 * `/model show` and the guarded `/model select` (design.md §7, tasks 10.2 +
 * 10.3 + 16.35). Selection goes through `session.selectModel`: the session
 * switches immediately and the Host records the choice as the default for
 * sessions that have not logged their own — the RPC response only proves the
 * session switch, so the confirmation states the session change and the
 * default request, never a persistence outcome. Because the switch reaches
 * the Host-wide default, mutation is restricted to the explicit global
 * Host-operator allowlist — Guild-local administrators are denied. Provider/
 * model/reasoning validation runs against the session's live catalog before
 * any mutation.
 */

import type { AccessDecision } from '../policy/authorization.js'
import type {
  ModelSelectionShape,
  SessionModelsShape,
} from '../dsh/api-proxy-face.js'

export interface DshModelPort {
  models(sessionId: string): Promise<
    | { outcome: 'completed'; models: SessionModelsShape }
    | { outcome: 'failed' }
    | { outcome: 'unknown' }
  >
  selectModel(request: {
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  }): Promise<
    | { outcome: 'completed'; selected: ModelSelectionShape }
    | { outcome: 'rejected'; reason: string }
    | { outcome: 'unknown' }
  >
}

export type ModelsView =
  | { outcome: 'completed'; models: SessionModelsShape }
  | { outcome: 'failed' }
  | { outcome: 'unknown' }

/** `/model show`: the session's live model directory (current + browsable groups). */
export async function showModels(
  port: DshModelPort,
  request: { sessionId: string },
): Promise<ModelsView> {
  return port.models(request.sessionId)
}

export type ModelApplyResult =
  | { outcome: 'applied'; selected: ModelSelectionShape }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown' }
  | { outcome: 'refused'; reason: 'not-host-operator' | 'model-not-in-catalog' | 'invalid-reasoning-effort' }

export async function applyModelSelection(
  port: DshModelPort,
  request: {
    decision: AccessDecision
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string | undefined
    /**
     * Keep the Host-operator restriction (default). Single-user deployments
     * may drop it so any authorized member of the allowlisted guild can
     * switch — the switch still reaches the Host-wide default (16.42).
     */
    requireHostOperator?: boolean | undefined
  },
): Promise<ModelApplyResult> {
  const requireOperator = request.requireHostOperator ?? true
  if (requireOperator) {
    // Host-operator authority ONLY: a Guild administrator is not enough,
    // because the switch reaches the Host-wide default selection.
    if (!request.decision.allowed || request.decision.level !== 'host-operator') {
      return { outcome: 'refused', reason: 'not-host-operator' }
    }
  }
  if (!request.decision.allowed) {
    return { outcome: 'refused', reason: 'not-host-operator' }
  }

  const directory = await port.models(request.sessionId)
  if (directory.outcome !== 'completed') {
    return { outcome: 'refused', reason: 'model-not-in-catalog' }
  }
  const group = directory.models.groups.find(candidate => candidate.id === request.provider)
  if (group === undefined) {
    return { outcome: 'refused', reason: 'model-not-in-catalog' }
  }
  const model = group.models.find(candidate => candidate.id === request.model)
  if (model === undefined) {
    return { outcome: 'refused', reason: 'model-not-in-catalog' }
  }
  if (request.reasoningEffort !== undefined) {
    const efforts = model.reasoning?.efforts ?? []
    if (!efforts.some(effort => effort.id === request.reasoningEffort)) {
      return { outcome: 'refused', reason: 'invalid-reasoning-effort' }
    }
  }

  const selected = await port.selectModel({
    sessionId: request.sessionId,
    provider: request.provider,
    model: request.model,
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
  })
  if (selected.outcome !== 'completed') {
    return selected.outcome === 'rejected' ? { outcome: 'rejected', reason: selected.reason } : { outcome: 'unknown' }
  }
  return { outcome: 'applied', selected: selected.selected }
}
