/**
 * Hand-written control for the Discord settings card. It renders one field's
 * label, staged text, override badge, and reset action. Nothing here writes:
 * the card's save is the single point where a draft becomes a document write.
 */

import type { ReactNode } from 'react'

export interface FieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation rendered under the control. */
  hint: string
  /** Draft text this control renders. */
  text: string
  /** True when saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** True when the draft is not a value this field accepts. */
  invalid: boolean
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string
  /** Disables the control while the document is read-only. */
  disabled: boolean
  /** Stage draft text. */
  onEdit: (text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: () => void
}

/** One choice in a SelectField. */
export interface SelectOption {
  value: string
  label: string
}

/**
 * A staged single-choice field (native select) sharing the ID field's
 * head layout: label, override badge, reset, and a hint/invalid note.
 */
export function SelectField(props: FieldProps & { options: readonly SelectOption[] }): ReactNode {
  return (
    <div data-dsh-discord-field="">
      <div data-dsh-discord-field-head="">
        <label htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
              <span data-dsh-discord-badges="">
                <span data-dsh-discord-badge="overridden">{props.overriddenLabel}</span>
                <button
                  type="button"
                  disabled={props.disabled}
                  onClick={props.onReset}
                >
                  {props.resetLabel}
                </button>
              </span>
            )
          : null}
      </div>
      <select
        id={props.id}
        aria-invalid={props.invalid}
        value={props.text}
        disabled={props.disabled}
        onChange={event => { props.onEdit(event.currentTarget.value); }}
      >
        {props.options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {(props.invalid || props.hint !== '') && (
        <p data-dsh-discord-field-note={props.invalid ? 'invalid' : 'hint'}>
          {props.invalid ? props.invalidLabel : props.hint}
        </p>
      )}
    </div>
  )
}

/**
 * A staged multi-line Discord ID field.
 * @param props - the field's copy, its staged text, and the edit actions.
 * @returns the labelled control.
 */
export function ValueField(props: FieldProps): ReactNode {
  return (
    <div data-dsh-discord-field="">
      <div data-dsh-discord-field-head="">
        <label htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
              <span data-dsh-discord-badges="">
                <span data-dsh-discord-badge="overridden">{props.overriddenLabel}</span>
                <button
                  type="button"
                  disabled={props.disabled}
                  onClick={props.onReset}
                >
                  {props.resetLabel}
                </button>
              </span>
            )
          : null}
      </div>
      <textarea
        id={props.id}
        rows={3}
        aria-invalid={props.invalid}
        value={props.text}
        disabled={props.disabled}
        onInput={event => { props.onEdit(event.currentTarget.value); }}
      />
      {(props.invalid || props.hint !== '') && (
        <p data-dsh-discord-field-note={props.invalid ? 'invalid' : 'hint'}>
          {props.invalid ? props.invalidLabel : props.hint}
        </p>
      )}
    </div>
  )
}
