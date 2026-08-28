/**
 * The adapter's earliest normalized ingress boundary: dispatch parsing plus
 * non-guild (DM) rejection. Guild allowlisting and member authorization live
 * one layer up in `createAuthorizedIngress` (policy/guard.ts), the single
 * production gate — the former standalone allowlist gate was removed as
 * redundant (review N8).
 */

import {
  parseGatewayDispatch,
  type DiscordSnowflake,
  type GatewayDispatch,
  type IngestResult,
  type NormalizedInteraction,
  type NormalizedMessage,
} from './inbound.js'

export type NormalizedInboundEvent = NormalizedMessage | NormalizedInteraction

export { parseGatewayDispatch } from './inbound.js'

/**
 * Validate and normalize one dispatch, rejecting non-guild (DM) events at
 * the earliest boundary. Pure: no allowlist, no delivery.
 */
export function normalizeInbound(dispatch: GatewayDispatch, selfUserId: DiscordSnowflake): IngestResult {
  const result = parseGatewayDispatch(dispatch, selfUserId)
  if (!result.accepted) return result
  if (result.event.kind === 'message' && typeof result.event.guildId !== 'string') {
    return { accepted: false, reason: 'non-guild-event' }
  }
  return result
}
