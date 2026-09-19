/**
 * `/permission show` and the guarded `/permission set` (design.md §7, tasks
 * 16.59–16.61). A permission preset is the Host's bundle of sandbox mode +
 * approval policy; the switch goes through the Host's own `/permission`
 * command path (the same entry the web UI uses), so the journal records the
 * command/run + command/done audit pair and the Host runs its own admission
 * (unknown preset → error text). The adapter validates against the live
 * catalog first — deployments configure their own preset tables.
 *
 * The default gate is stricter than /model's: `danger-full-access` disables
 * sandbox AND approval at once, so only the explicit Host-operator allowlist
 * may switch (`permissionSelectOperatorOnly: true`); single-user deployments
 * may loosen it, and a member-level decision still never authorizes.
 */

import type { AccessDecision } from '../policy/authorization.js'

export interface DshPermissionPort {
  /** The deployment's live preset catalog (read from `permissionPresets`). */
  catalog(): Promise<
    | { outcome: 'completed'; entries: ReadonlyArray<{ value: string; name?: string }> }
    | { outcome: 'failed' }
    | { outcome: 'unknown' }
  >
  /** The session's current preset off the `permissions` projection view. */
  current(sessionId: string): Promise<
    | { outcome: 'completed'; preset: string }
    | { outcome: 'failed' }
    | { outcome: 'unknown' }
  >
  /** Switch through the Host `/permission` command path. */
  set(sessionId: string, preset: string): Promise<
    | { outcome: 'completed'; preset: string }
    | { outcome: 'rejected'; reason: string }
    | { outcome: 'unknown' }
  >
}

export type PermissionShowResult =
  | { outcome: 'ok'; current: string | undefined; entries: ReadonlyArray<string> }
  | { outcome: 'failed' }

/** `/permission show`: the current preset plus the switchable catalog. */
export async function showPermission(
  port: DshPermissionPort,
  request: { sessionId: string },
): Promise<PermissionShowResult> {
  const [catalog, current] = await Promise.all([port.catalog(), port.current(request.sessionId)])
  if (catalog.outcome !== 'completed') return { outcome: 'failed' }
  return {
    outcome: 'ok',
    ...(current.outcome === 'completed' ? { current: current.preset } : { current: undefined }),
    entries: catalog.entries.map(entry => entry.value),
  }
}

export type PermissionApplyResult =
  | { outcome: 'applied'; preset: string }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown' }
  | { outcome: 'refused'; reason: 'not-host-operator' | 'preset-not-in-catalog' }

/**
 * The presets that strip BOTH confinement layers at once; switching to one
 * requires an explicit risk confirmation (the web UI shows the same gate).
 */
export const CONFIRM_REQUIRED_PRESETS: readonly string[] = ['danger-full-access']

export function requiresConfirmation(preset: string): boolean {
  return CONFIRM_REQUIRED_PRESETS.includes(preset)
}

export async function applyPermissionPreset(
  port: DshPermissionPort,
  request: {
    decision: AccessDecision
    sessionId: string
    preset: string
    /**
     * Keep the Host-operator restriction (default, stricter than /model).
     * Single-user deployments may drop it so administrators of the
     * allowlisted guild can switch (16.60); members are denied either way.
     */
    requireHostOperator?: boolean | undefined
  },
): Promise<PermissionApplyResult> {
  const requireOperator = request.requireHostOperator ?? true
  if (requireOperator) {
    // Host-operator authority ONLY: a Guild administrator is not enough —
    // the switch can strip sandbox and approval from the Session.
    if (!request.decision.allowed || request.decision.level !== 'host-operator') {
      return { outcome: 'refused', reason: 'not-host-operator' }
    }
  }
  if (!request.decision.allowed) {
    return { outcome: 'refused', reason: 'not-host-operator' }
  }

  const catalog = await port.catalog()
  if (catalog.outcome !== 'completed') {
    return { outcome: 'refused', reason: 'preset-not-in-catalog' }
  }
  if (!catalog.entries.some(entry => entry.value === request.preset)) {
    return { outcome: 'refused', reason: 'preset-not-in-catalog' }
  }

  const applied = await port.set(request.sessionId, request.preset)
  if (applied.outcome === 'completed') return { outcome: 'applied', preset: applied.preset }
  if (applied.outcome === 'rejected') return { outcome: 'rejected', reason: applied.reason }
  return { outcome: 'unknown' }
}
