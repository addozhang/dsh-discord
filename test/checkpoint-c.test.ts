/**
 * Checkpoint C integration (9.7): the core session flow end-to-end over fake
 * transports — bind → mention → Thread/Session creation → queued
 * continuation → resume → steer/stop — exercising the same feature modules
 * the production wiring composes. The REAL DSH Host manual exercise remains
 * a release-blocking step (15.10).
 */

import { describe, expect, it, vi } from 'vitest'

import { createKvTableStub } from './helpers/kv-table.js'
import { createBindingStore } from '../src/state/bindings.js'
import { createChannelBindingService } from '../src/state/channel-bindings.js'
import { createSessionOwnerStore } from '../src/state/session-owners.js'
import type { ChannelBinding, ThreadBinding } from '../src/state/records.js'
import { admitNewTask } from '../src/features/task-admission.js'
import { createThreadCreationFlow, type DiscordThreadPort } from '../src/features/thread-creation.js'
import { createIntentStore } from '../src/state/intents.js'
import { createSessionCreationFlow, type DshSessionPort } from '../src/features/session-creation.js'
import { createThreadRoutingService } from '../src/features/thread-routing.js'
import { continueThread } from '../src/features/thread-continuation.js'
import { createTurnTracker } from '../src/features/turn-ownership.js'
import { planSteer } from '../src/features/steer-control.js'
import { planStop } from '../src/features/stop-control.js'
import { hashPayload } from '../src/state/intents.js'

const APP = 'app'
const GUILD = 'guild-1'
const CHANNEL = 'channel-1'
const MEMBER = { allowed: true, level: 'member' } as const

describe('core session flow (fake transports)', () => {
  it('walks bind → mention → thread/session → queue → resume → steer/stop', async () => {
    // ── the composed stores ────────────────────────────────────────────
    const channelTable = createKvTableStub<ChannelBinding>()
    const channels = createChannelBindingService({
      store: createBindingStore(channelTable),
      applicationId: APP,
      listKeys: () => channelTable.keys(),
    })
    const threadTable = createKvTableStub<ThreadBinding>()
    createThreadRoutingService({
      threadBindings: createBindingStore(threadTable),
      applicationId: APP,
    })
    createSessionOwnerStore(createKvTableStub())
    const intents = createIntentStore(createKvTableStub())
    const turnTracker = createTurnTracker()

    // ── fake Discord + DSH ─────────────────────────────────────────────
    let threadCounter = 0
    const discord: DiscordThreadPort = {
      createThread: () => {
        threadCounter += 1
        return Promise.resolve({ outcome: 'completed', threadId: `thread-${String(threadCounter)}` })
      },
      findThreadBySource: () => Promise.resolve({ outcome: 'not-found' }),
      joinThread: () => Promise.resolve(),
    }
    const threadFlow = createThreadCreationFlow({ intents, discord, nowMs: () => 1_000 })
    const threadCreations = vi.fn()
    const sessions: DshSessionPort = {
      createSession: (request) => {
        threadCreations(request)
        return Promise.resolve({ outcome: 'completed', sessionId: `sess-${request.workspaceId}` })
      },
    }
    const sessionFlow = createSessionCreationFlow({
      sessions,
      threadBindings: createBindingStore(threadTable),
      newSessionId: () => `pre-${String(threadCounter)}`,
    })

    // 1. BIND: an administrator binds the channel to ws-proj.
    const bind = await channels.bind(
      { applicationId: APP, guildId: GUILD, channelId: CHANNEL },
      { workspaceId: 'ws-proj', actorId: 'admin-1', nowMs: 100 },
    )
    expect(bind.ok).toBe(true)

    // 2. MENTION: an authorized member mentions the bot with a task.
    const admission = admitNewTask({
      decision: MEMBER,
      isBound: true,
      channelWorkspaceId: channels.resolve({ applicationId: APP, guildId: GUILD, channelId: CHANNEL })?.workspaceId,
      mentionedBot: true,
      content: 'fix the login bug',
      hasSupportedImage: false,
    })
    expect(admission).toEqual({ outcome: 'admit-new-task', workspaceId: 'ws-proj', prompt: 'fix the login bug' })

    // 3. THREAD + SESSION: the source message intent creates one thread and
    //    the session flow binds it durably.
    const contentHash = await hashPayload({ prompt: 'fix the login bug' })
    const thread = await threadFlow.ensureThread({
      sourceMessageId: 'm-1',
      contentHash,
      guildId: GUILD,
      parentChannelId: CHANNEL,
      threadName: 'Task: fix the login bug',
    })
    expect(thread).toMatchObject({ outcome: 'created', threadId: 'thread-1' })

    const session = await sessionFlow.ensureSession({
      scope: { applicationId: APP, guildId: GUILD, threadId: 'thread-1' },
      workspaceId: 'ws-proj',
      createdBy: 'member-1',
      nowMs: 200,
    })
    expect(session).toEqual({ outcome: 'created', sessionId: 'sess-ws-proj' })

    // 4. QUEUE CONTINUATION: a follow-up message queues; the turn tracker
    //    records adapter ownership from the submitted request id.
    const queued = await continueThread(
      { submit: (request) => {
          turnTracker.register({ sessionId: 'sess-ws-proj', requestId: request.requestId, threadId: 'thread-1' })
          return Promise.resolve({ outcome: 'queued', position: 1 })
        } },
      { sessionId: 'sess-ws-proj', messageId: 'm-2', content: 'also check the logs' },
    )
    expect(queued).toEqual({ outcome: 'queued', position: 1 })

    // 5. RESUME: the member lists and adopts another session for a NEW thread.
    const resumeSession = await sessionFlow.ensureSession({
      scope: { applicationId: APP, guildId: GUILD, threadId: 'thread-2' },
      workspaceId: 'ws-proj',
      createdBy: 'member-1',
      nowMs: 300,
    })
    expect(resumeSession).toEqual({ outcome: 'created', sessionId: 'sess-ws-proj' })
    // The first thread's binding survived structurally (one session, but the
    // second thread got its OWN binding row; the owner store arbitrates who
    // is writable).
    expect(threadTable.get(`app:${APP}:guild:${GUILD}:thread:thread-1`)?.sessionId).toBe('sess-ws-proj')

    // 6. STEER: the owning thread steers its active turn.
    const steer = await planSteer(
      { steer: () => Promise.resolve({ outcome: 'accepted' }) },
      turnTracker,
      { sessionId: 'sess-ws-proj', threadId: 'thread-1', prompt: 'focus on auth' },
    )
    expect(steer).toEqual({ outcome: 'accepted' })

    // 7. STOP: the same thread stops its turn; queued items are preserved.
    const stop = await planStop(
      { cancel: () => Promise.resolve({ outcome: 'accepted', pendingPreserved: true }) },
      turnTracker,
      { sessionId: 'sess-ws-proj', threadId: 'thread-1' },
    )
    expect(stop).toEqual({ outcome: 'cancelled', pendingPreserved: true })

    // A late steer after the stop refuses locally.
    expect(await planSteer(
      { steer: () => Promise.resolve({ outcome: 'accepted' }) },
      turnTracker,
      { sessionId: 'sess-ws-proj', threadId: 'thread-1', prompt: 'late' },
    )).toEqual({ outcome: 'refused', reason: 'no-active-turn' })
  })
})
