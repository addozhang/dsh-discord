/**
 * Startup capability boundary tests: the adapter activates only when every
 * required DSH Host service is present and satisfies its minimum contract,
 * and fails loud with an actionable diagnostic naming every gap.
 */

import { describe, expect, it } from 'vitest'

import { REQUIRED_HOST_SERVICES, validateHostCapabilities } from '../src/startup.js'
import { apply } from '../src/index.js'

const controllerMembers = () => ({
  prompt: () => {},
  create: () => {},
  list: () => {},
  cancel: () => {},
  updateQueue: () => {},
  selectModel: () => {},
  modelCatalog: () => {},
  follow: () => {},
  control: () => {},
  resolveAgent: () => {},
})

function validServices(): Record<string, unknown> {
  return {
    sessionController: controllerMembers(),
    workspaceController: { follow: () => {} },
    sessionQuery: { observeSession: () => {} },
    webServer: {},
    credentials: { resolve: () => {}, describe: () => {}, set: () => {}, unset: () => {} },
    settings: { installSection: () => {} },
    storageDomain: { open: () => {} },
    connection: { rpc: { handle: () => () => {} } },
    commands: { execute: () => {} },
    permissionPresets: { catalog: () => {} },
  }
}

describe('host capability boundary', () => {
  it('declares exactly the required Host service roster', () => {
    expect([...REQUIRED_HOST_SERVICES]).toEqual([
      'sessionController',
      'workspaceController',
      'sessionQuery',
      'webServer',
      'credentials',
      'settings',
      'storageDomain',
      'connection',
      // The /permission surface (16.59): the Host command runtime and the
      // permission-preset catalog joined the roster, both probe-verified on
      // 0.1.6-alpha.2.
      'commands',
      'permissionPresets',
    ])
  })

  it('fails loud naming every missing capability at once', () => {
    const services: Record<string, unknown> = {}
    expect(() => { validateHostCapabilities(name => services[name]); }).toThrow(/sessionController.*sessionQuery|sessionQuery.*sessionController/s)
    expect(() => { validateHostCapabilities(name => services[name]); }).toThrow(/dsh web/)
  })

  it('fails loud naming the contract members an incompatible service lacks', () => {
    const services = validServices()
    services.sessionController = { prompt: () => {} }
    services.credentials = { resolve: () => {} }
    services.commands = {}
    services.permissionPresets = {}
    try {
      validateHostCapabilities(name => services[name])
      expect.unreachable()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('sessionController')
      expect(message).toContain('modelCatalog')
      expect(message).toContain('follow')
      expect(message).toContain('resolveAgent')
      expect(message).toContain('credentials')
      expect(message).toContain('describe')
      expect(message).toContain('commands')
      expect(message).toContain('execute')
      expect(message).toContain('permissionPresets')
      expect(message).toContain('catalog')
    }
  })

  it('activates when every capability satisfies its contract', () => {
    const services = validServices()
    expect(() => { validateHostCapabilities(name => services[name]); }).not.toThrow()
  })

  it('apply refuses a context whose required services are absent', () => {
    const ctx = { get: () => undefined, logger: { debug: () => {} } }
    expect(() => { apply(ctx as never); }).toThrow(/sessionController/)
  })
})
