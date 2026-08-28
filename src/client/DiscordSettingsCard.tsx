/** The Discord adapter's plugin settings card: authorization lists and output behavior. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.js'
import { PluginCard, type PluginCardCopy } from './PluginCard.js'
import type { DiscordCardFace } from './card-controller.js'
import type {} from './slot-contract.js'

/** Props the runtime binds for the Discord settings card. */
export type DiscordSettingsCardProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<DiscordCardFace>

const ID_FIELDS = [
  ['allowedGuildIds', 'discordAllowedGuildIds', 'discordAllowedGuildIdsHint'],
  ['memberUserIds', 'discordMemberUserIds', 'discordMemberUserIdsHint'],
  ['memberRoleIds', 'discordMemberRoleIds', 'discordMemberRoleIdsHint'],
  ['administratorUserIds', 'discordAdminUserIds', 'discordAdminUserIdsHint'],
  ['administratorRoleIds', 'discordAdminRoleIds', 'discordAdminRoleIdsHint'],
  ['deniedUserIds', 'discordDeniedUserIds', 'discordDeniedUserIdsHint'],
  ['deniedRoleIds', 'discordDeniedRoleIds', 'discordDeniedRoleIdsHint'],
  ['hostOperatorUserIds', 'discordHostOperatorUserIds', 'discordHostOperatorUserIdsHint'],
] as const

/**
 * Render the Discord adapter card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card, or nothing while the namespace is unavailable.
 */
export function DiscordSettingsCard(props: DiscordSettingsCardProps) {
  const { t } = props
  const state = props.useDiscordCard(snapshot => snapshot)
  if (!state.available) return null
  const copy: PluginCardCopy = {
    expand: t('expand'),
    collapse: t('collapse'),
    unsaved: t('unsaved'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    discard: t('discard'),
    save: t('save'),
    saving: t('saving'),
  }
  const disabled = !state.writable
  return (
    <PluginCard
      copy={copy}
      title={t('discordTitle')}
      description={t('discordDescription')}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      {state.status !== undefined && (
        <p data-discord-status>
          {t(state.status.connectionKey)}
          {state.status.hintKey !== undefined ? ` — ${t(state.status.hintKey)}` : ''}
        </p>
      )}
      {ID_FIELDS.map(([field, labelKey, hintKey]) => (
        <ValueField
          key={field}
          id={`plugin-config-discord-${field}`}
          label={t(labelKey)}
          hint={t(hintKey)}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('discordInvalidIds')}
          disabled={disabled}
          {...state[field]}
          onEdit={(text) => { props.edit(field, text) }}
          onReset={() => { props.resetField(field) }}
        />
      ))}
    </PluginCard>
  )
}
