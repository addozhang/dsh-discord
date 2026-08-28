/**
 * The card's registration-side controller. It owns the staged form over one
 * bound settings scope and exposes the inject face the slot registration
 * hands to the component: the edit actions plus the `discordCard` snapshot
 * store the framework binds as the `useDiscordCard` selector hook.
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { DiscordSettings } from '../settings.js'
import { DiscordCardForm, type DiscordCardFace, type DiscordCardState } from './card-form.js'
import type {} from './slot-contract.js'

export class DiscordCardController {
  private readonly form: DiscordCardForm

  constructor(scope: SettingsScope<DiscordSettings>) {
    this.form = new DiscordCardForm(scope)
  }

  /** Build the face the registration's inject factory returns per entry. */
  face(): DiscordCardFace {
    return {
      ...this.form.actions(),
      hooks: {
        discordCard: this.form.bind(),
      },
    }
  }
}

export type { DiscordCardFace, DiscordCardState }
