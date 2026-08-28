/**
 * The earliest normalized ingress boundary: Discord events reach business
 * logic (and therefore DSH) only after passing normalization and the Guild
 * allowlist. DMs, unconfigured Guilds, bot-authored messages, and malformed
 * payloads are dropped before any business callback can run. These tests
 * exercise the single production gate, `createAuthorizedIngress` — the
 * standalone allowlist gate was removed as redundant (review N8).
 */

import { describe, expect, it, vi } from 'vitest'

import { createAuthorizedIngress } from '../src/policy/guard.js'
import type { PolicyTable } from '../src/policy/authorization.js'

const SELF_USER_ID = '111111111111111111'
const ALLOWED_GUILD = '333333333333333333'
const FOREIGN_GUILD = '999999999999999999'
const MEMBER_ID = '555555555555555555'

function message(guildId: string | undefined, overrides: Record<string, unknown> = {}) {
  return {
    t: 'MESSAGE_CREATE',
    d: {
      id: '222222222222222222',
      guild_id: guildId,
      channel_id: '444444444444444444',
      author: { id: MEMBER_ID, bot: false },
      content: 'hello',
      ...overrides,
    },
  }
}

function interaction(guildId: string | undefined) {
  return {
    t: 'INTERACTION_CREATE',
    d: {
      id: '777777777777777777',
      guild_id: guildId,
      channel_id: '444444444444444444',
      type: 2,
      data: { name: 'project' },
      member: { user: { id: MEMBER_ID } },
    },
  }
}

function createGate() {
  const onEvent = vi.fn()
  const gate = createAuthorizedIngress({
    selfUserId: SELF_USER_ID,
    policy: (): PolicyTable => ({
      allowedGuildIds: [ALLOWED_GUILD],
      memberUserIds: [MEMBER_ID],
      memberRoleIds: [],
      administratorUserIds: [],
      administratorRoleIds: [],
      deniedUserIds: [],
      deniedRoleIds: [],
      hostOperatorUserIds: [],
    }),
    onEvent,
  })
  return { gate, onEvent }
}

describe('ingress gate (single production gate)', () => {
  it('delivers allowed-guild events to the business boundary', () => {
    const { gate, onEvent } = createGate()
    expect(gate.accept(message(ALLOWED_GUILD)).accepted).toBe(true)
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(gate.accept(interaction(ALLOWED_GUILD)).accepted).toBe(true)
    expect(onEvent).toHaveBeenCalledTimes(2)
  })

  it('silently drops messages from unconfigured Guilds with no DSH effect', () => {
    const { gate, onEvent } = createGate()
    const result = gate.accept(message(FOREIGN_GUILD))
    expect(result.accepted).toBe(false)
    if (!result.accepted) {
      expect(result.reason).toBe('guild-not-allowed')
      expect(result.response).toBe('silent')
    }
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('silently drops interactions from unconfigured Guilds', () => {
    const { gate, onEvent } = createGate()
    const result = gate.accept(interaction(FOREIGN_GUILD))
    expect(result.accepted).toBe(false)
    if (!result.accepted) expect(result.reason).toBe('guild-not-allowed')
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('drops direct messages before any business logic runs', () => {
    const { gate, onEvent } = createGate()
    for (const payload of [
      message(undefined),
      interaction(undefined),
      { t: 'MESSAGE_CREATE', d: { id: '222222222222222222', channel_id: '444444444444444444', author: { id: MEMBER_ID }, content: 'dm' } },
    ]) {
      const result = gate.accept(payload as never)
      expect(result.accepted).toBe(false)
    }
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('drops bot-authored and malformed events without invoking business logic', () => {
    const { gate, onEvent } = createGate()
    expect(gate.accept(message(ALLOWED_GUILD, { author: { id: SELF_USER_ID, bot: true } })).accepted).toBe(false)
    expect(gate.accept({ t: 'TYPING_START', d: {} } as never).accepted).toBe(false)
    expect(gate.accept({ t: 'MESSAGE_CREATE', d: 'garbage' } as never).accepted).toBe(false)
    expect(onEvent).not.toHaveBeenCalled()
  })
})
