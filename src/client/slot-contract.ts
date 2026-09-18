/**
 * The settings surface's slot and locale contracts this card consumes. The
 * slot entry types come from the settings domain base (`dsh-client-ui-settings`,
 * the canonical home of every settings slot type); this module adds the
 * locale namespace the Discord card's copy lives in. Importing it is what
 * merges the declarations into this program.
 */

import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/**
 * The renderer owns the `slots` service declaration (SlotRegistry over the
 * ui-slots core); importing it merges `ctx.slots` into this program. The
 * locale service keeps its narrow structural shape here instead — the card
 * only registers one dictionary.
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

declare module '@deepseek-ai/cordis' {
  interface Context {
    locale: { register(namespace: string, dictionary: Record<string, Record<string, string>>): unknown }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-discord': keyof DiscordPluginsLocale
  }
}

/** Copy keys the Discord card renders; every key must have a dictionary entry. */
interface DiscordPluginsLocale {
  discordTitle: string
  discordDescription: string
  discordAllowedGuildIds: string
  discordGuildIdHelp: string
  discordHostOperators: string
  discordHostOperatorsHelp: string
  discordLanguageAuto: string
  discordTokenLabel: string
  discordTokenPlaceholder: string
  discordTokenConnect: string
  discordTokenConnecting: string
  discordTokenHelp: string
  discordTokenSaved: string
  discordTokenReconnectHint: string
  discordDisconnect: string
  discordThreadAutoArchive: string
  discordThreadAutoArchiveHint: string
  discordLanguage: string
  discordLanguageHint: string
  discordInvalidLanguage: string
  discordModelOperatorOnly: string
  discordModelOperatorOnlyHint: string
  discordInvalidIds: string
  discordInvalidArchive: string
  discordStatusConnected: string
  discordStatusConnecting: string
  discordStatusDisconnected: string
  discordStatusInvalidToken: string
  discordStatusIntentsBlocked: string
  discordStatusPermissionsBlocked: string
  discordHintConfigureToken: string
  discordHintTokenRejected: string
  discordHintEnableIntents: string
  discordHintGatewayClosed: string
  discordHintChannelPermissions: string
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
