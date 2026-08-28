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

/** Client services the card needs: settings transport, slot registry, and the plugin RPC channel. */
export const inject = ['settingsScope', 'slots', 'connection']

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
  const dispose = ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'discord',
    order: 100,
    label: 'Discord',
    locale: 'settings.plugins',
    registrant: name,
    inject: () => controller.face(),
  }, DiscordSettingsCard)
  ctx.effect(() => dispose, 'discord settings card')

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
