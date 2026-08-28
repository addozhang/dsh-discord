/**
 * Bounded retention and Guild forget (design.md §10). Completed intents and
 * deliveries default to 30-day retention; resolved interactions to 7 days;
 * no configured window may drop below the 7-day floor. Unresolved records —
 * claimed prompts and unknown outcomes — never expire on a timer: they wait
 * for explicit user resolution or a Guild forget. Active channel/thread
 * bindings are ownership, not history, and no retention rule touches them.
 * A Guild forget plans the removal of only that guild's adapter records;
 * DSH workspaces and sessions are structurally out of reach.
 */

import type { InboundIntentRecord } from './intents.js'

const DAY = 24 * 60 * 60_000

/** The retention floor: no configured window may go below 7 days. */
export const MINIMUM_RETENTION_MS = 7 * DAY
/** Default retention for completed (succeeded/failed) intents and deliveries. */
export const DEFAULT_COMPLETED_RETENTION_MS = 30 * DAY
/** Default retention for resolved interactions. */
export const DEFAULT_INTERACTION_RETENTION_MS = 7 * DAY

export interface RetentionPolicy {
  completedRetentionMs?: number | undefined
  interactionRetentionMs?: number | undefined
}

export interface NormalizedRetentionPolicy {
  completedRetentionMs: number
  interactionRetentionMs: number
}

/** Clamp a policy into the legal range, applying defaults. */
export function normalizeRetentionPolicy(policy: RetentionPolicy): NormalizedRetentionPolicy {
  const clamp = (value: number | undefined, fallback: number): number =>
    value === undefined || !Number.isFinite(value)
      ? fallback
      : Math.max(value, MINIMUM_RETENTION_MS)
  return {
    completedRetentionMs: clamp(policy.completedRetentionMs, DEFAULT_COMPLETED_RETENTION_MS),
    interactionRetentionMs: clamp(policy.interactionRetentionMs, DEFAULT_INTERACTION_RETENTION_MS),
  }
}

/** Resolved-intent record shape (subset) the sweep reasons about. */
export interface SweepableIntent {
  state: InboundIntentRecord['state']
  resolvedAtMs?: number | undefined
}

export interface SweepableInteraction {
  resolvedAtMs: number
}

export interface SweepInput {
  intents: ReadonlyArray<[string, SweepableIntent]>
  resolvedInteractions: ReadonlyArray<[string, SweepableInteraction]>
}

export interface SweepOptions {
  nowMs: number
  policy?: RetentionPolicy | undefined
}

export interface SweepPlan {
  intentKeys: string[]
  interactionKeys: string[]
}

/**
 * Plan one retention sweep. Only terminal, resolved records age out:
 * `claimed` and `unknown` intents are retained indefinitely (unknown until
 * explicit user resolution), regardless of age.
 */
export function sweepExpired(input: SweepInput, options: SweepOptions): SweepPlan {
  const policy = normalizeRetentionPolicy(options.policy ?? {})

  const intentKeys = input.intents
    .filter(([, record]) => {
      if (record.state !== 'succeeded' && record.state !== 'failed') return false
      const resolvedAtMs = record.resolvedAtMs
      if (resolvedAtMs === undefined) return false
      return options.nowMs - resolvedAtMs >= policy.completedRetentionMs
    })
    .map(([key]) => key)

  const interactionKeys = input.resolvedInteractions
    .filter(([, record]) => options.nowMs - record.resolvedAtMs >= policy.interactionRetentionMs)
    .map(([key]) => key)

  return { intentKeys, interactionKeys }
}

export interface ForgetPlanInput {
  guildId: string
  channelBindingKeys: readonly string[]
  threadBindingKeys: readonly string[]
}

export interface ForgetPlan {
  channelKeys: string[]
  threadKeys: string[]
  /**
   * Always empty: intent keys are message-scoped, so forget planning cannot
   * sweep them by guild — deliberate, to keep DSH-side data structurally
   * unreachable from a Discord-initiated forget.
   */
  intentKeys: string[]
}

/**
 * Plan one Guild forget: parse every binding key and keep only those whose
 * guild matches. Removal execution (deletes) stays with the caller, which
 * holds the open domain tables.
 */
export function guildKeysToForget(input: ForgetPlanInput): ForgetPlan {
  const parse = (key: string): string | undefined => {
    const segments = key.split(':')
    if (segments.length !== 6) return undefined
    const guildId = segments[3]
    return guildId === input.guildId ? key : undefined
  }
  return {
    channelKeys: input.channelBindingKeys.filter(key => parse(key) !== undefined),
    threadKeys: input.threadBindingKeys.filter(key => parse(key) !== undefined),
    intentKeys: [],
  }
}
