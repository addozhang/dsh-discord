/**
 * New-task admission tests (8.1): in a bound project channel, only an
 * explicit bot mention carrying non-empty text (or a supported image) admits
 * a new task; empty mentions get guidance, silent messages are ignored, and
 * unbound channels / unauthorized senders never reach admission.
 */

import { describe, expect, it } from 'vitest'

import { admitNewTask } from '../src/features/task-admission.js'

const ADMIN = { allowed: true, level: 'workspace-administrator' } as const
const MEMBER = { allowed: true, level: 'member' } as const

describe('mention-gated admission', () => {
  it('admits a mention with text in a bound channel', () => {
    const admission = admitNewTask({
      decision: MEMBER,
      isBound: true,
      channelWorkspaceId: 'ws-1',
      mentionedBot: true,
      content: 'fix the flaky test',
      hasSupportedImage: false,
    })
    expect(admission).toEqual({
      outcome: 'admit-new-task',
      workspaceId: 'ws-1',
      prompt: 'fix the flaky test',
    })
  })

  it('admits a mention with only a supported image', () => {
    const admission = admitNewTask({
      decision: MEMBER,
      isBound: true,
      channelWorkspaceId: 'ws-1',
      mentionedBot: true,
      content: '',
      hasSupportedImage: true,
    })
    expect(admission).toEqual({
      outcome: 'admit-new-task',
      workspaceId: 'ws-1',
      prompt: '',
    })
  })

  it('answers an empty mention with guidance instead of creating a session', () => {
    const admission = admitNewTask({
      decision: MEMBER,
      isBound: true,
      channelWorkspaceId: 'ws-1',
      mentionedBot: true,
      content: '   ',
      hasSupportedImage: false,
    })
    expect(admission).toEqual({ outcome: 'empty-mention', response: 'ephemeral' })
  })

  it('ignores messages without the bot mention', () => {
    const admission = admitNewTask({
      decision: MEMBER,
      isBound: true,
      channelWorkspaceId: 'ws-1',
      mentionedBot: false,
      content: 'casual chatter',
      hasSupportedImage: false,
    })
    expect(admission).toEqual({ outcome: 'ignore' })
  })

  it('defers to the unbound-channel affordance when no binding exists', () => {
    const admission = admitNewTask({
      decision: MEMBER,
      isBound: false,
      channelWorkspaceId: undefined,
      mentionedBot: true,
      content: 'hello',
      hasSupportedImage: false,
    })
    expect(admission).toEqual({ outcome: 'defer-unbound' })
  })

  it('never admits a denied sender', () => {
    for (const reason of ['denied', 'no-grant'] as const) {
      const admission = admitNewTask({
        decision: { allowed: false, reason },
        isBound: true,
        channelWorkspaceId: 'ws-1',
        mentionedBot: true,
        content: 'sneaky',
        hasSupportedImage: false,
      })
      expect(admission).toEqual({ outcome: 'ignore' })
    }
    void ADMIN
  })
})
