/**
 * Composition root tests (review C1): the assembled runtime actually
 * connects, dispatches authorized events into business flow, submits
 * mention-prompts through DSH, stays silent for unauthorized traffic, and
 * tears down cleanly. This is the test that would have caught "the plugin
 * mounts a settings card and does nothing".
 */

import { describe, expect, it, vi } from 'vitest'

import { startDiscordAdapter, type CompositionDeps } from '../src/compose.js'
import type { GatewaySocket } from '../src/gateway/gateway.js'
import { createAdapterStatusTracker } from '../src/features/adapter-status.js'
import { createApprovalStore } from '../src/features/approval-store.js'
import { createQuestionStore } from '../src/features/question-store.js'

function makeSocket(url = 'wss://gateway.discord.gg/?v=10&encoding=json') {
  const sent: Array<{ op: number; d: unknown }> = []
  return {
    url,
    onopen: null,
    onmessage: null as ((data: string) => void) | null,
    onclose: null as ((code: number) => void) | null,
    onerror: null as ((error: Error) => void) | null,
    close: vi.fn(() => {}),
    terminate: vi.fn(() => {}),
    send: vi.fn((data: string) => {
      sent.push(JSON.parse(data) as { op: number; d: unknown })
    }),
  }
}

function setup(
  token: string | undefined,
  bindings: { workspaceForChannel: (id: string) => string | undefined; sessionForThread: (guildId: string, threadId: string) => string | undefined } | undefined,
  hooks: { unboundNotice?: CompositionDeps['unboundNotice'] } = {},
) {
  const socket = makeSocket()
  const admitMention = vi.fn((request: { guildId: string; channelId: string; messageId: string; workspaceId: string; prompt: string }): Promise<{ outcome: 'admitted'; threadId: string; sessionId: string }> => {
    return Promise.resolve({ outcome: 'admitted', threadId: `thread-${request.messageId}`, sessionId: 'sess-1' })
  })
  const continueInThread = vi.fn((_request: { guildId: string; threadId: string; sessionId: string; messageId: string; prompt: string }): Promise<{ outcome: 'queued' }> => {
    return Promise.resolve({ outcome: 'queued' })
  })
  const status = createAdapterStatusTracker()
  const gatewaySocketRef: { current: GatewaySocket | undefined } = { current: undefined }
  const deps: CompositionDeps = {
    tokenProvider: () => Promise.resolve(token),
    socketFactory: () => {
      const created = makeSocket()
      gatewaySocketRef.current = created
      return created
    },
    policy: () => ({
      allowedGuildIds: ['333333333333333333'],
      memberUserIds: ['555555555555555555'],
      memberRoleIds: [],
      administratorUserIds: [],
      administratorRoleIds: [],
      deniedUserIds: [],
      deniedRoleIds: [],
      hostOperatorUserIds: [],
    }),
    selfUserIdProvider: () => Promise.resolve('111111111111111111'),
    intents: 33280,
    applicationId: () => 'app-1',
    mainline: { admitMention, continueInThread },
    bindings: bindings ?? {
      workspaceForChannel: () => 'ws-1',
      sessionForThread: () => undefined,
    },
    approvals: createApprovalStore({ get: () => undefined, put: async () => {} }),
    questions: createQuestionStore(),
    status,
    ...(hooks.unboundNotice === undefined ? {} : { unboundNotice: hooks.unboundNotice }),
  }
  const runtime = startDiscordAdapter(deps)
  return { runtime, admitMention, continueInThread, status, socket, gatewaySocketRef }
}

function dispatchMessage(overrides: Record<string, unknown> = {}) {
  return {
    t: 'MESSAGE_CREATE',
    s: 2,
    op: 0,
    d: {
      id: '222222222222222222',
      guild_id: '333333333333333333',
      channel_id: '444444444444444444',
      author: { id: '555555555555555555', bot: false },
      content: '<@111111111111111111> deploy the service',
      ...overrides,
    },
  }
}

describe('composed adapter runtime', () => {
  it('starts the gateway and delivers an authorized mention into the session mainline', async () => {
    const { runtime, admitMention, gatewaySocketRef } = setup('token-abc', undefined)
    await vi.waitFor(() => { expect(gatewaySocketRef.current).toBeDefined() })

    // Complete the Gateway handshake: HELLO → (identify) → then dispatches.
    gatewaySocketRef.current?.onopen?.()
    gatewaySocketRef.current?.onmessage?.(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }))
    gatewaySocketRef.current?.onmessage?.(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: dispatchMessage().d }))

    await vi.waitFor(() => { expect(admitMention).toHaveBeenCalledTimes(1) })
    expect(admitMention.mock.calls[0]?.[0]).toEqual({
      applicationId: 'app-1',
      guildId: '333333333333333333',
      channelId: '444444444444444444',
      messageId: '222222222222222222',
      authorId: '555555555555555555',
      workspaceId: 'ws-1',
      prompt: 'deploy the service',
    })
    expect(runtime.started).toBe(true)
  })

  it('routes a message in an adapter-owned thread as a continuation without a mention', async () => {
    const { continueInThread, admitMention, gatewaySocketRef } = setup('token-abc', {
      workspaceForChannel: () => undefined,
      sessionForThread: (_guildId, threadId) => threadId === '444444444444444444' ? 'sess-9' : undefined,
    })
    await vi.waitFor(() => { expect(gatewaySocketRef.current).toBeDefined() })
    gatewaySocketRef.current?.onopen?.()
    gatewaySocketRef.current?.onmessage?.(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }))

    gatewaySocketRef.current?.onmessage?.(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: dispatchMessage({ content: 'plain follow-up, no mention' }).d }))

    await vi.waitFor(() => { expect(continueInThread).toHaveBeenCalledTimes(1) })
    expect(continueInThread.mock.calls[0]?.[0]).toEqual({
      applicationId: 'app-1',
      guildId: '333333333333333333',
      threadId: '444444444444444444',
      sessionId: 'sess-9',
      messageId: '222222222222222222',
      prompt: 'plain follow-up, no mention',
    })
    expect(admitMention).not.toHaveBeenCalled()
  })

  it('stays silent for unbound channels and unauthorized guilds', async () => {
    const { admitMention, continueInThread, gatewaySocketRef } = setup('token-abc', {
      workspaceForChannel: () => undefined,
      sessionForThread: () => undefined,
    })
    await vi.waitFor(() => { expect(gatewaySocketRef.current).toBeDefined() })
    gatewaySocketRef.current?.onopen?.()

    // Unbound channel: mention defers to the bind affordance, no DSH call.
    gatewaySocketRef.current?.onmessage?.(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: dispatchMessage().d }))
    expect(admitMention).not.toHaveBeenCalled()

    // Foreign guild: dropped at the allowlist before business routing.
    gatewaySocketRef.current?.onmessage?.(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 4, d: dispatchMessage({ guild_id: '999999999999999999' }).d }))
    expect(admitMention).not.toHaveBeenCalled()
    expect(continueInThread).not.toHaveBeenCalled()
  })

  it('answers an unbound-channel mention with a public bind affordance, never DSH', async () => {
    const unboundNotice = vi.fn((_request: { guildId: string; channelId: string; actorId: string; audience: 'administrator' | 'member' }) => {})
    const { admitMention, gatewaySocketRef } = setup('token-abc', {
      workspaceForChannel: () => undefined,
      sessionForThread: () => undefined,
    }, { unboundNotice })
    await vi.waitFor(() => { expect(gatewaySocketRef.current).toBeDefined() })
    gatewaySocketRef.current?.onopen?.()

    // Authorized member mentions the bot in an unbound channel: one public
    // bind affordance (member audience), zero DSH calls.
    gatewaySocketRef.current?.onmessage?.(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: dispatchMessage().d }))
    await vi.waitFor(() => { expect(unboundNotice).toHaveBeenCalledTimes(1) })
    expect(unboundNotice.mock.calls[0]?.[0]).toMatchObject({ channelId: '444444444444444444', audience: 'member' })
    expect(admitMention).not.toHaveBeenCalled()

    // A non-mention in the same unbound channel stays fully silent.
    gatewaySocketRef.current?.onmessage?.(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 4, d: dispatchMessage({ content: 'plain chatter' }).d }))
    expect(unboundNotice).toHaveBeenCalledTimes(1)
    expect(admitMention).not.toHaveBeenCalled()
  })

  it('fails closed offline when no bot token resolves', async () => {
    const { runtime, status, gatewaySocketRef } = setup(undefined, undefined)
    await vi.waitFor(() => { expect(runtime.startError).toBe('missing-token') })

    expect(runtime.started).toBe(false)
    expect(gatewaySocketRef.current).toBeUndefined()
    expect(status.project()).toEqual({
      token: 'unconfigured',
      connection: 'disconnected',
      hint: 'configure-token',
    })
  })

  it('tears the gateway down on dispose', async () => {
    const { runtime, gatewaySocketRef } = setup('token-abc', undefined)
    await vi.waitFor(() => { expect(gatewaySocketRef.current).toBeDefined() })

    runtime.dispose()
    const socket = gatewaySocketRef.current
    if (socket === undefined) throw new Error('gateway socket missing')
    socket.close()
  })
})
