import { installSettingsSection } from '@deepseek-ai/dsh-settings'
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
})

const discordIdList = z.array(z.string()).default([])

export const DiscordSettingsSchema: z<DiscordSettings> = z.object({
  enabled: z.boolean().default(false),
  allowedGuildIds: discordIdList,
  memberUserIds: discordIdList,
  memberRoleIds: discordIdList,
  administratorUserIds: discordIdList,
  administratorRoleIds: discordIdList,
  deniedUserIds: discordIdList,
  deniedRoleIds: discordIdList,
  hostOperatorUserIds: discordIdList,
  defaultVerbosity: z.union(['text-only', 'essential-tools', 'full-tools'] as const)
    .default('essential-tools'),
  language: z.union(['auto', 'zh', 'en'] as const).default('auto'),
  threadAutoArchiveMinutes: z.union([60, 1440, 4320, 10080] as const)
    .default(1440),
  streamUpdateIntervalMs: z.number().step(1).min(250).max(10_000).default(800),
  typingIntervalMs: z.number().step(1).min(1_000).max(30_000).default(7_000),
  approvalTimeoutMs: z.number().step(1).min(30_000).max(86_400_000).default(600_000),
  questionTimeoutMs: z.number().step(1).min(30_000).max(86_400_000).default(1_800_000),
  modelSelectOperatorOnly: z.boolean().default(false),
})

const DISCORD_SNOWFLAKE = /^\d{17,20}$/u

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

export function installDiscordSettings(
  ctx: Context,
  entry: DiscordSettings,
  onChange: (value: DiscordSettings) => void,
): void {
  let source = (): DiscordSettings => entry
  installSettingsSection(ctx, DISCORD_SETTINGS_NAMESPACE, DiscordSettingsSchema, entry, {
    validate: value => { validateDiscordSettings(normalizeDiscordSettings(value)); },
    setSource: current => {
      source = () => normalizeDiscordSettings(current())
    },
    onChange: () => {
      onChange(source())
    },
  })
}
