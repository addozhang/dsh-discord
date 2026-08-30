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
import { installDiscordNavIcon } from './nav-icon.js'
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
  ctx.effect(() => installDiscordNavIcon(), 'discord nav icon shim')

  const call = (ctx as ClientContext & PluginRpcFace).connection?.rpc?.call
  if (typeof call !== 'function') return
  controller.setManagement({
    setToken: (value) => Promise.resolve(call(DISCORD_RPC_CHANNEL, 'credentials.set', { value }, undefined)).then((answer) => {
      if (typeof answer === 'object' && answer !== null && 'ok' in answer && (answer as { ok: boolean }).ok) return
      const message = typeof answer === 'object' && answer !== null && 'error' in answer
        ? ((answer as { error?: { message?: string } }).error?.message ?? 'The Host rejected the token.')
        : 'The Host rejected the token.'
      throw new TypeError(message)
    }),
    connect: () => { void call(DISCORD_RPC_CHANNEL, 'adapter.connect', {}, undefined) },
    disconnect: () => { void call(DISCORD_RPC_CHANNEL, 'adapter.disconnect', {}, undefined) },
    // Immediate feedback for connect/disconnect clicks: the handshake takes
    // a moment, so poll twice — once for the offline/starting state and once
    // after the gateway should have landed on READY or a terminal close.
    refresh: () => { setTimeout(poll, 600); setTimeout(poll, 2500) },
  })
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
  discordAllowedGuildIds: 'Allowed servers',
  discordGuildIdHelp: 'How to get it: enable Developer Mode in Discord (User Settings → Advanced), then right-click the target server and choose "Copy Server ID". One ID per line.',
  discordTokenLabel: 'Bot Token', discordTokenPlaceholder: 'Paste the bot token', discordTokenConnect: 'Connect', discordTokenConnecting: 'Connecting…',
  discordTokenHelp: 'From the Discord Developer Portal → your application → Bot → Reset Token. Stored in the Host credential service; never written to settings or logs.', discordDisconnect: 'Disconnect', discordTokenSaved: 'Saved token — leave empty to reconnect', discordTokenReconnectHint: 'The token is stored in the Host credential service. Leave empty to reconnect, or paste a new one to replace it.',
  discordThreadAutoArchive: 'Task Thread Auto-archive', discordThreadAutoArchiveHint: 'Idle task threads archive automatically',
  discordLanguage: 'Bot Language', discordLanguageHint: 'Language of bot-visible messages', discordLanguageAuto: 'Follow DSH language', discordInvalidLanguage: 'Unsupported language',
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
  discordAllowedGuildIds: '允许的服务器',
  discordGuildIdHelp: '获取方式：在 Discord 中开启开发者模式（用户设置 → 高级设置），然后右键点击目标服务器 →「复制服务器 ID」。每行填一个 ID。',
  discordTokenLabel: 'Bot Token', discordTokenPlaceholder: '粘贴 Bot Token', discordTokenConnect: '连接', discordTokenConnecting: '连接中…',
  discordTokenHelp: '来自 Discord 开发者门户 → 你的应用 → Bot → Reset Token。由 Host 凭据服务加密保存，不会写入设置或日志。', discordDisconnect: '断开连接', discordTokenSaved: '已保存的 Token — 留空直接重新连接', discordTokenReconnectHint: 'Token 已保存在 Host 凭据服务中。留空直接重连，或粘贴新 Token 进行替换。',
  discordThreadAutoArchive: '任务线程自动归档', discordThreadAutoArchiveHint: '闲置的任务线程到期后自动归档',
  discordLanguage: 'Bot 语言', discordLanguageHint: '机器人可见消息使用的语言', discordLanguageAuto: '跟随 DSH 语言', discordInvalidLanguage: '不支持的语言',
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
