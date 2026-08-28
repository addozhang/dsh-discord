/**
 * The Discord card's form model tests. These target behavior only: staging,
 * override presence, invalid drafts blocking saves, and read-back outcomes.
 */

import { describe, expect, it, vi } from 'vitest'

import { DiscordCardForm } from '../src/client/card-form.js'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

type Listener = () => void

function fakeScope(initial: Partial<SettingsScopeSnapshot<Record<string, unknown>>> = {}): {
  scope: SettingsScope<never>
  snapshot: SettingsScopeSnapshot<Record<string, unknown>>
  listeners: Set<Listener>
  setField: (field: string, value: unknown) => void
  user: Record<string, unknown>
} {
  const listeners = new Set<Listener>()
  const user: Record<string, unknown> = {}
  const snapshot: SettingsScopeSnapshot<Record<string, unknown>> = {
    status: 'ready',
    value: {},
    base: {},
    user,
    revision: 1,
    writable: true,
    mode: 'host',
    ...initial,
  }
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (field: string, value: unknown) => {
      user[field] = value
      snapshot.value = { ...snapshot.value, [field]: value }
      return Promise.resolve()
    },
    unset: (field: string) => {
      Reflect.deleteProperty(user, field)
      const next = { ...snapshot.value }
      Reflect.deleteProperty(next, field)
      snapshot.value = next
      return Promise.resolve()
    },
  } as unknown as SettingsScope<never>
  return {
    scope,
    snapshot,
    listeners,
    user,
    setField: (field: string, value: unknown) => {
      user[field] = value
      snapshot.value = { ...snapshot.value, [field]: value }
      for (const listener of listeners) listener()
    },
  }
}

describe('DiscordCardForm', () => {
  it('reports the current section as unchanged and clean', () => {
    const host = fakeScope({ value: { allowedGuildIds: ['123456789012345678'] } })
    const form = new DiscordCardForm(host.scope)
    const state = form.bind().getSnapshot()
    expect(state.dirty).toBe(false)
    expect(state.available).toBe(true)
    expect(state.allowedGuildIds.text).toBe('123456789012345678')
    expect(state.allowedGuildIds.overridden).toBe(false)
  })

  it('stages valid ID edits as overridden and saves them through the scope', async () => {
    const host = fakeScope()
    const form = new DiscordCardForm(host.scope)
    const store = form.bind()
    const actions = form.actions()

    actions.edit('allowedGuildIds', ' 123456789012345678 \n123456789012345678\n223456789012345678 ')
    let state = store.getSnapshot()
    expect(state.dirty).toBe(true)
    expect(state.invalid).toBe(false)
    expect(state.allowedGuildIds.overridden).toBe(true)

    actions.save()
    await vi.waitFor(() => {
      state = store.getSnapshot()
      expect(state.saving).toBe(false)
    })
    expect(state.dirty).toBe(false)
    expect(host.user.allowedGuildIds).toEqual(['123456789012345678', '223456789012345678'])
  })

  it('marks malformed drafts invalid and refuses to save them', async () => {
    const host = fakeScope()
    const form = new DiscordCardForm(host.scope)
    const store = form.bind()
    const actions = form.actions()

    actions.edit('memberRoleIds', 'not-a-snowflake')
    let state = store.getSnapshot()
    expect(state.invalid).toBe(true)

    actions.save()
    await Promise.resolve()
    state = store.getSnapshot()
    expect(state.failed).toBe(false)
    expect(host.user.memberRoleIds).toBeUndefined()
    expect(state.dirty).toBe(true)
  })

  it('clears an override back to the composition layer on reset and save', async () => {
    const host = fakeScope({ value: { deniedUserIds: ['123456789012345678'] } })
    host.setField('deniedUserIds', ['123456789012345678'])
    const form = new DiscordCardForm(host.scope)
    const store = form.bind()
    const actions = form.actions()

    actions.resetField('deniedUserIds')
    let state = store.getSnapshot()
    expect(state.dirty).toBe(true)

    actions.save()
    await vi.waitFor(() => {
      state = store.getSnapshot()
      expect(state.saving).toBe(false)
    })
    expect(state.dirty).toBe(false)
    expect(host.user.deniedUserIds).toBeUndefined()
  })

  it('keeps drafts and reports failure when the Host does not accept a write', async () => {
    const host = fakeScope()
    const scope = host.scope as unknown as SettingsScope<never> & {
      set: (field: string, value: unknown) => Promise<void>
    }
    scope.set = vi.fn(() => {
      return Promise.reject(new Error('rejected'))
    })
    const form = new DiscordCardForm(host.scope)
    const store = form.bind()
    const actions = form.actions()

    actions.edit('allowedGuildIds', '123456789012345678')
    actions.save()
    let state = store.getSnapshot()
    await vi.waitFor(() => {
      state = store.getSnapshot()
      expect(state.saving).toBe(false)
    })
    expect(state.failed).toBe(true)
    expect(state.dirty).toBe(true)
    expect(state.allowedGuildIds.text).toBe('123456789012345678')
  })
})

describe('DiscordCardForm status surface (2.3)', () => {
  const INVALID_TOKEN_VIEW = {
    token: 'configured',
    connection: 'invalid-token',
    hint: 'token-rejected',
  } as const

  it('shows a published status and republishes when it changes', () => {
    const host = fakeScope()
    const form = new DiscordCardForm(host.scope)
    const store = form.bind()

    expect(store.getSnapshot().status).toBeUndefined()

    form.setStatus(INVALID_TOKEN_VIEW)
    let state = store.getSnapshot()
    expect(state.status).toEqual({
      connectionKey: 'discordStatusInvalidToken',
      hintKey: 'discordHintTokenRejected',
      actionable: true,
    })

    form.setStatus({ token: 'configured', connection: 'connected' })
    state = store.getSnapshot()
    expect(state.status?.connectionKey).toBe('discordStatusConnected')
    expect(state.status?.actionable).toBe(false)
  })

  it('keeps the status through saves, failures, and discards', async () => {
    const host = fakeScope()
    const form = new DiscordCardForm(host.scope)
    const store = form.bind()
    const actions = form.actions()

    form.setStatus(INVALID_TOKEN_VIEW)
    actions.edit('allowedGuildIds', '123456789012345678')
    actions.save()
    await vi.waitFor(() => {
      const state = store.getSnapshot()
      expect(state.saving).toBe(false)
    })

    const state = store.getSnapshot()
    expect(state.status?.connectionKey).toBe('discordStatusInvalidToken')
    expect(state.failed).toBe(false)

    actions.discard()
    expect(store.getSnapshot().status?.connectionKey).toBe('discordStatusInvalidToken')
  })
})
