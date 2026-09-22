import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'

import { DISCORD_SETTINGS_NAMESPACE } from './settings-namespace.js'

export { DISCORD_SETTINGS_NAMESPACE } from './settings-namespace.js'

export type DiscordVerbosity = 'text-only' | 'essential-tools' | 'full-tools'
/** Card language preference: follow the DSH locale, or pin Chinese/English. */
export type Language = 'auto' | 'zh' | 'en'

export interface DiscordSettings {
  enabled: boolean
  allowedGuildIds: string[]
  memberUserIds: string[]
  memberRoleIds: string[]
  administratorUserIds: string[]
  administratorRoleIds: string[]
  deniedUserIds: string[]
  deniedRoleIds: string[]
  hostOperatorUserIds: string[]
  defaultVerbosity: DiscordVerbosity
  /** Discord-visible copy language for adapter messages (16.25). */
  language: Language
  streamUpdateIntervalMs: number
  typingIntervalMs: number
  approvalTimeoutMs: number
  questionTimeoutMs: number
  /** Task-thread auto-archive; Discord supports exactly these four values. */
  threadAutoArchiveMinutes: ThreadAutoArchiveMinutes
  /**
   * Restrict /model select to the explicit Host-operator allowlist (the
   * switch reaches the Host-wide default). Defaults to false — single-user
   * deployments let any authorized member switch (16.42); set true to
   * re-tighten to the operator allowlist.
   */
  modelSelectOperatorOnly: boolean
  /**
   * Restrict /permission set to the explicit Host-operator allowlist.
   * Defaults to true — stricter than /model because the danger-full-access
   * preset disables BOTH sandbox and approval (16.60); single-user
   * deployments may loosen it so any authorized member can switch, mirroring
   * the loosened /model select vocabulary.
   */
  permissionSelectOperatorOnly: boolean
}

/** The archive durations Discord's API accepts (minutes). */
export type ThreadAutoArchiveMinutes = 60 | 1440 | 4320 | 10080
export const THREAD_AUTO_ARCHIVE_OPTIONS: readonly ThreadAutoArchiveMinutes[] = [60, 1440, 4320, 10080]

export const DEFAULT_DISCORD_SETTINGS: DiscordSettings = Object.freeze({
  enabled: false,
  allowedGuildIds: [],
  memberUserIds: [],
  memberRoleIds: [],
  administratorUserIds: [],
  administratorRoleIds: [],
  deniedUserIds: [],
  deniedRoleIds: [],
  hostOperatorUserIds: [],
  defaultVerbosity: 'essential-tools',
  language: 'auto',
  streamUpdateIntervalMs: 800,
  typingIntervalMs: 7_000,
  approvalTimeoutMs: 10 * 60_000,
  questionTimeoutMs: 30 * 60_000,
  threadAutoArchiveMinutes: 1440,
  modelSelectOperatorOnly: false,
  permissionSelectOperatorOnly: true,
})

/**
 * Every field is volatile (0.1.7 profile-backed forms): values live-update
 * through stable per-field references without remounting the plugin fiber —
 * the exact semantics the 0.1.6 `installSection` registration provided.
 * Snowflake patterns ride the schema so the Host rejects malformed IDs at
 * write time (parity with the retired validate hook).
 */
const DISCORD_SNOWFLAKE = /^\d{17,20}$/u

const discordIdList = z.array(z.string().pattern(DISCORD_SNOWFLAKE)).default([]).volatile()

export const DiscordSettingsSchema = z.object({
  enabled: z.boolean().default(false).volatile(),
  allowedGuildIds: discordIdList,
  memberUserIds: discordIdList,
  memberRoleIds: discordIdList,
  administratorUserIds: discordIdList,
  administratorRoleIds: discordIdList,
  deniedUserIds: discordIdList,
  deniedRoleIds: discordIdList,
  hostOperatorUserIds: discordIdList,
  defaultVerbosity: z.union(['text-only', 'essential-tools', 'full-tools'] as const)
    .default('essential-tools').volatile(),
  language: z.union(['auto', 'zh', 'en'] as const).default('auto').volatile(),
  threadAutoArchiveMinutes: z.union([60, 1440, 4320, 10080] as const)
    .default(1440).volatile(),
  streamUpdateIntervalMs: z.number().step(1).min(250).max(10_000).default(800).volatile(),
  typingIntervalMs: z.number().step(1).min(1_000).max(30_000).default(7_000).volatile(),
  approvalTimeoutMs: z.number().step(1).min(30_000).max(86_400_000).default(600_000).volatile(),
  questionTimeoutMs: z.number().step(1).min(30_000).max(86_400_000).default(1_800_000).volatile(),
  modelSelectOperatorOnly: z.boolean().default(false).volatile(),
  permissionSelectOperatorOnly: z.boolean().default(true).volatile(),
})

const ID_FIELDS = [
  'allowedGuildIds',
  'memberUserIds',
  'memberRoleIds',
  'administratorUserIds',
  'administratorRoleIds',
  'deniedUserIds',
  'deniedRoleIds',
  'hostOperatorUserIds',
] as const satisfies readonly (keyof DiscordSettings)[]

function normalizeIds(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()))]
}

export function normalizeDiscordSettings(input: DiscordSettings): DiscordSettings {
  const result: DiscordSettings = { ...input }
  for (const field of ID_FIELDS) {
    result[field] = normalizeIds(input[field])
  }
  return result
}

export function validateDiscordSettings(input: DiscordSettings): void {
  for (const field of ID_FIELDS) {
    if (input[field].some(value => !DISCORD_SNOWFLAKE.test(value.trim()))) {
      throw new TypeError(`${field} must contain Discord snowflake IDs`)
    }
  }
  if (!Number.isSafeInteger(input.streamUpdateIntervalMs)
    || input.streamUpdateIntervalMs < 250
    || input.streamUpdateIntervalMs > 10_000) {
    throw new TypeError('streamUpdateIntervalMs must be between 250 and 10000')
  }
  if (!Number.isSafeInteger(input.typingIntervalMs)
    || input.typingIntervalMs < 1_000
    || input.typingIntervalMs > 30_000) {
    throw new TypeError('typingIntervalMs must be between 1000 and 30000')
  }
  for (const field of ['approvalTimeoutMs', 'questionTimeoutMs'] as const) {
    if (!Number.isSafeInteger(input[field]) || input[field] < 30_000 || input[field] > 86_400_000) {
      throw new TypeError(`${field} must be between 30000 and 86400000`)
    }
  }
  if (!THREAD_AUTO_ARCHIVE_OPTIONS.includes(input.threadAutoArchiveMinutes)) {
    throw new TypeError('threadAutoArchiveMinutes must be one of 60, 1440, 4320, 10080')
  }
}

export interface DiscordSettingsSource {
  get(): DiscordSettings
}

/**
 * The 0.1.7 stable config reference: a per-field handle whose `.get()`
 * returns the latest immutable snapshot (probe-verified on 0.1.7-alpha.1 —
 * the reference held since mount flips values without any remount).
 */
interface VolatileField {
  get(): unknown
}

function isVolatileField(value: unknown): value is VolatileField {
  return typeof value === 'object' && value !== null
    && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * Bind the plugin's volatile Config fields into a whole-settings snapshot
 * source. Fields arrive as stable references on the 0.1.7 host; plain values
 * (tests, bare contexts) pass through unchanged. Change notification rides
 * the Host's `settings/document-updated` event, filtered to this adapter's
 * namespace — the entry id equals `DISCORD_SETTINGS_NAMESPACE`, which the
 * cordis patch row fixes.
 */
/**
 * The Host emits `settings/document-updated` (namespace, revision) on every
 * forms revision bump; the event rides no published type declaration, so
 * this face pins the slice we consume.
 */
interface DocumentUpdatedFace {
  on(event: 'settings/document-updated', listener: (ns: unknown, revision: number) => void): () => void
}

export function bindDiscordSettings(
  ctx: Context,
  config: Readonly<Record<string, unknown>>,
  onChange: (value: DiscordSettings) => void,
): DiscordSettingsSource {
  const read = (): DiscordSettings => {
    const raw = {} as Record<string, unknown>
    for (const key of Object.keys(DEFAULT_DISCORD_SETTINGS)) {
      const field = config[key]
      raw[key] = isVolatileField(field) ? field.get() : field
    }
    return normalizeDiscordSettings(raw as unknown as DiscordSettings)
  }
  ;(ctx as unknown as DocumentUpdatedFace).on('settings/document-updated', (ns: unknown) => {
    if (ns === DISCORD_SETTINGS_NAMESPACE) onChange(read())
  })
  return { get: read }
}
