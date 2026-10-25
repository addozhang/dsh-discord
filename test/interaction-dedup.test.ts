/**
 * Interaction redelivery dedup (review C-4). Discord redelivers component
 * interactions across gateway resume/reconnect; the ask stores are
 * claim-idempotent, but the one-shot flows (guild-forget, permission
 * confirm, model cascade, bind commit) are not — a redelivery re-executed
 * them. The router fences by interaction id: one execution per id, ever.
 */

import { describe, expect, it, vi } from 'vitest'

import { createComponentRegistry } from '../src/discord/components.js'
import { createInteractionRouter } from '../src/features/interaction-router.js'
import { createCopy } from '../src/i18n.js'
import type { NormalizedInteraction } from '../src/gateway/inbound.js'

const GUILD = '310000000000000001'
const ACTOR = '100000000000000001'

function forgetEvent(interactionId: string): NormalizedInteraction {
  return {
    kind: 'interaction',
    interactionId,
    interactionType: 3,
    guildId: GUILD,
    channelId: '320000000000000001',
    actorId: ACTOR,
    roleIds: [],
    memberPermissions: '8',
    componentMessageId: '330000000000000001',
    selectValues: [],
    modalFields: [],
    isBot: false,
    commandName: '',
    data: {},
  }
}

function createHarness() {
  const registry = createComponentRegistry()
  const forgetGuild = vi.fn(() => Promise.resolve())
  const rest = {
    request: vi.fn(() => Promise.resolve({ outcome: 'completed' as const, status: 200, body: {} })),
  }
  const deps = {
    policy: () => ({
      allowedGuildIds: [GUILD],
      memberUserIds: [ACTOR],
      memberRoleIds: [],
      administratorUserIds: [],
      administratorRoleIds: [],
      deniedUserIds: [],
      deniedRoleIds: [],
      hostOperatorUserIds: [ACTOR],
    }),
    applicationId: () => 'app-1',
    registry,
    copy: createCopy('zh'),
    forgetGuild,
    adapterVersion: () => "test",
    adapterStatus: () => "connected",
    componentFollowUp: vi.fn(async () => {}),
    disableControl: vi.fn(async () => {}),
    rest: () => Promise.resolve(rest),
    log: () => {},
  } as unknown as Parameters<typeof createInteractionRouter>[0]
  return { registry, forgetGuild,
    adapterVersion: () => "test",
    adapterStatus: () => "connected", router: createInteractionRouter(deps) }
}

describe('interaction redelivery dedup', () => {
  it('executes a one-shot component exactly once per interaction id', async () => {
    const h = createHarness()
    const confirmId = h.registry.register({
      kind: 'guild-forget',
      action: 'confirm',
      guildId: GUILD,
      actorId: ACTOR,
      expiresAtMs: Date.now() + 60_000,
    })
    const first = forgetEvent('990000000000000001')
    first.data['custom_id'] = confirmId
    const redelivery = { ...first }

    await h.router.route(first, 'token-a')
    await h.router.route(redelivery, 'token-a')

    expect(h.forgetGuild).toHaveBeenCalledTimes(1)
    expect(h.forgetGuild).toHaveBeenCalledWith(GUILD)
  })

  it('still serves distinct interactions of the same control', async () => {
    const h = createHarness()
    const confirmId = h.registry.register({
      kind: 'guild-forget',
      action: 'confirm',
      guildId: GUILD,
      actorId: ACTOR,
      expiresAtMs: Date.now() + 60_000,
    })
    const one = forgetEvent('990000000000000002')
    ;one.data['custom_id'] = confirmId
    const two = forgetEvent('990000000000000003')
    two.data['custom_id'] = confirmId

    await h.router.route(one, 'token-b')
    await h.router.route(two, 'token-c')

    expect(h.forgetGuild).toHaveBeenCalledTimes(2)
  })
})
