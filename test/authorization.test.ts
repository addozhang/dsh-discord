/**
 * The pure authorization decision table. Outer boundary: the Guild allowlist,
 * which no ownership, permission, or role can bypass. Inner boundary:
 * deny-first precedence over member, Workspace-administrator (configured or
 * Discord-native), and Host-operator grants. Bots other than the adapter are
 * never authorized. Decisions rank so higher levels satisfy lower ones.
 */

import { describe, expect, it } from 'vitest'

import {
  evaluateAuthorization,
  levelAtLeast,
  type AccessDecision,
  type AuthorizationInput,
  type PolicyTable,
} from '../src/policy/authorization.js'

const GUILD = '333333333333333333'
const OTHER_GUILD = '999999999999999999'

const policy: PolicyTable = {
  allowedGuildIds: [GUILD],
  memberUserIds: ['MU1'],
  memberRoleIds: ['MR1'],
  administratorUserIds: ['AU1'],
  administratorRoleIds: ['AR1'],
  deniedUserIds: ['DU1'],
  deniedRoleIds: ['DR1'],
  hostOperatorUserIds: ['HO1'],
}

function input(overrides: Partial<AuthorizationInput> = {}): AuthorizationInput {
  return {
    guildId: GUILD,
    userId: 'nobody',
    roleIds: [],
    ...overrides,
  }
}

/** Compact expectations for the decision table. */
function expectDecision(decision: AccessDecision, expected: AccessDecision): void {
  expect(decision).toEqual(expected)
}

const member = { allowed: true, level: 'member' } as const
const admin = { allowed: true, level: 'workspace-administrator' } as const
const operator = { allowed: true, level: 'host-operator' } as const

describe('authorization decision table', () => {
  const table: { name: string; input: AuthorizationInput; expect: AccessDecision }[] = [
    // ── outer boundary: the Guild allowlist ─────────────────────────────
    {
      name: 'guild absent from the allowlist denies an allowed member',
      input: input({ guildId: OTHER_GUILD, userId: 'MU1' }),
      expect: { allowed: false, reason: 'guild-not-allowed' },
    },
    {
      name: 'guild ownership does not bypass the allowlist',
      input: input({ guildId: OTHER_GUILD, userId: 'x', isGuildOwner: true, memberPermissions: '8' }),
      expect: { allowed: false, reason: 'guild-not-allowed' },
    },
    {
      name: 'an allowed role does not bypass the allowlist',
      input: input({ guildId: OTHER_GUILD, roleIds: [GUILD, 'MR1'] }),
      expect: { allowed: false, reason: 'guild-not-allowed' },
    },

    // ── bots are never authorized ───────────────────────────────────────
    {
      name: 'an unauthorized bot member is denied inside an allowed guild',
      input: input({ userId: 'MU1', isBot: true }),
      expect: { allowed: false, reason: 'bot-not-authorized' },
    },
    {
      name: 'a bot with deny-rule absence still gets no grant via owner flag',
      input: input({ userId: 'other-bot', isBot: true, isGuildOwner: true }),
      expect: { allowed: false, reason: 'bot-not-authorized' },
    },

    // ── deny precedence beats every allow rule ──────────────────────────
    {
      name: 'deny-user beats a member allow',
      input: input({ userId: 'DU1' }),
      expect: { allowed: false, reason: 'denied' },
    },
    {
      name: 'deny-user beats a configured administrator user allow',
      input: input({ userId: 'DU1', roleIds: ['AR1'] }),
      expect: { allowed: false, reason: 'denied' },
    },
    {
      name: 'deny-user beats Discord-native administrator permission',
      input: input({ userId: 'DU1', memberPermissions: '8' }),
      expect: { allowed: false, reason: 'denied' },
    },
    {
      name: 'deny-user beats guild ownership',
      input: input({ userId: 'DU1', isGuildOwner: true }),
      expect: { allowed: false, reason: 'denied' },
    },
    {
      name: 'deny-user beats a host-operator allow',
      input: input({ userId: 'DU1' }),
      expect: { allowed: false, reason: 'denied' },
    },
    {
      name: 'deny-role beats a member role allow',
      input: input({ userId: 'MU1', roleIds: ['DR1', 'MR1'] }),
      expect: { allowed: false, reason: 'denied' },
    },
    {
      name: 'deny-role beats a host-operator user allow',
      input: input({ userId: 'HO1', roleIds: ['DR1'] }),
      expect: { allowed: false, reason: 'denied' },
    },

    // ── host operator ────────────────────────────────────────────────────
    {
      name: 'host-operator user id ranks host-operator',
      input: input({ userId: 'HO1' }),
      expect: operator,
    },

    // ── workspace administrators ─────────────────────────────────────────
    {
      name: 'configured administrator user ranks workspace-administrator',
      input: input({ userId: 'AU1' }),
      expect: admin,
    },
    {
      name: 'configured administrator role ranks workspace-administrator',
      input: input({ roleIds: ['AR1'] }),
      expect: admin,
    },
    {
      name: 'guild owner ranks workspace-administrator',
      input: input({ isGuildOwner: true }),
      expect: admin,
    },
    {
      name: 'Discord Administrator permission ranks workspace-administrator',
      input: input({ memberPermissions: '8' }),
      expect: admin,
    },
    {
      name: 'Discord Manage Guild permission ranks workspace-administrator',
      input: input({ memberPermissions: '32' }),
      expect: admin,
    },

    // ── members ───────────────────────────────────────────────────────────
    {
      name: 'allowed member user ranks member',
      input: input({ userId: 'MU1' }),
      expect: member,
    },
    {
      name: 'allowed member role ranks member',
      input: input({ roleIds: ['MR1'] }),
      expect: member,
    },

    // ── no grant ──────────────────────────────────────────────────────────
    {
      name: 'a member matching no rule receives no grant',
      input: input({ userId: 'stranger' }),
      expect: { allowed: false, reason: 'no-grant' },
    },
    {
      name: 'denied but absent IDs in policy never match',
      input: input({ userId: 'MU1', roleIds: ['unrelated'] }),
      expect: member,
    },
  ]

  for (const row of table) {
    it(row.name, () => {
      expectDecision(evaluateAuthorization(policy, row.input), row.expect)
    })
  }
})

describe('level ranking', () => {
  it('satisfies requirements from the top down', () => {
    expect(levelAtLeast('host-operator', 'member')).toBe(true)
    expect(levelAtLeast('host-operator', 'workspace-administrator')).toBe(true)
    expect(levelAtLeast('workspace-administrator', 'member')).toBe(true)
    expect(levelAtLeast('workspace-administrator', 'host-operator')).toBe(false)
    expect(levelAtLeast('member', 'workspace-administrator')).toBe(false)
  })
})
