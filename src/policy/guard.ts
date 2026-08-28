/**
 * The authorization middleware installed at the single normalized ingress
 * boundary. Every event kind — messages, slash commands, autocomplete,
 * buttons, selects, and modals — flows through this one gate, so no DSH
 * access can precede authorization by construction: the business callback
 * only fires with a positive, ranked decision attached. Ordinary messages
 * deny silently; interactions deny with an explicit result the transport
 * layer turns into an ephemeral reply.
 */

import { evaluateAuthorization, type AccessDecision, type PolicyTable } from './authorization.js'
import { normalizeInbound, type NormalizedInboundEvent } from '../gateway/ingress.js'
import type { DiscordSnowflake, GatewayDispatch } from '../gateway/inbound.js'

export interface AuthorizedIngressOptions {
  selfUserId: DiscordSnowflake
  /** Live policy reader so settings updates apply without re-installing. */
  policy: () => PolicyTable
  /** The business boundary; only invoked with a positive decision. */
  onEvent(event: NormalizedInboundEvent, decision: AccessDecision): void
}

export type AuthorizedGateResult =
  | { accepted: true; event: NormalizedInboundEvent; decision: AccessDecision }
  | { accepted: false; reason: string; response: 'silent' | 'ephemeral-denial' }

export function createAuthorizedIngress(options: AuthorizedIngressOptions): {
  accept(dispatch: GatewayDispatch): AuthorizedGateResult
} {
  const policyAt = (): PolicyTable => options.policy()

  function accept(dispatch: GatewayDispatch): AuthorizedGateResult {
    // 1. Normalization: malformed frames, DMs, bots, self-messages die here.
    const result = normalizeInbound(dispatch, options.selfUserId)
    if (!result.accepted) {
      return { accepted: false, reason: result.reason, response: 'silent' }
    }

    // 2. Outer boundary: the Guild allowlist.
    const event = result.event
    if (!policyAt().allowedGuildIds.includes(event.guildId)) {
      return { accepted: false, reason: 'guild-not-allowed', response: 'silent' }
    }

    // 3. Inner boundary: deny-first member/administrator/operator evaluation.
    const isMessage = event.kind === 'message'
    const decision = evaluateAuthorization(policyAt(), {
      guildId: event.guildId,
      userId: isMessage ? event.authorId : event.actorId,
      roleIds: event.roleIds,
      ...(isMessage ? {} : { memberPermissions: event.memberPermissions, isBot: event.isBot }),
    })

    if (!decision.allowed) {
      return {
        accepted: false,
        reason: decision.reason,
        // Interactions must answer (ephemeral denial); messages ignore.
        response: isMessage ? 'silent' : 'ephemeral-denial',
      }
    }

    options.onEvent(event, decision)
    return { accepted: true, event, decision }
  }

  return { accept }
}
