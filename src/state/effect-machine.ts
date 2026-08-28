/**
 * The external-effect state machine shared by Discord deliveries and DSH
 * submissions (design.md §10):
 *
 *   planned → executing → succeeded
 *                       → failed
 *                       → unknown-needs-user-resolution
 *
 * Effects must be marked executing before they can finish, and every
 * terminal state — including the unknown one — is final: recovery always
 * issues a NEW intent instead of rewriting a settled record. All decisions
 * are pure values; callers decide how to persist the record.
 */

/** The five effect states, in authority order. */
export const DELIVERY_STATES = [
  'planned',
  'executing',
  'succeeded',
  'failed',
  'unknown-needs-user-resolution',
] as const

export type EffectState = (typeof DELIVERY_STATES)[number]

const TERMINAL: ReadonlySet<EffectState> = new Set([
  'succeeded',
  'failed',
  'unknown-needs-user-resolution',
])

const VALID_EDGES: ReadonlyMap<EffectState, readonly EffectState[]> = new Map([
  ['planned', ['executing']],
  ['executing', ['succeeded', 'failed', 'unknown-needs-user-resolution']],
  ['succeeded', []],
  ['failed', []],
  ['unknown-needs-user-resolution', []],
])

/** Whether the edge `from → to` exists in the transition table. */
export function canTransition(from: EffectState, to: EffectState): boolean {
  return VALID_EDGES.get(from)?.includes(to) === true
}

/** Terminal states can never transition again; recovery means a new intent. */
export function isTerminal(state: EffectState): boolean {
  return TERMINAL.has(state)
}

export interface EffectRecord {
  state: EffectState
}

export type TransitionResult =
  | { ok: true; state: EffectState }
  | { ok: false; error: 'invalid-transition'; from: EffectState; to: EffectState }

export interface EffectMachine {
  create(): EffectRecord
  transition(record: EffectRecord, to: EffectState): TransitionResult
}

export function createStateMachine(): EffectMachine {
  return {
    create: () => ({ state: 'planned' }),
    transition(record, to) {
      if (!canTransition(record.state, to)) {
        return { ok: false, error: 'invalid-transition', from: record.state, to }
      }
      return { ok: true, state: to }
    },
  }
}
