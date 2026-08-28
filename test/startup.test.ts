/**
 * Startup capability boundary tests: the adapter activates only when every
 * required DSH Host service is present and satisfies its minimum contract,
 * and fails loud with an actionable diagnostic naming every gap.
 */

import { describe, expect, it } from 'vitest'

import { REQUIRED_HOST_SERVICES, validateHostCapabilities } from '../src/startup.js'
import { apply } from '../src/index.js'

function validServices(): Record<string, unknown> {
  return {
    apiProxy: { sessions: {}, workspace: {}, events: {}, host: {} },
    credentials: { resolve: () => {}, describe: () => {}, set: () => {}, unset: () => {} },
    settings: { register: () => {} },
    storageDomain: { open: () => {} },
    connection: { rpc: { handle: () => () => {} } },
  }
}

describe('host capability boundary', () => {
  it('declares exactly the required Host service roster', () => {
    expect([...REQUIRED_HOST_SERVICES]).toEqual([
      'apiProxy',
      'credentials',
      'settings',
      'storageDomain',
      'connection',
    ])
  })

  it('fails loud naming every missing capability at once', () => {
    const services: Record<string, unknown> = {}
    expect(() => { validateHostCapabilities(name => services[name]); }).toThrow(/apiProxy.*storageDomain|storageDomain.*apiProxy/s)
    expect(() => { validateHostCapabilities(name => services[name]); }).toThrow(/dsh web/)
  })

  it('fails loud naming the contract members an incompatible service lacks', () => {
    const services = validServices()
    services.apiProxy = { sessions: {} }
    services.credentials = { resolve: () => {} }
    try {
      validateHostCapabilities(name => services[name])
      expect.unreachable()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('apiProxy')
      expect(message).toContain('workspace')
      expect(message).toContain('events')
      expect(message).toContain('credentials')
      expect(message).toContain('describe')
    }
  })

  it('activates when every capability satisfies its contract', () => {
    const services = validServices()
    expect(() => { validateHostCapabilities(name => services[name]); }).not.toThrow()
  })

  it('apply refuses a context whose required services are absent', () => {
    const ctx = { get: () => undefined, logger: { debug: () => {} } }
    expect(() => { apply(ctx as never); }).toThrow(/apiProxy/)
  })
})
