/**
 * The adapter's versioned DSH storage domain. Keys compose the logical
 * ownership scopes — application, guild, then channel or thread — as
 * parseable strings, so guild-scoped reconciliation and forget derive their
 * scan space from parsed parts. The spec is declared once with
 * `defineDomain`, which fails loud at module load on any naming or version
 * misconfiguration.
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ChannelBinding, ThreadBinding } from './records.js'
import { ChannelBindingRecord, ThreadBindingRecord } from './records.js'

/**
 * Storage-legal domain name (`UNIT_NAME_RE` allows only lowercase, digits,
 * and underscores) and the current format version; a medium stamped with a
 * different version rejects at open, which is exactly the fail-closed
 * behavior the adapter wants across upgrades.
 */
export const DISCORD_DOMAIN_NAME = 'dsh_discord'
export const DISCORD_DOMAIN_VERSION = 1

export const CHANNEL_BINDINGS_TABLE = 'channel_bindings'
export const THREAD_BINDINGS_TABLE = 'thread_bindings'

/** Scope of one project-channel binding. */
export interface ChannelBindingScope {
  applicationId: string
  guildId: string
  channelId: string
}

/** Scope of one session-thread binding. */
export interface ThreadBindingScope {
  applicationId: string
  guildId: string
  threadId: string
}

const ID_SEGMENT = /^[^:\s]+$/

function composeKey(parts: readonly string[]): string {
  return parts.join(':')
}

function parseSegments(key: string, family: string): string[] | undefined {
  const segments = key.split(':')
  if (segments.length !== 6) return undefined
  const [familyPrefix, applicationId, guildLiteral, guildId, leaf, leafId] = segments
  if (familyPrefix !== 'app' || guildLiteral !== 'guild') return undefined
  if (leaf !== family) return undefined
  for (const id of [applicationId, guildId, leafId]) {
    if (id === undefined || id === '' || !ID_SEGMENT.test(id)) return undefined
  }
  return segments
}

/** Build the channel-binding key for one guild channel. */
export function channelBindingKey(scope: ChannelBindingScope): string {
  return composeKey(['app', scope.applicationId, 'guild', scope.guildId, 'channel', scope.channelId])
}

/** Parse a channel-binding key; `undefined` when the key is another family. */
export function parseChannelBindingKey(key: string): ChannelBindingScope | undefined {
  const segments = parseSegments(key, 'channel')
  const applicationId = segments?.[1]
  const guildId = segments?.[3]
  const channelId = segments?.[5]
  if (applicationId === undefined || guildId === undefined || channelId === undefined) return undefined
  return { applicationId, guildId, channelId }
}

/** Build the thread-binding key for one guild thread. */
export function threadBindingKey(scope: ThreadBindingScope): string {
  return composeKey(['app', scope.applicationId, 'guild', scope.guildId, 'thread', scope.threadId])
}

/** Parse a thread-binding key; `undefined` when the key is another family. */
export function parseThreadBindingKey(key: string): ThreadBindingScope | undefined {
  const segments = parseSegments(key, 'thread')
  const applicationId = segments?.[1]
  const guildId = segments?.[3]
  const threadId = segments?.[5]
  if (applicationId === undefined || guildId === undefined || threadId === undefined) return undefined
  return { applicationId, guildId, threadId }
}

/** The domain declaration: identity, format version, and record layout. */
export const discordDomainSpec = defineDomain({
  name: DISCORD_DOMAIN_NAME,
  version: DISCORD_DOMAIN_VERSION,
  tables: {
    [CHANNEL_BINDINGS_TABLE]: domainTable<'channel', ChannelBinding>(ChannelBindingRecord),
    [THREAD_BINDINGS_TABLE]: domainTable<'thread', ThreadBinding>(ThreadBindingRecord),
  },
})

/** Minimal facility face the opener needs (the real DomainFacility matches). */
export interface DomainFacilityLike {
  open(spec: typeof discordDomainSpec): Promise<{ name: string; close(): Promise<void> }>
}

/**
 * Open the adapter's domain through the Host's domain facility. The caller
 * owns the returned handle — close it from the plugin's cancellation root so
 * shutdown drains queued writes before the unit releases.
 */
export async function openDiscordDomain(facility: DomainFacilityLike): Promise<{ name: string; close(): Promise<void> }> {
  return facility.open(discordDomainSpec)
}
