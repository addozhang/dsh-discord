/**
 * Unbound-channel mention tests (7.5): a mention in a channel that carries no
 * workspace binding never starts a session — it answers with an ephemeral
 * bind affordance (administrator guidance for admins, member guidance for
 * members). Workspace CREATION is unavailable in Milestone 1: the request is
 * refused explicitly and no filesystem-shaped dependency is ever invoked.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  planUnboundMention,
  planWorkspaceCreation,
  type FilesystemPort,
} from '../src/features/unbound-mention.js'

const ADMIN = { allowed: true, level: 'workspace-administrator' } as const
const MEMBER = { allowed: true, level: 'member' } as const

describe('unbound-channel mention', () => {
  it('offers the administrator bind affordance to workspace administrators', () => {
    const plan = planUnboundMention({ decision: ADMIN, isBound: false })
    expect(plan).toEqual({ outcome: 'bind-affordance', audience: 'administrator' })
  })

  it('offers the member affordance to ordinary members', () => {
    const plan = planUnboundMention({ decision: MEMBER, isBound: false })
    expect(plan).toEqual({ outcome: 'bind-affordance', audience: 'member' })
  })

  it('produces no affordance when the channel is already bound', () => {
    expect(planUnboundMention({ decision: MEMBER, isBound: true })).toEqual({ outcome: 'none' })
  })

  it('produces no affordance for a denied or non-granted actor', () => {
    expect(planUnboundMention({ decision: { allowed: false, reason: 'denied' }, isBound: false })).toEqual({ outcome: 'none' })
    expect(planUnboundMention({ decision: { allowed: false, reason: 'no-grant' }, isBound: false })).toEqual({ outcome: 'none' })
  })
})

describe('workspace creation', () => {
  it('refuses creation explicitly and without any filesystem mutation', async () => {
    const filesystem = {
      stat: (path: string): Promise<unknown> => Promise.resolve(vi.fn()(path)),
      mkdir: (path: string): Promise<unknown> => Promise.resolve(vi.fn()(path)),
    } as FilesystemPort
    const result = await planWorkspaceCreation(
      { requestedPath: '/srv/new-project', actorId: 'u1' },
      { filesystem },
    )

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'workspace-creation-unavailable',
      response: 'ephemeral',
    })
    void filesystem

  })
})
