/**
 * Adapter status RPC endpoint tests (2.3): the Host publishes the sanitized
 * status view over its plugin RPC channel, scoped to loopback browsers.
 * Unknown endpoints fail as values, cancellation is honored, and the happy
 * path returns exactly the projection — nothing more.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  createAdapterStatusRpcHandler,
  createAdapterStatusTracker,
  DISCORD_RPC_CHANNEL,
  installAdapterStatusRpc,
  STATUS_ENDPOINT,
  type ConnectionRpc,
} from '../src/features/adapter-status.js'

function setup() {
  const tracker = createAdapterStatusTracker()
  tracker.setCredential({ configured: true, writable: true })
  tracker.setGateway({ kind: 'terminal-close', code: 4004 })
  return { tracker, handler: createAdapterStatusRpcHandler(tracker) }
}

describe('adapter status rpc', () => {
  it('answers the status endpoint with the projected view', async () => {
    const { handler } = setup()

    const answer = await handler(STATUS_ENDPOINT, {}, undefined)
    expect(answer).toEqual({
      ok: true,
      value: { token: 'configured', connection: 'invalid-token', hint: 'token-rejected' },
    })
  })

  it('rejects unknown endpoints as a value, never a throw', async () => {
    const { handler } = setup()

    const answer = await handler('adapter.destroy-everything', {}, undefined)
    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.error.code).toBe('bad-request')
  })

  it('honors an already-aborted signal', async () => {
    const { handler } = setup()
    const signal = { aborted: true }

    const answer = await handler(STATUS_ENDPOINT, {}, signal)
    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.error.code).toBe('cancelled')
  })

  it('installs the handler on the plugin channel for loopback browsers', () => {
    const handle = vi.fn(() => () => undefined)
    const connection: ConnectionRpc = { rpc: { handle } }
    const tracker = createAdapterStatusTracker()

    const dispose = installAdapterStatusRpc(connection, tracker)

    expect(handle).toHaveBeenCalledWith(DISCORD_RPC_CHANNEL, expect.any(Function), { authority: 'loopback' })
    dispose()
    expect(handle.mock.calls[0]).toBeDefined()
  })

  it('exposes the channel constant the client must call', () => {
    expect(DISCORD_RPC_CHANNEL).toBe('/dsh-discord')
    expect(STATUS_ENDPOINT).toBe('adapter.status')
  })
})
