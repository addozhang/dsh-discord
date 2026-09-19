import { describe, expect, it, vi } from 'vitest'

import { apply, name } from '../src/index.js'
import { DISCORD_SETTINGS_NAMESPACE } from '../src/settings-namespace.js'

function fakeHostContext() {
  const installSection = vi.fn<
    (owner: unknown, ns: string, schema: unknown, entry: { enabled: boolean } & Record<string, unknown>, hooks: unknown) => void
  >()
  const ctx = {
    inject: vi.fn(),
    logger: { debug: vi.fn() },
    get: (serviceName: string) => ({
      sessionController: { prompt: () => {}, create: () => {}, list: () => {}, cancel: () => {}, updateQueue: () => {}, selectModel: () => {}, modelCatalog: () => {}, follow: () => {}, control: () => {}, resolveAgent: () => {} }, workspaceController: { follow: () => {} }, sessionQuery: { observeSession: () => {} }, webServer: {}, commands: { execute: () => {} }, permissionPresets: { catalog: () => {} },
      credentials: { resolve: () => {}, describe: () => {}, set: () => {}, unset: () => {} },
      settings: { installSection },
      storageDomain: { open: () => {} },
      connection: { rpc: { handle: () => () => {} } },
    })[serviceName],
    effect: vi.fn(),
  }
  return { ctx, installSection }
}

describe('package scaffold', () => {
  it('exports the stable Cordis plugin identity', () => {
    expect(name).toBe('dsh-discord')
  })

  it('installs the settings boundary through the settings provider section', () => {
    const { ctx, installSection } = fakeHostContext()
    apply(ctx as never)
    expect(installSection).toHaveBeenCalledTimes(1)
    const [owner, namespace, schema, entry, hooks] = installSection.mock.calls[0] ?? []
    expect(owner).toBe(ctx)
    expect(namespace).toBe(DISCORD_SETTINGS_NAMESPACE)
    expect(schema).toBeDefined()
    expect(entry).toEqual(expect.objectContaining({ enabled: false }))
    const sectionHooks = hooks as Record<string, unknown> | undefined
    expect(typeof sectionHooks?.['validate']).toBe('function')
    expect(typeof sectionHooks?.['setSource']).toBe('function')
    expect(typeof sectionHooks?.['onChange']).toBe('function')
  })
})

