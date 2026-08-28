/**
 * The settings card's registration-side wiring: the controller exposes the
 * inject face (actions plus the bound snapshot store), and the client entry
 * registers the card into the Plugins section with the plugin's namespace
 * until its fiber disposes it.
 */

import { describe, expect, it, vi } from 'vitest'

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

import { DiscordCardController } from '../src/client/card-controller.js'
import { apply as applyClient, name as clientName } from '../src/client/index.js'
import { DISCORD_SETTINGS_NAMESPACE } from '../src/settings-namespace.js'

function fakeScope() {
  const listeners = new Set<() => void>()
  return {
    scope: {
      getSnapshot: () => ({
        status: 'ready',
        value: {},
        base: {},
        user: {},
        revision: 1,
        writable: true,
        mode: 'host',
      }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set: () => Promise.resolve(),
      unset: () => Promise.resolve(),
    },
  }
}

describe('DiscordCardController', () => {
  it('exposes the form actions and a live snapshot store through its face', () => {
    const { scope } = fakeScope()
    const controller = new DiscordCardController(scope as never)
    const face = controller.face()

    expect(face.hooks.discordCard.getSnapshot().available).toBe(true)
    face.edit('allowedGuildIds', '123456789012345678')
    expect(face.hooks.discordCard.getSnapshot().dirty).toBe(true)

    face.discard()
    expect(face.hooks.discordCard.getSnapshot().dirty).toBe(false)
  })
})

describe('client entry', () => {
  it('registers the plugins-tab card over the plugin namespace until disposal', () => {
    const { scope } = fakeScope()
    const disposer = vi.fn()
    const ctx = {
      settingsScope: { bind: vi.fn(() => scope) },
      slots: { register: vi.fn(() => disposer) },
      effect: vi.fn((execute: () => unknown) => { execute() }),
    } as unknown as ClientContext & {
      settingsScope: { bind: ReturnType<typeof vi.fn> }
      slots: { register: ReturnType<typeof vi.fn> }
      effect: ReturnType<typeof vi.fn>
    }

    applyClient(ctx)

    expect(clientName).toBe('dsh-discord-client')
    expect(ctx.settingsScope.bind).toHaveBeenCalledWith({ namespace: DISCORD_SETTINGS_NAMESPACE })
    expect(ctx.slots.register).toHaveBeenCalledTimes(1)
    const options = ctx.slots.register.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options).toMatchObject({
      name: 'settings.plugins.tab',
      id: 'discord',
      locale: 'settings.plugins',
    })
    expect(typeof options.inject).toBe('function')
    expect(ctx.effect).toHaveBeenCalledTimes(1)
  })
})
