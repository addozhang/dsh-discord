/**
 * The Discord card's staged form model.
 *
 * A card stages what the user types and writes it only on save. Each field
 * shows its effective value and whether the user layer carries it — presence,
 * not value comparison, marks an override. A field is invalid when its draft
 * is not a list of Discord IDs, which blocks the save rather than dropping it.
 */

import type { SettingsScope, SettingsScopeSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { AdapterStatusView } from '../features/adapter-status.js'
import type { DiscordSettings } from '../settings.js'
import { createLocalSnapshotStore } from './snapshot-store.js'
import { presentAdapterStatus, type AdapterStatusPresentation } from './settings-model.js'

/** One staged edit over a single field. */
interface StagedEdit {
  text: string
  clear: boolean
}

/** One field as its control renders it. */
export interface CardFieldState {
  text: string
  overridden: boolean
  invalid: boolean
}

/** Form state the card chrome shares. */
export interface CardShell {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
}

/** The edit actions a card's slot entry injects. */
export interface CardActions {
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}

/** The ID list fields this card edits, in display order. */
export const DISCORD_ID_FIELDS = [
  'allowedGuildIds',
  'memberUserIds',
  'memberRoleIds',
  'administratorUserIds',
  'administratorRoleIds',
  'deniedUserIds',
  'deniedRoleIds',
  'hostOperatorUserIds',
] as const satisfies readonly (keyof DiscordSettings)[]

export type DiscordCardField = typeof DISCORD_ID_FIELDS[number]

/** What the Discord card renders. */
export type DiscordCardState = CardShell & Record<DiscordCardField, CardFieldState> & {
  /** The Host's sanitized connection status, once reported. */
  status: AdapterStatusPresentation | undefined
}

/** The registration-side face the Discord card's slot entry injects. */
export interface DiscordCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer. */
    discordCard: SnapshotStore<DiscordCardState>
  }
}

const DISCORD_SNOWFLAKE = /^\d{17,20}$/u

function parseIdList(text: string): string[] | undefined {
  const items = text
    .split(/\r?\n/u)
    .map(item => item.trim())
    .filter(Boolean)
  const unique = [...new Set(items)]
  return unique.every(item => DISCORD_SNOWFLAKE.test(item)) ? unique : undefined
}

/**
 * Stages the Discord card's ID-list edits over its settings namespace and
 * writes them on save. Outcomes are read back from the namespace: the Host is
 * the only authority on whether a value was accepted.
 */
export class DiscordCardForm {
  private readonly staged = new Map<DiscordCardField, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false
  private status: AdapterStatusPresentation | undefined = undefined

  constructor(private readonly scope: SettingsScope<DiscordSettings>) {
    this.scope.subscribe(() => { this.publish() })
  }

  /**
   * Publish the Host's sanitized status view. Edits, saves, and failures
   * never touch it — connection state is the Host's report, not form state.
   */
  setStatus(view: AdapterStatusView | undefined): void {
    this.status = view === undefined ? undefined : presentAdapterStatus(view)
    this.publish()
  }

  /** Publish the card state the renderer reads through its bound selector. */
  bind(): SnapshotStore<DiscordCardState> {
    const store = createLocalSnapshotStore(this.project())
    this.listeners.add(() => { store.set(this.project()) })
    return store
  }

  /** Build the edit, reset, save, and discard actions bound to this form. */
  actions(): CardActions {
    return {
      edit: (field, text) => {
        this.staged.set(field as DiscordCardField, { text, clear: false })
        this.failed = false
        this.publish()
      },
      resetField: (field) => {
        this.staged.set(field as DiscordCardField, { text: '', clear: true })
        this.failed = false
        this.publish()
      },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  private project(): DiscordCardState {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    const fields = {} as Record<DiscordCardField, CardFieldState>
    for (const field of DISCORD_ID_FIELDS) {
      fields[field] = this.fieldState(field)
    }
    return {
      ...fields,
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.write === undefined),
      saving: this.saving,
      failed: this.failed,
      status: this.status,
    }
  }

  private fieldState(field: DiscordCardField): CardFieldState {
    const staged = this.staged.get(field)
    if (staged === undefined) {
      return {
        text: this.currentText(field),
        overridden: this.stored(field),
        invalid: false,
      }
    }
    if (staged.clear) {
      return { text: staged.text, overridden: false, invalid: false }
    }
    const parsed = parseIdList(staged.text)
    return {
      text: staged.text,
      overridden: parsed !== undefined,
      invalid: parsed === undefined,
    }
  }

  private currentText(field: DiscordCardField): string {
    const section = this.snapshot().value as Record<string, unknown> | undefined
    const value = section?.[field]
    return Array.isArray(value) ? value.join('\n') : ''
  }

  private snapshot(): SettingsScopeSnapshot<DiscordSettings> {
    return this.scope.getSnapshot()
  }

  private userLayer(): Record<string, unknown> | undefined {
    return this.snapshot().user as Record<string, unknown> | undefined
  }

  private stored(field: DiscordCardField): boolean {
    const user = this.userLayer()
    return user !== undefined && Object.hasOwn(user, field)
  }

  private plan(): { field: DiscordCardField; write: (() => Promise<boolean>) | undefined }[] {
    const plan: { field: DiscordCardField; write: (() => Promise<boolean>) | undefined }[] = []
    for (const [field, staged] of this.staged) {
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, write: () => this.clear(field) })
        continue
      }
      if (staged.text === this.currentText(field)) continue
      const parsed = parseIdList(staged.text)
      if (parsed === undefined) plan.push({ field, write: undefined })
      else plan.push({ field, write: () => this.store(field, parsed) })
    }
    return plan
  }

  private async clear(field: DiscordCardField): Promise<boolean> {
    await this.scope.unset(field)
    return !this.stored(field)
  }

  private async store(field: DiscordCardField, value: string[]): Promise<boolean> {
    await this.scope.set(field, value)
    return this.userLayer()?.[field] !== undefined
  }

  private async save(): Promise<void> {
    const plan = this.plan()
    const writes = plan.flatMap(item => item.write === undefined ? [] : [item.write])
    if (plan.length === 0 || this.saving || writes.length !== plan.length) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const write of writes) {
      // A rejected write is one landed=false outcome among many, not a crash:
      // the remaining writes still run and every draft survives for retry.
      landed = await write().catch(() => false) && landed
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
