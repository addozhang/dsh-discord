/**
 * Adapter status RPC endpoint tests (2.3): the Host publishes the sanitized
 * status view over its plugin RPC channel, scoped to loopback browsers.
 * Unknown endpoints fail as values, cancellation is honored, and the happy
 * path returns exactly the projection — nothing more.
 */

import { describe, expect, it } from 'vitest'

import {
  createAdapterStatusRpcHandler,
  createAdapterStatusTracker,
  DISCORD_RPC_CHANNEL,
  installAdapterStatusRpc,
  STATUS_ENDPOINT,
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

  it('installs a prefix route on the webServer through the plugin effect', () => {
    const registered: Array<{ kind: string; path: string; handler: unknown }> = []
    const webServer = { register: (route: { kind: string; path: string; handler: unknown }) => { registered.push(route); return () => undefined } }
    const connection = { requestRejection: () => undefined }
    const ctx = {
      get: (name: string) => ({ webServer, connection })[name],
      effect: (execute: () => unknown) => execute() as () => void,
    }
    const tracker = createAdapterStatusTracker()

    const dispose = installAdapterStatusRpc(ctx, tracker)

    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ kind: 'prefix', path: DISCORD_RPC_CHANNEL })
    expect(typeof registered[0]?.handler).toBe('function')
    dispose()
  })

  it('serves the channel protocol: fence, envelope, and method match', async () => {
    let routeHandler: ((req: unknown, res: unknown) => Promise<void>) | undefined
    const webServer = { register: (route: { handler: (req: unknown, res: unknown) => Promise<void> }) => { routeHandler = route.handler; return () => undefined } }
    let verdict: number | undefined
    const connection = { requestRejection: () => verdict }
    const ctx = { get: (name: string) => ({ webServer, connection })[name], effect: (execute: () => unknown) => execute() as () => void }
    installAdapterStatusRpc(ctx, createAdapterStatusTracker())

    const makeRes = () => {
      const state: { status?: number; body?: string; headers?: Record<string, string> } = {}
      return {
        state,
        writeHead(status: number, headers?: Record<string, string>) { state.status = status; if (headers !== undefined) state.headers = headers },
        end(body: string) { state.body = body },
      }
    }
    const makeReq = (body: string, method = 'POST', url = `${DISCORD_RPC_CHANNEL}/${STATUS_ENDPOINT}`) => ({
      method,
      url,
      headers: { 'content-type': 'application/json' },
      on(event: string, listener: (arg?: unknown) => void) {
        if (event === 'data') listener(Buffer.from(body))
        if (event === 'end') listener()
      },
    })

    // The fence rejects before anything else runs.
    verdict = 401
    let res = makeRes()
    await routeHandler?.(makeReq('{}'), res)
    expect(res.state.status).toBe(401)

    // An admitted status call answers the server-response envelope.
    verdict = undefined
    res = makeRes()
    await routeHandler?.(makeReq(JSON.stringify({ type: 'client-request', rpcId: 'r-1', method: STATUS_ENDPOINT, payload: {} })), res)
    expect(res.state.status).toBe(200)
    const envelope = JSON.parse(res.state.body ?? '') as { type: string; rpcId: string; result: { ok: boolean } }
    expect(envelope).toMatchObject({ type: 'server-response', rpcId: 'r-1' })
    expect(envelope.result.ok).toBe(true)

    // A method/endpoint mismatch is a wire-level bad request.
    res = makeRes()
    await routeHandler?.(makeReq(JSON.stringify({ type: 'client-request', rpcId: 'r-2', method: 'other.thing', payload: {} })), res)
    const mismatch = JSON.parse(res.state.body ?? '') as { result: { ok: boolean; error: { code: string } } }
    expect(mismatch.result.ok).toBe(false)
    expect(mismatch.result.error.code).toBe('gateway/bad-request')
  })

  it('exposes the channel constant the client must call', () => {
    expect(DISCORD_RPC_CHANNEL).toBe('/dsh-discord')
    expect(STATUS_ENDPOINT).toBe('adapter.status')
  })
})
