/**
 * The adapter's versioned DSH storage domain. Keys compose the logical
 * ownership scopes — application, guild, then channel or thread — as
 * parseable strings, so guild-scoped reconciliation and forget derive their
 * scan space from parsed parts. The spec is declared once with
 * `defineDomain`, which fails loud at module load on any naming or version
 * misconfiguration.
 *
 * 16.106: `defineDomain`/`domainTable` are mirrored here instead of imported.
 * Shipping `@deepseek-ai/dsh-storage-domain` as a plugin dependency made pnpm
 * hoist a plugin-owned copy over the profile tree, and the host's
 * exact-version compatibility gate (0.2.1-rc.5+) then disabled that row on
 * every host patch release — cascading `storageDomain` away and pending the
 * workspace/session graph. `dsh-base` already provides the row at the host's
 * exact version, and the host's `open()` consumes a spec purely structurally
 * (property reads plus `.parse`/`.safeParse` on the caller's own zod
 * schemas), so an inlined spec is indistinguishable from a package-built one.
 * The mirror is kept honest by `test/state-domain.test.ts`, which checks it
 * against the real package (a devDependency) accept-for-accept and
 * reject-for-reject. Types still come from the package — compile-time only.
 */

import type { DomainSpec, DomainTableSpec } from '@deepseek-ai/dsh-storage-domain'
import type { ZodType } from 'zod'
import type { ChannelBinding, ThreadBinding } from './records.js'
import { ChannelBindingRecord, InboundIntentRecordSchema, ThreadBindingRecord } from './records.js'

/**
 * Storage-legal unit name, mirrored from `@deepseek-ai/dsh-storage`
 * (`UNIT_NAME_RE`): lowercase, digits, underscores, leading letter.
 */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

/**
 * Widened runtime view of a {@link DomainSpec}: the validators below police
 * untrusted shapes at module load, so they read through a deliberately loose
 * lens instead of the narrowed declared types.
 */
interface SpecLike {
  name: string
  version: number
  compatibleVersions?: readonly number[]
  layout?: string
  invalidRecords?: string
  tables: Record<string, unknown>
  global?: { schema: { safeParse(value: null): { success: boolean } } }
}

/**
 * Declare one table. Mirrored from `@deepseek-ai/dsh-storage-domain`: the
 * runtime value is the plain `{ valueSchema }` pair — the key type is a
 * compile-time phantom that never exists at runtime.
 */
export function domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V> {
  return { valueSchema: schema }
}

/**
 * Identity helper that pins a spec's literal types and validates its fields.
 * Mirrored from `@deepseek-ai/dsh-storage-domain` (0.2.1 line): misconfiguration
 * fails loud at the owning package's module load, before any medium is
 * touched — a domain or table name outside `UNIT_NAME_RE`, a version that is
 * not a non-negative integer, or a global schema that accepts `null` all
 * throw. Keep the checks and messages in sync with upstream;
 * `test/state-domain.test.ts` drift-guards the equivalence.
 */
export function defineDomain<S extends DomainSpec>(spec: S): S {
  const candidate = spec as unknown as SpecLike
  if (!UNIT_NAME_RE.test(candidate.name)) throw new Error(`domain name '${candidate.name}' must match ${String(UNIT_NAME_RE)}`)
  if (!Number.isInteger(candidate.version) || candidate.version < 0) throw new Error(`domain '${candidate.name}' version must be a non-negative integer, got ${String(candidate.version)}`)
  for (const compat of candidate.compatibleVersions ?? []) {
    if (!Number.isInteger(compat) || compat < 0 || compat >= candidate.version) {
      throw new Error(`domain '${candidate.name}' compatibleVersions entries must be non-negative integers below version ${String(candidate.version)}, got ${String(compat)}`)
    }
  }
  if (candidate.layout !== undefined) {
    const layout = candidate.layout
    if (layout !== 'single' && layout !== 'per-record') throw new Error(`domain '${candidate.name}' layout must be 'single' or 'per-record', got ${layout}`)
  }
  if (candidate.invalidRecords !== undefined) {
    const policy = candidate.invalidRecords
    if (policy !== 'backup-and-skip') throw new Error(`domain '${candidate.name}' invalidRecords must be 'backup-and-skip' when present, got ${policy}`)
  }
  for (const table of Object.keys(candidate.tables)) {
    if (!UNIT_NAME_RE.test(table)) throw new Error(`domain '${candidate.name}' table name '${table}' must match ${String(UNIT_NAME_RE)}`)
  }
  if (candidate.global !== undefined && candidate.global.schema.safeParse(null).success) {
    throw new Error(`domain '${candidate.name}' global schema must not accept null: null is the medium's "never written" sentinel, so a stored null could not round-trip`)
  }
  return spec
}

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
    [CHANNEL_BINDINGS_TABLE]: domainTable<'channel', ChannelBinding>(ChannelBindingRecord),
    [THREAD_BINDINGS_TABLE]: domainTable<'thread', ThreadBinding>(ThreadBindingRecord),
    [INTENTS_TABLE]: domainTable<'intent', InboundIntentRecordSchema>(InboundIntentRecordSchema),
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
