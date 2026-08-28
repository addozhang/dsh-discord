/**
 * The settings surface's slot and locale contracts this card consumes. The
 * slot entry types come from the settings domain base (`dsh-client-ui-settings`,
 * the canonical home of every settings slot type); this module adds the
 * locale namespace the Discord card's copy lives in. Importing it is what
 * merges the declarations into this program.
 */

import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.plugins': keyof DiscordPluginsLocale
  }
}

/** Copy keys the Discord card renders; every key must have a dictionary entry. */
interface DiscordPluginsLocale {
  discordTitle: string
  discordDescription: string
  discordAllowedGuildIds: string
  discordAllowedGuildIdsHint: string
  discordMemberUserIds: string
  discordMemberUserIdsHint: string
  discordMemberRoleIds: string
  discordMemberRoleIdsHint: string
  discordAdminUserIds: string
  discordAdminUserIdsHint: string
  discordAdminRoleIds: string
  discordAdminRoleIdsHint: string
  discordDeniedUserIds: string
  discordDeniedUserIdsHint: string
  discordDeniedRoleIds: string
  discordDeniedRoleIdsHint: string
  discordHostOperatorUserIds: string
  discordHostOperatorUserIdsHint: string
  discordInvalidIds: string
  reset: string
  expand: string
  collapse: string
  unsaved: string
  readOnly: string
  saveFailed: string
  discard: string
  save: string
  saving: string
  overridden: string
}
