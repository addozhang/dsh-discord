/**
 * The adapter's earliest normalized ingress boundary. It composes dispatch
 * parsing with the explicit Guild allowlist so an event reaches business
 * logic — and therefore DSH — only after both gates pass. Every rejection is
 * a silent value drop: unconfigured Guilds, DMs, bots, and malformed frames
 * cause no DSH call and disclose nothing.
 */

import {
  parseGatewayDispatch,
  type DiscordSnowflake,
  type GatewayDispatch,
  type IngestRejectReason,
  type NormalizedInteraction,
  type NormalizedMessage,
} from './inbound.js'

export type NormalizedInboundEvent = NormalizedMessage | NormalizedInteraction

export interface IngressGateOptions {
  /** The adapter bot's own user id (self/bot filtering during normalization). */
  selfUserId: DiscordSnowflake
  /** The explicit Guild allowlist: the outer security boundary. */
  allowedGuildIds: readonly DiscordSnowflake[]
  /** Business boundary invoked only for accepted events. */
  onEvent(event: NormalizedInboundEvent): void
}

export type GateResult =
  | { accepted: true; event: NormalizedInboundEvent }
  | { accepted: false; reason: IngestRejectReason | 'unauthorized-guild' }

/**
 * One gate over the normalized ingress. The allowlist is checked before the
 * business callback ever sees the event; membership checks use the raw wire
 * allowlist (deduped once at construction).
 */
export function createIngressGate(options: IngressGateOptions): {
  accept(dispatch: GatewayDispatch): GateResult
} {
  const allowed = new Set(options.allowedGuildIds)

  function accept(dispatch: GatewayDispatch): GateResult {
    const result = parseGatewayDispatch(dispatch, options.selfUserId)
    if (!result.accepted) return result

    const event = result.event
    if (!allowed.has(event.guildId)) {
      // Unconfigured Guild: no DSH operation, no metadata disclosure.
      return { accepted: false, reason: 'unauthorized-guild' }
    }
    options.onEvent(event)
    return { accepted: true, event }
  }

  return { accept }
}
