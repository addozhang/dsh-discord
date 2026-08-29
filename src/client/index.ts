/**
 * The Discord adapter's browser half. It binds the plugin's settings
 * namespace scope on its own fiber, owns the card controller, and registers
 * the settings card into the Plugins section's tab list until unload.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import {
  DISCORD_RPC_CHANNEL,
  STATUS_ENDPOINT,
  type AdapterStatusView,
} from '../features/adapter-status.js'
import { DISCORD_SETTINGS_NAMESPACE } from '../settings-namespace.js'
import type { DiscordSettings } from '../settings.js'
import { DiscordCardController } from './card-controller.js'
import { DiscordSettingsCard } from './DiscordSettingsCard.js'
import type {} from './slot-contract.js'

/** Stable Cordis plugin name for diagnostics. */
export const name = 'dsh-discord-client'

/** Client services the card needs: settings transport, slot registry, plugin RPC channel, and locale. */
export const inject = ['settingsScope', 'slots', 'connection', 'locale']

/** The status poll cadence; the Host is the only authority on connection state. */
const STATUS_POLL_MS = 30_000

/** Accept only well-formed status views; anything else renders as "no status". */
function isStatusView(value: unknown): value is AdapterStatusView {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['token'] === 'string' && typeof candidate['connection'] === 'string'
}

interface PluginRpcFace {
  connection?: {
    rpc?: {
      call?: (channel: string, endpoint: string, payload: object, signal: AbortSignal | undefined) => Promise<unknown>
    }
  }
}

/** Mount the Discord settings card into the Plugins section. */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<DiscordSettings>({ namespace: DISCORD_SETTINGS_NAMESPACE })
  const controller = new DiscordCardController(scope)
  // Register the card's copy dictionary, then the card under the settings
  // UI's declared parent slot — a standalone slot name fails the loader's
  // children-table check at runtime.
  ;(ctx as ClientContext & {
    locale: { register(namespace: string, dictionary: Record<string, Record<string, string>>): unknown }
  }).locale.register('dsh-discord', {
    en: DISCORD_CARD_LOCALE_EN,
    zh: DISCORD_CARD_LOCALE_ZH,
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'discord',
    order: 100,
    label: 'Discord',
    locale: 'dsh-discord',
    registrant: name,
    inject: () => controller.face(),
  }, DiscordSettingsCard))
  ctx.effect(() => () => {}, 'discord settings card')

  const call = (ctx as ClientContext & PluginRpcFace).connection?.rpc?.call
  if (typeof call !== 'function') return
  const poll = (): void => {
    void call(DISCORD_RPC_CHANNEL, STATUS_ENDPOINT, {}, undefined)
      .then((answer) => {
        if (typeof answer !== 'object' || answer === null || !('ok' in answer)) return
        const envelope = answer as { ok: boolean; value?: unknown }
        controller.setStatus(envelope.ok && isStatusView(envelope.value) ? envelope.value : undefined)
      })
      .catch(() => {
        // An unreachable Host is itself the status: render nothing invented.
        controller.setStatus(undefined)
      })
  }
  poll()
  const timer = setInterval(poll, STATUS_POLL_MS)
  ctx.effect(() => () => { clearInterval(timer) }, 'discord status poll')
}

/** Card copy: every key the slot contract declares, both dictionaries. */
const DISCORD_CARD_LOCALE_EN = {
  discordTitle: 'Discord',
  discordDescription: 'Bind channels to Workspaces and authorize who may use the bot.',
  discordAllowedGuildIds: 'Allowed Guilds', discordAllowedGuildIdsHint: 'One Guild snowflake per line',
  discordMemberUserIds: 'Member Users', discordMemberUserIdsHint: 'One user snowflake per line',
  discordMemberRoleIds: 'Member Roles', discordMemberRoleIdsHint: 'One role snowflake per line',
  discordAdminUserIds: 'Administrators (Users)', discordAdminUserIdsHint: 'One user snowflake per line',
  discordAdminRoleIds: 'Administrators (Roles)', discordAdminRoleIdsHint: 'One role snowflake per line',
  discordDeniedUserIds: 'Denied Users', discordDeniedUserIdsHint: 'One user snowflake per line',
  discordDeniedRoleIds: 'Denied Roles', discordDeniedRoleIdsHint: 'One role snowflake per line',
  discordHostOperatorUserIds: 'Host Operators', discordHostOperatorUserIdsHint: 'One user snowflake per line',
  discordThreadAutoArchive: 'Task Thread Auto-archive', discordThreadAutoArchiveHint: 'Idle task threads archive automatically',
  discordInvalidIds: 'IDs must be 17–20 digit snowflakes, one per line',
  discordInvalidArchive: 'Unsupported archive duration',
  discordStatusConnected: 'Connected', discordStatusConnecting: 'Connecting…',
  discordStatusDisconnected: 'Disconnected', discordStatusInvalidToken: 'Token rejected',
  discordStatusIntentsBlocked: 'Gateway intents blocked', discordStatusPermissionsBlocked: 'Missing channel permissions',
  discordHintConfigureToken: 'Configure the bot token in credentials',
  discordHintTokenRejected: 'Discord rejected the token — update it',
  discordHintEnableIntents: 'Enable privileged intents in the Developer Portal',
  discordHintGatewayClosed: 'Gateway closed unexpectedly',
  discordHintChannelPermissions: 'The bot lacks permissions in this channel',
  reset: 'Reset', expand: 'Expand', collapse: 'Collapse', unsaved: 'Unsaved changes',
  readOnly: 'Read-only', saveFailed: 'Save failed', discard: 'Discard', save: 'Save', saving: 'Saving…',
  overridden: 'Overridden',
}

const DISCORD_CARD_LOCALE_ZH = {
  discordTitle: 'Discord',
  discordDescription: '将频道绑定到工作区，并授权可使用机器人的成员。',
  discordAllowedGuildIds: '允许的 Guild', discordAllowedGuildIdsHint: '每行一个 Guild 雪花 ID',
  discordMemberUserIds: '成员用户', discordMemberUserIdsHint: '每行一个用户雪花 ID',
  discordMemberRoleIds: '成员角色', discordMemberRoleIdsHint: '每行一个角色雪花 ID',
  discordAdminUserIds: '管理员（用户）', discordAdminUserIdsHint: '每行一个用户雪花 ID',
  discordAdminRoleIds: '管理员（角色）', discordAdminRoleIdsHint: '每行一个角色雪花 ID',
  discordDeniedUserIds: '拒绝的用户', discordDeniedUserIdsHint: '每行一个用户雪花 ID',
  discordDeniedRoleIds: '拒绝的角色', discordDeniedRoleIdsHint: '每行一个角色雪花 ID',
  discordHostOperatorUserIds: 'Host 操作员', discordHostOperatorUserIdsHint: '每行一个用户雪花 ID',
  discordThreadAutoArchive: '任务线程自动归档', discordThreadAutoArchiveHint: '闲置的任务线程到期后自动归档',
  discordInvalidIds: 'ID 必须是 17–20 位雪花数字，每行一个',
  discordInvalidArchive: '不支持的归档时长',
  discordStatusConnected: '已连接', discordStatusConnecting: '连接中…',
  discordStatusDisconnected: '未连接', discordStatusInvalidToken: 'Token 被拒绝',
  discordStatusIntentsBlocked: 'Gateway intents 被拒', discordStatusPermissionsBlocked: '缺少频道权限',
  discordHintConfigureToken: '请在凭据中配置 Bot Token',
  discordHintTokenRejected: 'Discord 拒绝了该 Token，请更新',
  discordHintEnableIntents: '请在开发者门户开启特权 intents',
  discordHintGatewayClosed: 'Gateway 连接异常关闭',
  discordHintChannelPermissions: 'Bot 在该频道缺少权限',
  reset: '重置', expand: '展开', collapse: '收起', unsaved: '有未保存修改',
  readOnly: '只读', saveFailed: '保存失败', discard: '放弃', save: '保存', saving: '保存中…',
  overridden: '已覆盖',
}
