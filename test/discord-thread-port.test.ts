/**
 * The REST-backed DiscordThreadPort (Phase 1 wiring): thread creation
 * anchored to the source message, plus the deterministic crash-recovery
 * lookup that matches a thread by its durable first message. Every Discord
 * outcome maps onto the port's three states; nothing is retried here.
 */

import { describe, expect, it } from 'vitest'

import { createRestThreadPort, type ScriptedRoute, type ThreadPortRest } from '../src/discord/thread-port.js'

function createRest(scripted: ScriptedRoute[]): {
  rest: ThreadPortRest
  requests: Array<{ method: string; path: string; body?: unknown }>
} {
  const requests: Array<{ method: string; path: string; body?: unknown }> = []
  const rest = {
    request(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
      requests.push({ method, path, body })
      const scriptedResponse = scripted.shift()
      if (scriptedResponse === undefined) return Promise.reject(new Error(`test bug: no scripted route for ${method} ${path}`))
      if (scriptedResponse.outcome === 'completed') {
        return Promise.resolve({ outcome: 'completed', status: scriptedResponse.status ?? 200, body: scriptedResponse.body })
      }
      if (scriptedResponse.outcome === 'rejected') {
        return Promise.resolve({ outcome: 'rejected', status: scriptedResponse.status ?? 400, error: scriptedResponse.error ?? { code: 0, message: 'no' } })
      }
      return Promise.resolve({ outcome: 'unknown', reason: scriptedResponse.reason ?? 'network-unreachable' })
    },
  }
  return { rest: rest as unknown as ThreadPortRest, requests }
}

describe('createRestThreadPort', () => {
  it('creates a public thread anchored to the source message', async () => {
    const { rest, requests } = createRest([
      { outcome: 'completed', body: { id: 'thread-9' } },
    ])
    const port = createRestThreadPort(rest)

    const created = await port.createThread({
      parentChannelId: 'chan-1',
      name: 'fix the bug',
      sourceMessageId: 'm-1',
    })

    expect(created).toEqual({ outcome: 'completed', threadId: 'thread-9' })
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/channels/chan-1/threads',
      body: { name: 'fix the bug', type: 11, message_id: 'm-1' },
    })
  })

  it('maps rejection and unknown outcomes onto failed/unknown', async () => {
    const { rest: rejectedRest } = createRest([{ outcome: 'rejected' }])
    await expect(createRestThreadPort(rejectedRest).createThread({
      parentChannelId: 'chan-1', name: 'x', sourceMessageId: 'm-1',
    })).resolves.toEqual({ outcome: 'failed' })

    const { rest: unknownRest } = createRest([{ outcome: 'unknown' }])
    await expect(createRestThreadPort(unknownRest).createThread({
      parentChannelId: 'chan-1', name: 'x', sourceMessageId: 'm-1',
    })).resolves.toEqual({ outcome: 'unknown' })
  })

  it('finds a source-anchored thread by its first message', async () => {
    const { rest, requests } = createRest([
      { outcome: 'completed', body: { threads: [{ id: 't-1' }, { id: 't-2' }] } },
      { outcome: 'completed', body: [{ id: 'other-first' }] },
      { outcome: 'completed', body: [{ id: 'm-1' }] },
    ])
    const port = createRestThreadPort(rest)

    const found = await port.findThreadBySource({ parentChannelId: 'chan-1', sourceMessageId: 'm-1' })

    expect(found).toEqual({ outcome: 'found', threadId: 't-2' })
    expect(requests[1]).toMatchObject({ method: 'GET', path: '/channels/t-1/messages?after=0&limit=1' })
    expect(requests[2]).toMatchObject({ method: 'GET', path: '/channels/t-2/messages?after=0&limit=1' })
  })

  it('reports not-found when no active thread anchors the source message', async () => {
    const { rest } = createRest([
      { outcome: 'completed', body: { threads: [{ id: 't-1' }] } },
      { outcome: 'completed', body: [{ id: 'unrelated' }] },
    ])
    await expect(createRestThreadPort(rest).findThreadBySource({
      parentChannelId: 'chan-1', sourceMessageId: 'm-404',
    })).resolves.toEqual({ outcome: 'not-found' })
  })

  it('degrades a failed thread listing to not-found (claim stays, caller decides)', async () => {
    const { rest } = createRest([{ outcome: 'unknown' }])
    await expect(createRestThreadPort(rest).findThreadBySource({
      parentChannelId: 'chan-1', sourceMessageId: 'm-1',
    })).resolves.toEqual({ outcome: 'not-found' })
  })
})

describe('thread membership', () => {
  it('PUTs the author into the thread members', async () => {
    const { rest, requests } = createRest([
      { outcome: 'completed', body: {} },
    ])
    await createRestThreadPort(rest).joinThread({ threadId: 't-1', userId: 'u-9' })
    expect(requests[0]).toMatchObject({
      method: 'PUT',
      path: '/channels/t-1/thread-members/u-9',
    })
  })
})
