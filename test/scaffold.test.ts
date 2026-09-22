import { describe, expect, it, vi } from 'vitest'

import { apply, name } from '../src/index.js'
import { DISCORD_SETTINGS_NAMESPACE } from '../src/settings-namespace.js'

type DocumentListener = (ns: unknown, revision: number) => void

function fakeHostContext() {
  const handlers = new Map<string, DocumentListener[]>()
  const ctx = {
    inject: vi.fn(),
    logger: { debug: vi.fn() },
    on: vi.fn((event: string, listener: DocumentListener) => {
      const list = handlers.get(event) ?? []
      list.push(listener)
      handlers.set(event, list)
      return () => {}
    }),
    get: (serviceName: string) => ({
      sessionController: { prompt: () => {}, create: () => {}, list: () => {}, cancel: () => {}, updateQueue: () => {}, selectModel: () => {}, modelCatalog: () => {}, follow: () => {}, control: () => {}, resolveAgent: () => {} }, workspaceController: { follow: () => {} }, sessionQuery: { observeSession: () => {} }, webServer: {}, commands: { execute: () => {} }, permissionPresets: { catalog: () => {} },
      credentials: { resolve: () => {}, describe: () => {}, set: () => {}, unset: () => {} },
      settings: { describe: () => [], update: () => {} },
      storageDomain: { open: () => {} },
      connection: { rpc: { handle: () => () => {} } },
    })[serviceName],
    effect: vi.fn(),
  }
  return { ctx, handlers }
}

describe('package scaffold', () => {
  it('exports the stable Cordis plugin identity', () => {
    expect(name).toBe('dsh-discord')
  })

  it('binds the settings boundary over the namespace document event (0.1.7 forms model)', () => {
    const { ctx, handlers } = fakeHostContext()
    apply(ctx as never)
    const listeners = handlers.get('settings/document-updated') ?? []
    expect(listeners.length).toBe(1)
    // Another namespace's revision bump is not ours: no apply, no log.
    listeners[0]?.('some-other-namespace', 1)
    expect(ctx.logger.debug).not.toHaveBeenCalled()
    // Our namespace bumps re-apply the settings snapshot.
    listeners[0]?.(DISCORD_SETTINGS_NAMESPACE, 1)
    expect(ctx.logger.debug).toHaveBeenCalledWith(expect.objectContaining({
      event: 'discord_settings_applied',
      enabled: false,
      allowedGuildCount: 0,
    }))
  })
})
