/**
 * Interaction response lifecycle. Discord grants exactly one callback per
 * interaction inside a 3-second ack deadline and a webhook token with a
 * bounded lifetime. This module models that budget as a state machine whose
 * every rule violation is a plain value: double acknowledgements,
 * past-deadline callbacks, and expired tokens refuse locally without a wire
 * call, and wire-side unknown outcomes propagate untouched — the adapter
 * never invents success it did not observe.
 */

import type { RestResult } from './rest.js'

/** The interaction identity Discord delivered. */
export interface InteractionHandle {
  id: string
  token: string
  applicationId: string
}

/** The two wire faces an interaction can use. */
export interface InteractionWire {
  callback(body: Record<string, unknown>): Promise<RestResult<unknown>>
  followUp(body: Record<string, unknown>): Promise<RestResult<unknown>>
}

export interface LifecycleOptions {
  /** Callback budget in ms; Discord's contract is 3000. */
  ackDeadlineMs?: number
  /** Webhook token budget in ms; Discord's contract is 15 minutes. */
  tokenLifetimeMs?: number
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

export type LifecycleOutcome =
  | { ok: true }
  | {
      ok: false
      error:
        | 'already-acknowledged'
        | 'not-acknowledged'
        | 'past-ack-deadline'
        | 'token-expired'
        | 'wire-rejected'
        | 'wire-unknown'
      detail?: string
    }

const DEFAULT_ACK_DEADLINE_MS = 3_000
const DEFAULT_TOKEN_LIFETIME_MS = 15 * 60_000
/** Discord's "Unknown interaction" code: the token no longer resolves. */
const UNKNOWN_INTERACTION_CODE = 10062
/** Ephemeral message flag: only the invoking user sees the response. */
const EPHEMERAL_FLAG = 64

const DISCORD_CALLBACK_RESPOND = 4
const DISCORD_CALLBACK_DEFER = 5

export function createInteractionSession(
  wire: InteractionWire,
  options: LifecycleOptions = {},
): {
  readonly state: 'fresh' | 'responded' | 'deferred'
  respond(data: Record<string, unknown>): Promise<LifecycleOutcome>
  defer(): Promise<LifecycleOutcome>
  followUp(data: Record<string, unknown>): Promise<LifecycleOutcome>
} {
  const ackDeadlineMs = options.ackDeadlineMs ?? DEFAULT_ACK_DEADLINE_MS
  const tokenLifetimeMs = options.tokenLifetimeMs ?? DEFAULT_TOKEN_LIFETIME_MS
  const now = options.now ?? Date.now

  const startedAt = now()
  let state: 'fresh' | 'responded' | 'deferred' = 'fresh'

  function withinAckDeadline(): boolean {
    return now() - startedAt <= ackDeadlineMs
  }

  function acknowledge(body: Record<string, unknown>): Promise<LifecycleOutcome> {
    if (state !== 'fresh') {
      return Promise.resolve({ ok: false, error: 'already-acknowledged' })
    }
    if (!withinAckDeadline()) {
      return Promise.resolve({ ok: false, error: 'past-ack-deadline' })
    }
    return wire.callback(body).then((result) => {
      if (result.outcome === 'completed') {
        state = body['type'] === DISCORD_CALLBACK_DEFER ? 'deferred' : 'responded'
        return { ok: true }
      }
      if (result.outcome === 'rejected') {
        if (result.error.code === UNKNOWN_INTERACTION_CODE) {
          return { ok: false, error: 'token-expired' }
        }
        return { ok: false, error: 'wire-rejected', detail: result.error.message }
      }
      return { ok: false, error: 'wire-unknown', detail: result.reason }
    })
  }

  return {
    get state() {
      return state
    },
    respond(data) {
      return acknowledge({ type: DISCORD_CALLBACK_RESPOND, data: { flags: EPHEMERAL_FLAG, ...data } })
    },
    defer() {
      return acknowledge({ type: DISCORD_CALLBACK_DEFER, data: { flags: EPHEMERAL_FLAG } })
    },
    followUp(data) {
      if (state === 'fresh') {
        return Promise.resolve({ ok: false, error: 'not-acknowledged' })
      }
      if (now() - startedAt > tokenLifetimeMs) {
        return Promise.resolve({ ok: false, error: 'token-expired' })
      }
      return wire.followUp({ flags: EPHEMERAL_FLAG, ...data }).then((result) => {
        if (result.outcome === 'completed') return { ok: true }
        if (result.outcome === 'rejected') {
          if (result.error.code === UNKNOWN_INTERACTION_CODE) {
            return { ok: false, error: 'token-expired' }
          }
          return { ok: false, error: 'wire-rejected', detail: result.error.message }
        }
        return { ok: false, error: 'wire-unknown', detail: result.reason }
      })
    },
  }
}
