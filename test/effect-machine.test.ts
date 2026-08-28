/**
 * Delivery/submission state machine tests (6.4). Both external-effect
 * families share one transition table:
 *
 *   planned → executing → succeeded | failed | unknown-needs-user-resolution
 *
 * Every other edge is invalid — effects are never marked done before they
 * start, terminal states (including the unknown one) never restart, because
 * recovery always comes from a NEW intent, not from rewriting history.
 */

import { describe, expect, it } from 'vitest'

import {
  DELIVERY_STATES,
  createStateMachine,
  isTerminal,
  canTransition,
  type EffectState,
} from '../src/state/effect-machine.js'

const machine = createStateMachine()

describe('effect state machine', () => {
  it('starts every effect as planned', () => {
    expect(machine.create()).toEqual({ state: 'planned' })
  })

  it('accepts exactly the valid edges', () => {
    const valid: Array<[EffectState, EffectState]> = [
      ['planned', 'executing'],
      ['executing', 'succeeded'],
      ['executing', 'failed'],
      ['executing', 'unknown-needs-user-resolution'],
    ]
    for (const [from, to] of valid) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true)
      const result = machine.transition({ state: from }, to)
      expect(result, `${from} -> ${to}`).toMatchObject({ ok: true, state: to })
    }
  })

  it('rejects every other edge as a value, never a throw', () => {
    for (const from of DELIVERY_STATES) {
      for (const to of DELIVERY_STATES) {
        if (canTransition(from, to)) continue
        const result = machine.transition({ state: from }, to)
        expect(result, `${from} -> ${to} must be invalid`).toEqual({
          ok: false,
          error: 'invalid-transition',
          from,
          to,
        })
      }
    }
  })

  it('marks succeeded, failed, and unknown as terminal', () => {
    for (const state of ['succeeded', 'failed', 'unknown-needs-user-resolution'] as const) {
      expect(isTerminal(state), state).toBe(true)
    }
    expect(isTerminal('planned')).toBe(false)
    expect(isTerminal('executing')).toBe(false)
  })

  it('keeps the record untouched on an invalid transition', () => {
    const record = { state: 'succeeded' } as const
    const result = machine.transition(record, 'executing')
    expect(result.ok).toBe(false)
    expect(record.state).toBe('succeeded')
  })
})
