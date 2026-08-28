import type { DiscordSettings } from '../settings.js'

export interface DiscordSettingsDraft {
  enabled: boolean
  allowedGuildIds: string
  memberUserIds: string
  memberRoleIds: string
  administratorUserIds: string
  administratorRoleIds: string
  deniedUserIds: string
  deniedRoleIds: string
  hostOperatorUserIds: string
  defaultVerbosity: DiscordSettings['defaultVerbosity']
  streamUpdateIntervalMs: number
  typingIntervalMs: number
  approvalTimeoutMs: number
  questionTimeoutMs: number
}

const ID_FIELDS = [
  'allowedGuildIds',
  'memberUserIds',
  'memberRoleIds',
  'administratorUserIds',
  'administratorRoleIds',
  'deniedUserIds',
  'deniedRoleIds',
  'hostOperatorUserIds',
] as const

export function serializeIdList(value: string): string[] {
  return [...new Set(value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean))]
}

export function createSettingsDraft(
  value: Partial<DiscordSettings>,
): DiscordSettingsDraft {
  const complete: DiscordSettings = {
    enabled: value.enabled ?? false,
    allowedGuildIds: value.allowedGuildIds ?? [],
    memberUserIds: value.memberUserIds ?? [],
    memberRoleIds: value.memberRoleIds ?? [],
    administratorUserIds: value.administratorUserIds ?? [],
    administratorRoleIds: value.administratorRoleIds ?? [],
    deniedUserIds: value.deniedUserIds ?? [],
    deniedRoleIds: value.deniedRoleIds ?? [],
    hostOperatorUserIds: value.hostOperatorUserIds ?? [],
    defaultVerbosity: value.defaultVerbosity ?? 'essential-tools',
    streamUpdateIntervalMs: value.streamUpdateIntervalMs ?? 800,
    typingIntervalMs: value.typingIntervalMs ?? 7_000,
    approvalTimeoutMs: value.approvalTimeoutMs ?? 600_000,
    questionTimeoutMs: value.questionTimeoutMs ?? 1_800_000,
  }
  const draft = { ...complete } as unknown as DiscordSettingsDraft
  for (const field of ID_FIELDS) {
    draft[field] = complete[field].join('\n')
  }
  return draft
}

export function presentCredentialStatus(info: {
  configured: boolean
  writable: boolean
  source?: string
}): { label: string; writable: boolean; source?: string } {
  return {
    label: info.configured ? 'Configured' : 'Not configured',
    writable: info.writable,
    ...(info.source === undefined ? {} : { source: info.source }),
  }
}
