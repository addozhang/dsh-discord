import { describe, expect, it, vi } from 'vitest'

import { apply, name } from '../src/index.js'

function fakeHostContext() {
  return {
    inject: vi.fn(),
    logger: { debug: vi.fn() },
    get: (serviceName: string) => ({
      apiProxy: { sessions: {}, workspace: {}, events: {}, host: {} },
      credentials: { resolve: () => {}, describe: () => {}, set: () => {}, unset: () => {} },
      settings: { register: () => {} },
      storageDomain: { open: () => {} },
      connection: { rpc: { handle: () => () => {} } },
    })[serviceName],
    effect: vi.fn(),
  }
}

describe('package scaffold', () => {
  it('exports the stable Cordis plugin identity', () => {
    expect(name).toBe('dsh-discord')
  })

  it('installs the settings boundary through the Cordis context', () => {
    const ctx = fakeHostContext()
    apply(ctx as never)
    expect(ctx.inject).toHaveBeenCalledWith(['settings'], expect.any(Function))
  })
})

