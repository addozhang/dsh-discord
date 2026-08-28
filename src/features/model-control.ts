/**
 * `/model show` and the guarded `/model select` (design.md §7, tasks 10.2 +
 * 10.3). A successful `session.selectModel` changes the addressed session AND
 * attempts to persist that choice as the host default for future sessions, so
 * mutation is restricted to the explicit global Host-operator allowlist —
 * Guild-local administrators are denied. The confirmation states BOTH facts
 * and nothing more: `applied-with-host-default`, `partial-session-only` (the
 * session changed but persistence did not land), or a plain rejection/unknown.
 * Catalog and reasoning-effort validation happen before any DSH call.
 */

import type { AccessDecision } from '../policy/authorization.js'

export interface DshModelPort {
  catalog(): Promise<
    | { outcome: 'completed'; providers: ReadonlyArray<{ provider: string; models: ReadonlyArray<{ id: string; reasonings: readonly string[] }> }> }
    | { outcome: 'failed' }
    | { outcome: 'unknown' }
  >
  selectModel(request: { sessionId: string; modelId: string; reasoning?: string }): Promise<
    | { outcome: 'completed'; sessionApplied: boolean; defaultPersisted: boolean }
    | { outcome: 'rejected'; reason: string }
    | { outcome: 'unknown' }
  >
}

export type ModelCatalogView =
  | { outcome: 'ok'; providers: ReadonlyArray<{ provider: string; models: ReadonlyArray<{ id: string; reasonings: readonly string[] }> }> }
  | { outcome: 'failed'; reason: 'model-catalog-unavailable' | 'model-catalog-unknown' }

export async function showModelCatalog(
  port: DshModelPort,
  _request: { sessionId: string },
): Promise<ModelCatalogView> {
  const catalog = await port.catalog()
  if (catalog.outcome === 'failed') return { outcome: 'failed', reason: 'model-catalog-unavailable' }
  if (catalog.outcome === 'unknown') return { outcome: 'failed', reason: 'model-catalog-unknown' }
  return { outcome: 'ok', providers: catalog.providers }
}

export type ModelSelectResult =
  | { outcome: 'applied-with-host-default'; sessionApplied: boolean; defaultPersisted: boolean }
  | { outcome: 'partial-session-only'; sessionApplied: boolean; defaultPersisted: boolean }
  | { outcome: 'rejected' }
  | { outcome: 'unknown' }
  | { outcome: 'refused'; reason: 'not-host-operator' | 'model-not-in-catalog' | 'invalid-reasoning-effort' }

export async function selectModel(
  port: DshModelPort,
  request: {
    decision: AccessDecision
    sessionId: string
    modelId: string
    reasoning?: string | undefined
  },
): Promise<ModelSelectResult> {
  // Host-operator authority ONLY: a Guild administrator is not enough,
  // because the selection attempts to persist a host-wide default.
  if (!request.decision.allowed || request.decision.level !== 'host-operator') {
    return { outcome: 'refused', reason: 'not-host-operator' }
  }

  const catalog = await port.catalog()
  if (catalog.outcome !== 'completed') {
    return { outcome: 'refused', reason: 'model-not-in-catalog' }
  }
  const model = catalog.providers
    .flatMap(provider => provider.models)
    .find(candidate => candidate.id === request.modelId)
  if (model === undefined) {
    return { outcome: 'refused', reason: 'model-not-in-catalog' }
  }
  if (request.reasoning !== undefined && !model.reasonings.includes(request.reasoning)) {
    return { outcome: 'refused', reason: 'invalid-reasoning-effort' }
  }

  const selected = await port.selectModel({
    sessionId: request.sessionId,
    modelId: request.modelId,
    ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
  })
  if (selected.outcome !== 'completed') {
    return selected.outcome === 'rejected' ? { outcome: 'rejected' } : { outcome: 'unknown' }
  }

  // State exactly what DSH proved — both facts, never overstated.
  if (selected.sessionApplied && selected.defaultPersisted) {
    return { outcome: 'applied-with-host-default', sessionApplied: true, defaultPersisted: true }
  }
  return { outcome: 'partial-session-only', sessionApplied: selected.sessionApplied, defaultPersisted: selected.defaultPersisted }
}
