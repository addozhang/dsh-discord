/**
 * The Discord adapter's browser half. It binds the plugin's settings
 * namespace scope on its own fiber, owns the card controller, and registers
 * the settings card into the Plugins section's tab list until unload.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { DISCORD_SETTINGS_NAMESPACE } from '../settings-namespace.js'
import type { DiscordSettings } from '../settings.js'
import { DiscordCardController } from './card-controller.js'
import { DiscordSettingsCard } from './DiscordSettingsCard.js'
import type {} from './slot-contract.js'

/** Stable Cordis plugin name for diagnostics. */
export const name = 'dsh-discord-client'

/** Client services the card needs: the settings transport and the slot registry. */
export const inject = ['settingsScope', 'slots']

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
}
