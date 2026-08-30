/** The Discord adapter's plugin settings card: connection status, guild allowlist, and output behavior. */

import { useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SelectField, ValueField } from './fields.js'
import { PluginCard, type PluginCardCopy } from './PluginCard.js'
import type { CardManagement } from './card-form.js'
import type { DiscordStatusConnectionKey, DiscordStatusHintKey } from './settings-model.js'
import { ARCHIVE_CHOICES, ARCHIVE_FIELD, LANGUAGE_CHOICES, LANGUAGE_FIELD } from './card-form.js'
import type { DiscordCardFace } from './card-controller.js'
import type {} from './slot-contract.js'

/** Props the runtime binds for the Discord settings card. */
export type DiscordSettingsCardProps =
  PropsRuntime<"settings.section">
  & PropsLocale<'dsh-discord'>
  & InjectFace<DiscordCardFace>

/**
 * Traffic-light color for the connection status dot. Green = healthy,
 * amber = transient (handshaking), red = operator action required.
 */
const STATUS_DOT_COLOR: Readonly<Record<string, string>> = {
  discordStatusConnected: '#23a55a',
  discordStatusConnecting: '#f0b232',
  discordStatusDisconnected: '#f23f43',
  discordStatusInvalidToken: '#f23f43',
  discordStatusIntentsBlocked: '#f23f43',
  discordStatusPermissionsBlocked: '#f23f43',
}

/** Scoped stylesheet, injected once per card mount. Neutral translucent
 * tones keep the controls readable on both the Host's dark and light themes. */
const CARD_CSS = `
[data-dsh-discord-card] { display: flex; flex-direction: column; gap: 20px; padding: 4px 2px 0; }
[data-dsh-discord-card-head] { display: flex; flex-direction: column; gap: 2px; text-align: left; }
[data-dsh-discord-card-title] { font-size: 14px; font-weight: 600; }
[data-dsh-discord-card-description] { font-size: 12px; opacity: .55; }
button[aria-expanded] { all: unset; cursor: pointer; display: block; width: 100%; box-sizing: border-box; }
button[aria-expanded]:focus-visible { outline: 2px solid rgba(88, 101, 242, .8); border-radius: 8px; }
[data-dsh-discord-badge] { display: inline-block; font-size: 11px; line-height: 18px; padding: 0 8px; border-radius: 999px; }
[data-dsh-discord-badge="unsaved"] { background: rgba(250, 204, 21, .16); color: #facc15; }
[data-dsh-discord-status] { display: flex; align-items: center; gap: 8px; font-size: 13px; }
[data-dsh-discord-status-dot] { width: 10px; height: 10px; border-radius: 50%; flex: none; box-shadow: 0 0 6px currentColor; }
[data-dsh-discord-field] { display: flex; flex-direction: column; gap: 6px; }
[data-dsh-discord-field-head] { display: flex; align-items: center; gap: 8px; }
[data-dsh-discord-field-head] label { font-size: 13px; font-weight: 500; }
[data-dsh-discord-badges] { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
[data-dsh-discord-badge="overridden"] { background: rgba(250, 204, 21, .16); color: #facc15; }
[data-dsh-discord-field-head] button { all: unset; cursor: pointer; font-size: 12px; padding: 1px 8px; border-radius: 6px; background: rgba(127, 127, 127, .18); }
[data-dsh-discord-field-head] button:hover { background: rgba(127, 127, 127, .3); }
[data-dsh-discord-field] textarea, [data-dsh-discord-field] select {
  width: 100%; box-sizing: border-box; color: inherit; font: inherit; font-size: 13px;
  background: rgba(127, 127, 127, .12); border: 1px solid rgba(127, 127, 127, .28);
  border-radius: 8px; padding: 8px 10px; resize: vertical;
}
[data-dsh-discord-field] textarea:focus-visible, [data-dsh-discord-field] select:focus-visible {
  outline: none; border-color: rgba(88, 101, 242, .9);
}
[data-dsh-discord-field] textarea[aria-invalid="true"], [data-dsh-discord-field] select[aria-invalid="true"] {
  border-color: rgba(242, 63, 67, .8);
}
[data-dsh-discord-field-note] { margin: 0; font-size: 12px; opacity: .55; }
[data-dsh-discord-field-note="invalid"] { opacity: 1; color: #f23f43; }
[data-dsh-discord-field-help] { margin: -2px 0 0; font-size: 12px; opacity: .55; line-height: 1.6; }
[data-dsh-discord-disconnect] { all: unset; cursor: pointer; margin-left: auto; font-size: 12px; padding: 2px 10px; border-radius: 6px; background: rgba(127, 127, 127, .18); }
[data-dsh-discord-disconnect]:hover { background: rgba(242, 63, 67, .18); color: #f23f43; }
[data-dsh-discord-token] { display: flex; flex-direction: column; gap: 8px; padding: 14px; border: 1px solid rgba(127, 127, 127, .28); border-radius: 10px; }
[data-dsh-discord-token-row] { display: flex; gap: 10px; }
[data-dsh-discord-token-row] input {
  flex: 1; min-width: 0; box-sizing: border-box; color: inherit; font: inherit; font-size: 13px;
  background: rgba(127, 127, 127, .12); border: 1px solid rgba(127, 127, 127, .28); border-radius: 8px; padding: 8px 10px;
}
[data-dsh-discord-token-row] input:focus-visible { outline: none; border-color: rgba(88, 101, 242, .9); }
[data-dsh-discord-token-row] button { all: unset; cursor: pointer; font-size: 13px; padding: 7px 16px; border-radius: 8px; background: rgba(88, 101, 242, .9); color: #fff; white-space: nowrap; }
[data-dsh-discord-token-row] button:disabled { opacity: .45; cursor: default; }
[data-dsh-discord-token-error] { margin: 0; font-size: 12px; color: #f23f43; }
[data-dsh-discord-card-footer] { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
[data-dsh-discord-card-footer] button { all: unset; cursor: pointer; font-size: 13px; padding: 6px 16px; border-radius: 8px; }
[data-dsh-discord-card-footer] button[type="button"]:first-child { background: rgba(127, 127, 127, .18); }
[data-dsh-discord-card-footer] button:not(:disabled) { background: rgba(88, 101, 242, .9); color: #fff; }
[data-dsh-discord-card-footer] button[type="button"]:first-child:not(:disabled) { background: rgba(127, 127, 127, .18); color: inherit; }
[data-dsh-discord-card-footer] button:disabled { opacity: .4; cursor: default; }
[data-dsh-discord-card-footer] button:not(:disabled):hover { filter: brightness(1.12); }
`

/**
 * Render the Discord adapter card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card, or nothing while the namespace is unavailable.
 */
/** First-run token entry: shown only while the Host reports the credential
 * missing or rejected. The value lives in local state alone and flows to the
 * Host's credential service over the management channel — never into card
 * state, settings, or any log. */
function TokenSetup(props: {
  management: CardManagement | undefined
  connectionKey: DiscordStatusConnectionKey | undefined
  hintKey: DiscordStatusHintKey | undefined
  t: TranslateNS<'dsh-discord'>
}): ReactNode {
  const { t } = props
  const [token, setToken] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  // Visible whenever the gateway is not healthy: first run (missing token),
  // a rejected token, or any other disconnected state — the user must always
  // have a path to (re)enter the credential. Hidden only while connected or
  // mid-handshake.
  const connectionKey = props.connectionKey
  const visible = connectionKey === undefined
    || connectionKey === 'discordStatusDisconnected'
    || connectionKey === 'discordStatusInvalidToken'
    || connectionKey === 'discordStatusIntentsBlocked'
    || connectionKey === 'discordStatusPermissionsBlocked'
  if (!visible) return null
  const submit = (): void => {
    const value = token.trim()
    if (value === '' || props.management === undefined || connecting) return
    setConnecting(true)
    setError('')
    props.management.setToken(value).then(() => {
      setToken('')
      props.management?.connect()
      props.management?.refresh()
      setConnecting(false)
    }, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      setConnecting(false)
    })
  }
  return (
    <div data-dsh-discord-token="">
      <div data-dsh-discord-field-head="">
        <label htmlFor="plugin-config-discord-token">{t('discordTokenLabel')}</label>
      </div>
      <div data-dsh-discord-token-row="">
        <input
          id="plugin-config-discord-token"
          type="password"
          autoComplete="off"
          placeholder={t('discordTokenPlaceholder')}
          value={token}
          disabled={connecting}
          onChange={event => { setToken(event.currentTarget.value) }}
          onKeyDown={event => { if (event.key === 'Enter') submit() }}
        />
        <button type="button" disabled={connecting || token.trim() === ''} onClick={submit}>
          {connecting ? t('discordTokenConnecting') : t('discordTokenConnect')}
        </button>
      </div>
      <p data-dsh-discord-field-help="">{t('discordTokenHelp')}</p>
      {error !== '' && <p data-dsh-discord-token-error="">{error}</p>}
    </div>
  )
}

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
      <style>{CARD_CSS}</style>
      {state.status !== undefined && (
        <p data-dsh-discord-status="">
          <span
            data-dsh-discord-status-dot=""
            style={{ background: STATUS_DOT_COLOR[state.status.connectionKey] ?? '#f23f43', color: STATUS_DOT_COLOR[state.status.connectionKey] ?? '#f23f43' }}
          />
          <span>
            {t(state.status.connectionKey)}
            {state.status.hintKey !== undefined ? ` — ${t(state.status.hintKey)}` : ''}
          </span>
          {(state.status.connectionKey === 'discordStatusConnected' || state.status.connectionKey === 'discordStatusConnecting') && props.management !== undefined && (
            <button
              type="button"
              data-dsh-discord-disconnect=""
              onClick={() => { props.management?.disconnect(); props.management?.refresh() }}
            >
              {t('discordDisconnect')}
            </button>
          )}
        </p>
      )}
      <TokenSetup management={props.management} connectionKey={state.status?.connectionKey} hintKey={state.status?.hintKey} t={t} />
      <ValueField
        id="plugin-config-discord-allowedGuildIds"
        label={t('discordAllowedGuildIds')}
        hint={t('discordAllowedGuildIdsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('discordInvalidIds')}
        disabled={disabled}
        {...state.allowedGuildIds}
        onEdit={(text) => { props.edit('allowedGuildIds', text) }}
        onReset={() => { props.resetField('allowedGuildIds') }}
      />
      <p data-dsh-discord-field-help="">{t('discordGuildIdHelp')}</p>
      <SelectField
        id={`plugin-config-discord-${ARCHIVE_FIELD}`}
        label={t('discordThreadAutoArchive')}
        hint={t('discordThreadAutoArchiveHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('discordInvalidArchive')}
        disabled={disabled}
        options={ARCHIVE_CHOICES}
        {...state[ARCHIVE_FIELD]}
        onEdit={(text) => { props.edit(ARCHIVE_FIELD, text) }}
        onReset={() => { props.resetField(ARCHIVE_FIELD) }}
      />
      <SelectField
        id={`plugin-config-discord-${LANGUAGE_FIELD}`}
        label={t('discordLanguage')}
        hint={t('discordLanguageHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('discordInvalidLanguage')}
        disabled={disabled}
        options={LANGUAGE_CHOICES}
        {...state[LANGUAGE_FIELD]}
        onEdit={(text) => { props.edit(LANGUAGE_FIELD, text) }}
        onReset={() => { props.resetField(LANGUAGE_FIELD) }}
      />
    </PluginCard>
  )
}
