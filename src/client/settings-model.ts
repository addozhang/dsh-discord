import type { AdapterStatusView, ConnectionCondition, StatusHint } from '../features/adapter-status.js'
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
  language: DiscordSettings['language']
  threadAutoArchiveMinutes: DiscordSettings['threadAutoArchiveMinutes']
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
    language: value.language ?? 'zh',
    threadAutoArchiveMinutes: value.threadAutoArchiveMinutes ?? 1440,
    streamUpdateIntervalMs: value.streamUpdateIntervalMs ?? 800,
    typingIntervalMs: value.typingIntervalMs ?? 7_000,
    approvalTimeoutMs: value.approvalTimeoutMs ?? 600_000,
    questionTimeoutMs: value.questionTimeoutMs ?? 1_800_000,
    modelSelectOperatorOnly: value.modelSelectOperatorOnly ?? false,
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

/** The card status line's presentation: locale keys plus an action flag. */
export interface AdapterStatusPresentation {
  connectionKey: DiscordStatusConnectionKey
  hintKey?: DiscordStatusHintKey | undefined
  actionable: boolean
  /** Whether the credential service already holds a token. */
  tokenConfigured: boolean
}

/** Locale keys the card renders for each connection condition. */
export type DiscordStatusConnectionKey =
  | 'discordStatusConnected'
  | 'discordStatusConnecting'
  | 'discordStatusDisconnected'
  | 'discordStatusInvalidToken'
  | 'discordStatusIntentsBlocked'
  | 'discordStatusPermissionsBlocked'

/** Locale keys for each actionable hint the Host can send. */
export type DiscordStatusHintKey =
  | 'discordHintConfigureToken'
  | 'discordHintTokenRejected'
  | 'discordHintEnableIntents'
  | 'discordHintGatewayClosed'
  | 'discordHintChannelPermissions'

const CONNECTION_KEYS: Readonly<Record<ConnectionCondition, DiscordStatusConnectionKey>> = {
  connected: 'discordStatusConnected',
  connecting: 'discordStatusConnecting',
  disconnected: 'discordStatusDisconnected',
  'invalid-token': 'discordStatusInvalidToken',
  'intents-blocked': 'discordStatusIntentsBlocked',
  'permissions-blocked': 'discordStatusPermissionsBlocked',
}

const HINT_KEYS: Readonly<Record<StatusHint, DiscordStatusHintKey>> = {
  'configure-token': 'discordHintConfigureToken',
  'token-rejected': 'discordHintTokenRejected',
  'enable-intents': 'discordHintEnableIntents',
  'gateway-closed': 'discordHintGatewayClosed',
  'channel-permissions': 'discordHintChannelPermissions',
}

/**
 * Distill the Host's sanitized status view into the card's copy keys. The
 * projection never carries secrets; this mapping adds none either — only
 * stable locale keys and whether the condition demands user action.
 */
export function presentAdapterStatus(view: AdapterStatusView): AdapterStatusPresentation {
  return {
    connectionKey: CONNECTION_KEYS[view.connection],
    ...(view.hint === undefined ? {} : { hintKey: HINT_KEYS[view.hint] }),
    actionable: view.hint !== undefined,
    tokenConfigured: view.token !== 'unconfigured',
  }
}
