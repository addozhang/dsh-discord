/**
 * The adapter's versioned DSH storage domain. Keys compose the logical
 * ownership scopes — application, guild, then channel or thread — as
 * parseable strings, so guild-scoped reconciliation and forget derive their
 * scan space from parsed parts. The spec is declared once with
 * `defineDomain`, which fails loud at module load on any naming or version
 * misconfiguration.
 */

import type { ZodType } from 'zod'
import type { ChannelBinding, ThreadBinding } from './records.js'
import { ChannelBindingRecord, InboundIntentRecordSchema, ThreadBindingRecord } from './records.js'

/**
 * Storage-legal domain name (`UNIT_NAME_RE` allows only lowercase, digits,
 * and underscores) and the current format version; a medium stamped with a
 * different version rejects at open, which is exactly the fail-closed
 * behavior the adapter wants across upgrades.
 */
export const DISCORD_DOMAIN_NAME = 'dsh_discord'
export const DISCORD_DOMAIN_VERSION = 1

/**
 * The two spec helpers, inlined from @deepseek-ai/dsh-storage-domain
 * (dependency-decoupling, 2026-10-25): the packages' runtime surface for
 * us was exactly these two functions, while every real behavior —
 * storage, validation at open — lives in the HOST's storageDomain
 * service, reached via inject. Inlining keeps the adapter free of the
 * version matrix the host's exact-version gate polices; a spec-shape
 * drift in a future host fails loud at open(), the same fail-closed
 * boundary as before (lib was byte-identical across 0.2.1-rc.2/rc.3).
 */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

function domainTable<V>(schema: ZodType<V>) {
  return { valueSchema: schema }
}

function defineDomain<S extends { name: string; version: number; tables: Record<string, unknown> }>(spec: S): S {
  if (!UNIT_NAME_RE.test(spec.name)) throw new Error(`domain name '${spec.name}' must match ${String(UNIT_NAME_RE)}`)
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new Error(`domain '${spec.name}' version must be a non-negative integer, got ${String(spec.version)}`)
  }
  for (const table of Object.keys(spec.tables)) {
    if (!UNIT_NAME_RE.test(table)) throw new Error(`domain '${spec.name}' table name '${table}' must match ${String(UNIT_NAME_RE)}`)
  }
  return spec
}

export const CHANNEL_BINDINGS_TABLE = 'channel_bindings'
export const THREAD_BINDINGS_TABLE = 'thread_bindings'
export const INTENTS_TABLE = 'inbound_intents'

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
    [CHANNEL_BINDINGS_TABLE]: domainTable<ChannelBinding>(ChannelBindingRecord),
    [THREAD_BINDINGS_TABLE]: domainTable<ThreadBinding>(ThreadBindingRecord),
    [INTENTS_TABLE]: domainTable<InboundIntentRecordSchema>(InboundIntentRecordSchema),
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
