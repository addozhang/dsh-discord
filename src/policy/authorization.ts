/**
 * The pure authorization evaluator. Two nested boundaries:
 *
 * 1. The Guild allowlist is the outer tenant boundary — no ownership,
 *    permission, or role ever bypasses it.
 * 2. Inside an allowed Guild, deny-user/deny-role rules beat every allow
 *    rule: member grants, configured administrator grants, Discord-native
 *    administrator authority (owner / Administrator / Manage Guild), and the
 *    global Host-operator list alike. Bots other than the adapter itself are
 *    refused outright.
 *
 * The decision ranks so callers can require a minimum level: a
 * host-operator satisfies member and workspace-administrator requirements.
 */

import type { DiscordSettings } from '../settings.js'

/** The policy slice the evaluator reads (the adapter's settings document). */
export type PolicyTable = Pick<
  DiscordSettings,
  | 'allowedGuildIds'
  | 'memberUserIds'
  | 'memberRoleIds'
  | 'administratorUserIds'
  | 'administratorRoleIds'
  | 'deniedUserIds'
  | 'deniedRoleIds'
  | 'hostOperatorUserIds'
>

/** The normalized actor facts the evaluator consumes (precomputed upstream). */
export interface AuthorizationInput {
  guildId: string
  userId: string
  /** Role ids the wire attached to the member (callers include @everyone if desired). */
  roleIds: readonly string[]
  /** Discord permission bitmask as the wire carries it (string or number). */
  memberPermissions?: string | number | undefined
  isGuildOwner?: boolean | undefined
  /** Any bot besides the adapter is unauthorized; the adapter self-filters earlier. */
  isBot?: boolean | undefined
}

/** Access levels in ascending authority order. */
export type AccessLevel = 'member' | 'workspace-administrator' | 'host-operator'

export type AccessDecision =
  | { allowed: true; level: AccessLevel }
  | { allowed: false; reason: 'guild-not-allowed' | 'bot-not-authorized' | 'denied' | 'no-grant' }

const DISCORD_ADMINISTRATOR = 1n << 3n
const DISCORD_MANAGE_GUILD = 1n << 5n

function hasPermission(permissions: string | number | undefined, flag: bigint): boolean {
  if (permissions === undefined) return false
  try {
    const mask = typeof permissions === 'string' ? BigInt(permissions) : BigInt(permissions)
    return (mask & flag) === flag
  } catch {
    return false
  }
}

/** Whether an allowed decision satisfies a required minimum level. */
export function levelAtLeast(level: AccessLevel, required: AccessLevel): boolean {
  const order: AccessLevel[] = ['member', 'workspace-administrator', 'host-operator']
  return order.indexOf(level) >= order.indexOf(required)
}

export function evaluateAuthorization(policy: PolicyTable, actor: AuthorizationInput): AccessDecision {
  // 1. Outer boundary: the explicit Guild allowlist. Nothing bypasses it.
  if (!policy.allowedGuildIds.includes(actor.guildId)) {
    return { allowed: false, reason: 'guild-not-allowed' }
  }

  // 2. Bots other than the adapter are never authorized.
  if (actor.isBot === true) {
    return { allowed: false, reason: 'bot-not-authorized' }
  }

  // 3. Deny rules take precedence over every allow rule at every level.
  if (policy.deniedUserIds.includes(actor.userId) || actor.roleIds.some(role => policy.deniedRoleIds.includes(role))) {
    return { allowed: false, reason: 'denied' }
  }

  // 4. Host-operator: the global allowlist.
  if (policy.hostOperatorUserIds.includes(actor.userId)) {
    return { allowed: true, level: 'host-operator' }
  }

  // 5. Workspace administrators: configured ids plus Discord-native authority.
  const configuredAdmin = policy.administratorUserIds.includes(actor.userId)
    || actor.roleIds.some(role => policy.administratorRoleIds.includes(role))
  const nativeAdmin = actor.isGuildOwner === true
    || hasPermission(actor.memberPermissions, DISCORD_ADMINISTRATOR)
    || hasPermission(actor.memberPermissions, DISCORD_MANAGE_GUILD)
  if (configuredAdmin || nativeAdmin) {
    return { allowed: true, level: 'workspace-administrator' }
  }

  // 6. Ordinary members: explicit user or role grants only.
  if (policy.memberUserIds.includes(actor.userId) || actor.roleIds.some(role => policy.memberRoleIds.includes(role))) {
    return { allowed: true, level: 'member' }
  }

  return { allowed: false, reason: 'no-grant' }
}
