/**
 * The REST-backed DiscordThreadPort tests (Kimaki thread model): unanchored
 * thread creation, author-impersonated opener mirroring through a reusable
 * per-thread webhook, and crash-window recovery by deterministic title.
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

const OPENER = {
  content: 'fix the login bug',
  authorName: 'Addo',
  authorAvatarUrl: 'https://cdn.discordapp.com/avatars/u-1/a.png',
}

describe('createRestThreadPort', () => {
  it('creates an unanchored thread and mirrors the opener as the author', async () => {
    const { rest, requests } = createRest([
      { outcome: 'completed', body: { id: 'thread-9' } },           // create thread
      { outcome: 'completed', body: [] },                           // list webhooks (none)
      { outcome: 'completed', body: { id: 'wh-1', token: 'tok' } }, // create webhook
      { outcome: 'completed', body: { id: 'msg-1' } },              // execute webhook
    ])
    const created = await createRestThreadPort(rest).createThread({
      parentChannelId: 'chan-1',
      name: 'fix the login bug',
      opener: OPENER,
    })

    expect(created).toEqual({ outcome: 'completed', threadId: 'thread-9' })
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/channels/chan-1/threads',
      body: { name: 'fix the login bug', type: 11 },
    })
    expect(requests[1]).toMatchObject({ method: 'GET', path: '/channels/thread-9/webhooks' })
    expect(requests[2]).toMatchObject({ method: 'POST', path: '/channels/thread-9/webhooks' })
    expect(requests[3]).toMatchObject({ method: 'POST', path: '/webhooks/wh-1/tok?wait=true' })
    expect(requests[3]?.body).toMatchObject({
      content: 'fix the login bug',
      username: 'Addo',
      avatar_url: 'https://cdn.discordapp.com/avatars/u-1/a.png',
    })
    // Mirrored user content never pings.
    expect((requests[3]?.body as { flags?: number }).flags).toBe(1 << 12)
  })

  it('reuses an existing opener webhook instead of creating another', async () => {
    const { rest, requests } = createRest([
      { outcome: 'completed', body: { id: 'thread-9' } },
      { outcome: 'completed', body: [{ id: 'wh-existing', token: 'tok-9', name: 'dsh-discord' }] },
      { outcome: 'completed', body: { id: 'msg-1' } },
    ])
    await createRestThreadPort(rest).createThread({ parentChannelId: 'chan-1', name: 'x', opener: OPENER })
    expect(requests).toHaveLength(3)
    expect(requests[2]).toMatchObject({ method: 'POST', path: '/webhooks/wh-existing/tok-9?wait=true' })
  })

  it('still completes the thread when the opener mirror fails', async () => {
    const { rest } = createRest([
      { outcome: 'completed', body: { id: 'thread-9' } },
      { outcome: 'rejected', status: 403 }, // webhook listing forbidden
      { outcome: 'rejected', status: 403 }, // webhook creation forbidden
    ])
    await expect(createRestThreadPort(rest).createThread({ parentChannelId: 'chan-1', name: 'x', opener: OPENER }))
      .resolves.toEqual({ outcome: 'completed', threadId: 'thread-9' })
  })

  it('maps thread-creation rejection and unknown onto failed/unknown', async () => {
    const { rest: rejectedRest } = createRest([{ outcome: 'rejected' }])
    await expect(createRestThreadPort(rejectedRest).createThread({ parentChannelId: 'chan-1', name: 'x', opener: OPENER }))
      .resolves.toEqual({ outcome: 'failed' })

    const { rest: unknownRest } = createRest([{ outcome: 'unknown' }])
    await expect(createRestThreadPort(unknownRest).createThread({ parentChannelId: 'chan-1', name: 'x', opener: OPENER }))
      .resolves.toEqual({ outcome: 'unknown' })
  })

  it('finds the task thread by its deterministic title', async () => {
    const { rest, requests } = createRest([
      { outcome: 'completed', body: { threads: [{ id: 't-1', name: 'other' }, { id: 't-2', name: 'fix the login bug' }] } },
    ])
    const found = await createRestThreadPort(rest).findThreadBySource({ parentChannelId: 'chan-1', threadName: 'fix the login bug' })

    expect(found).toEqual({ outcome: 'found', threadId: 't-2' })
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/channels/chan-1/threads/active' })
  })

  it('reports not-found when no active thread carries the title', async () => {
    const { rest } = createRest([
      { outcome: 'completed', body: { threads: [{ id: 't-1', name: 'other' }] } },
    ])
    await expect(createRestThreadPort(rest).findThreadBySource({ parentChannelId: 'chan-1', threadName: 'missing' }))
      .resolves.toEqual({ outcome: 'not-found' })
  })

  it('degrades a failed thread listing to not-found (claim stays, caller decides)', async () => {
    const { rest } = createRest([{ outcome: 'unknown' }])
    await expect(createRestThreadPort(rest).findThreadBySource({ parentChannelId: 'chan-1', threadName: 'x' }))
      .resolves.toEqual({ outcome: 'not-found' })
  })
})
