/**
 * One plugin card's chrome: a disclosure header naming the plugin, the card's
 * form state, and the save/discard footer. Disclosure is card-local reading
 * state; staged edits outlive collapsing and mark the header unsaved.
 */

import { useState, type ReactNode } from 'react'
import type { CardShell } from './card-form.js'

/** Copy keys the host settings section provides to every card. */
export interface PluginCardCopy {
  expand: string
  collapse: string
  unsaved: string
  readOnly: string
  saveFailed: string
  discard: string
  save: string
  saving: string
}

/** Props for the Discord adapter's card chrome. */
export interface PluginCardProps {
  /** Card copy from the section locale. */
  copy: PluginCardCopy
  /** Card title. */
  title: string
  /** Line describing what this card's settings govern. */
  description: string
  /** The card's form state. */
  state: CardShell
  /** Write every staged edit. */
  onSave: () => void
  /** Drop every staged edit. */
  onDiscard: () => void
  /** The plugin's controls. */
  children: ReactNode
}

/**
 * Render the Discord adapter card chrome.
 * @param props - the card's copy, state, and controls.
 * @returns the card, or nothing when the namespace is unavailable.
 */
export function PluginCard(props: PluginCardProps): ReactNode {
  // Open by default: the card carries only a handful of settings, and the
  // extra click to reveal them was pure friction (user-directed, card pass).
  const [open, setOpen] = useState(true)
  const { state } = props
  if (!state.available) return null
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <div data-dsh-discord-card={open ? 'open' : 'closed'}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${props.copy[open ? 'collapse' : 'expand']}: ${props.title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span data-dsh-discord-card-head="">
          <span data-dsh-discord-card-title="">{props.title}</span>
          <span data-dsh-discord-card-description="">{props.description}</span>
        </span>
        {state.dirty ? <span data-dsh-discord-badge="unsaved">{props.copy.unsaved}</span> : null}
      </button>
      {open
        ? (
            <div data-dsh-discord-card-body="">
              {!state.writable
                ? <p role="status">{props.copy.readOnly}</p>
                : null}
              {props.children}
              <div data-dsh-discord-card-footer="">
                {state.failed ? <p role="status">{props.copy.saveFailed}</p> : null}
                <button
                  type="button"
                  disabled={!state.dirty || state.saving}
                  onClick={props.onDiscard}
                >
                  {props.copy.discard}
                </button>
                <button
                  type="button"
                  disabled={blocked}
                  onClick={props.onSave}
                >
                  {props.copy[state.saving ? 'saving' : 'save']}
                </button>
              </div>
            </div>
          )
        : null}
    </div>
  )
}
