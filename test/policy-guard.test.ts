/**
 * Authorization middleware boundary tests: every Discord ingress path —
 * ordinary messages, slash commands, autocomplete, buttons, selects, and
 * modals — is authorized BEFORE any business callback (and therefore any DSH
 * access) runs. Interactions receive an explicit denial result for the
 * ephemeral reply; ordinary messages are silently ignored.
 */

import { describe, expect, it, vi } from 'vitest'

import { createAuthorizedIngress } from '../src/policy/guard.js'
import type { PolicyTable } from '../src/policy/authorization.js'

const GUILD = '333333333333333333'
const SELF = '111111111111111111'

const ALLOWING_POLICY: PolicyTable = {
  allowedGuildIds: [GUILD],
  memberUserIds: ['555555555555555555'],
  memberRoleIds: [],
  administratorUserIds: [],
  administratorRoleIds: [],
  deniedUserIds: [],
  deniedRoleIds: [],
  hostOperatorUserIds: ['777777777777777777'],
}

const DENYING_MEMBER_POLICY: PolicyTable = {
  ...ALLOWING_POLICY,
  deniedUserIds: ['555555555555555555'],
}

function message(content = 'hello'): { t: string; d: Record<string, unknown> } {
  return {
    t: 'MESSAGE_CREATE',
    d: {
      id: '222222222222222222',
      guild_id: GUILD,
      channel_id: '444444444444444444',
      author: { id: '555555555555555555', bot: false },
      member: { roles: ['MR1'] },
      content,
    },
  }
}

function interaction(type: number): { t: string; d: Record<string, unknown> } {
  return {
    t: 'INTERACTION_CREATE',
    d: {
      id: '888888888888888888',
      guild_id: GUILD,
      channel_id: '444444444444444444',
      type,
      data: { name: 'project' },
      member: { user: { id: '555555555555555555' }, roles: ['MR1'], permissions: '0' },
    },
  }
}

function setup(policy: PolicyTable = ALLOWING_POLICY) {
  const onEvent = vi.fn()
  const ingress = createAuthorizedIngress({
    selfUserId: SELF,
    policy: () => policy,
    onEvent,
  })
  return { ingress, onEvent }
}

describe('authorized ingress boundary', () => {
  it('passes an authorized member message to the business boundary', () => {
    const { ingress, onEvent } = setup()
    const result = ingress.accept(message())
    expect(result.accepted).toBe(true)
    expect(onEvent).toHaveBeenCalledTimes(1)
    const [event, decision] = onEvent.mock.calls[0] as unknown[]
    expect(decision).toEqual({ allowed: true, level: 'member' })
    expect(event).toMatchObject({ kind: 'message' })
  })

  it('silently drops an ordinary message from a member without a grant', () => {
    const { ingress, onEvent } = setup()
    const stranger = message()
    ;(stranger.d['author'] as Record<string, unknown>)['id'] = '999999999999999991'
    const result = ingress.accept(stranger)
    expect(result.accepted).toBe(false)
    if (!result.accepted) expect(result.reason).toBe('no-grant')
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('reports an interaction denial result for the ephemeral reply path', () => {
    const { ingress, onEvent } = setup()
    const strangerCommand = interaction(2)
    ;((strangerCommand.d['member'] as Record<string, unknown>)['user'] as Record<string, unknown>)['id'] = '999999999999999991'
    const result = ingress.accept(strangerCommand)
    expect(result.accepted).toBe(false)
    if (!result.accepted) {
      expect(result.reason).toBe('no-grant')
      expect(result.response).toBe('ephemeral-denial')
    }
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('authorizes messages silently and interactions explicitly by kind', () => {
    const { ingress, onEvent } = setup()
    expect(ingress.accept(message()).accepted).toBe(true)
    for (const type of [2, 3, 4, 5]) {
      const result = ingress.accept(interaction(type))
      expect(result.accepted, `interaction type ${String(type)}`).toBe(true)
    }
    expect(onEvent).toHaveBeenCalledTimes(5)
  })

  it('rejects slash commands, buttons, selects, and modals from non-members', () => {
    const { ingress, onEvent } = setup()
    for (const type of [2, 3, 4, 5]) {
      const payload = interaction(type)
      ;((payload.d['member'] as Record<string, unknown>)['user'] as Record<string, unknown>)['id'] = '999999999999999991'
      const result = ingress.accept(payload)
      expect(result.accepted, `interaction type ${String(type)}`).toBe(false)
    }
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('deny rules beat configured grants at every path', () => {
    const { ingress, onEvent } = setup(DENYING_MEMBER_POLICY)
    expect(ingress.accept(message()).accepted).toBe(false)
    expect(ingress.accept(interaction(2)).accepted).toBe(false)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('the guild allowlist still gates before authorization', () => {
    const { ingress, onEvent } = setup()
    const foreign = message()
    foreign.d['guild_id'] = '999999999999999998'
    const result = ingress.accept(foreign)
    expect(result.accepted).toBe(false)
    if (!result.accepted) expect(result.reason).toBe('guild-not-allowed')
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('hands the ranked decision to the business boundary', () => {
    const { ingress, onEvent } = setup()
    const operatorCommand = interaction(2)
    ;((operatorCommand.d['member'] as Record<string, unknown>)['user'] as Record<string, unknown>)['id'] = '777777777777777777'
    ingress.accept(operatorCommand)
    const [, decision] = onEvent.mock.calls[0] as unknown[]
    expect(decision).toEqual({ allowed: true, level: 'host-operator' })
  })
})
