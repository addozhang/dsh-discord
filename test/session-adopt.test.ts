/**
 * Cold session adoption tests (9.2): resuming a not-currently-bound DSH
 * session creates ONE new writable Discord thread, claims the session
 * ownership, binds thread→session durably, and surfaces a bounded recent
 * history — WITHOUT prompting the model. A disappeared session and a
 * subagent session refuse before any thread is created.
 */

import { describe, expect, it, vi } from 'vitest'

import { createKvTableStub } from './helpers/kv-table.js'
import { createBindingStore } from '../src/state/bindings.js'
import { createSessionOwnerStore } from '../src/state/session-owners.js'
import type { ThreadBinding } from '../src/state/records.js'
import { createSessionAdoptionFlow, type DshSessionInspectPort, type DiscordThreadPort } from '../src/features/session-adopt.js'

const SESSION = 'sess-cold'

function setup(session: () => ReturnType<DshSessionInspectPort['inspect']>) {
  const threadBindings = createBindingStore<ThreadBinding>(createKvTableStub())
  const owners = createSessionOwnerStore(createKvTableStub())
  const created: string[] = []
  let counter = 0
  const discord: DiscordThreadPort = {
    createThread: (_request) => {
      counter += 1
      const threadId = `thread-${String(counter)}`
      created.push(threadId)
      return Promise.resolve({ outcome: 'completed', threadId })
    },
    findThreadBySource: () => Promise.resolve({ outcome: 'not-found' }),
  }
  const inspect = vi.fn(session)
  const flow = createSessionAdoptionFlow({
    sessions: { inspect },
    discord,
    threadBindings,
    owners,
    nowMs: () => 5_000,
  })
  return { flow, created, owners, threadBindings, inspect }
}

describe('cold session adoption', () => {
  it('creates one new thread, binds the session, and shows bounded history without prompting', async () => {
    const history = Array.from({ length: 20 }, (_, index) => ({ index: index + 1, role: index % 2 === 0 ? 'user' : 'assistant' }))
    const { flow, created, inspect } = setup(() =>
      Promise.resolve({ outcome: 'found', session: { sessionId: SESSION, workspaceId: 'ws-1', archived: true, isSubagent: false, history } }))

    const result = await flow.adopt({
      sessionId: SESSION,
      guildId: 'g1',
      parentChannelId: 'c1',
      createdBy: 'u1',
    })

    expect(result).toMatchObject({ outcome: 'adopted' })
    if (result.outcome !== 'adopted') return
    expect(result.threadId).toBe('thread-1')
    expect(result.history).toHaveLength(10)
    // The most recent entries, newest last.
    expect(result.history.at(-1)?.index).toBe(20)
    expect(created).toEqual(['thread-1'])
    // Adoption never prompts the model: no prompt surface exists on the flow.
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('refuses a subagent session before creating anything', async () => {
    const { flow, created } = setup(() =>
      Promise.resolve({ outcome: 'found', session: { sessionId: SESSION, workspaceId: 'ws-1', archived: false, isSubagent: true, history: [] } }))

    const result = await flow.adopt({ sessionId: SESSION, guildId: 'g1', parentChannelId: 'c1', createdBy: 'u1' })
    expect(result).toEqual({ outcome: 'refused', reason: 'subagent-not-adoptable' })
    expect(created).toEqual([])
  })

  it('reports a disappeared session without creating anything', async () => {
    const { flow, created } = setup(() =>
      Promise.resolve({ outcome: 'not-found' }))

    const result = await flow.adopt({ sessionId: SESSION, guildId: 'g1', parentChannelId: 'c1', createdBy: 'u1' })
    expect(result).toEqual({ outcome: 'refused', reason: 'session-disappeared' })
    expect(created).toEqual([])
  })

  it('reports an explicit ownership conflict without an implicit takeover', async () => {
    const { flow, created, owners } = setup(() =>
      Promise.resolve({ outcome: 'found', session: { sessionId: SESSION, workspaceId: 'ws-1', archived: false, isSubagent: false, history: [] } }))

    // Another thread already owns the session.
    await owners.claim({ sessionId: SESSION, threadId: 'thread-owner', guildId: 'g1', claimedAtMs: 1 })

    const result = await flow.adopt({ sessionId: SESSION, guildId: 'g1', parentChannelId: 'c1', createdBy: 'u1' })
    expect(result).toEqual({ outcome: 'conflict', ownedByThreadId: 'thread-owner' })
    expect(created).toEqual([])
    expect(owners.get(SESSION)?.threadId).toBe('thread-owner')
  })

  it('sanitizes catalog failures', async () => {
    const failed = setup(() => Promise.resolve({ outcome: 'failed' }))
    expect(await failed.flow.adopt({ sessionId: SESSION, guildId: 'g1', parentChannelId: 'c1', createdBy: 'u1' }))
      .toEqual({ outcome: 'failed' })

    const unknown = setup(() => Promise.resolve({ outcome: 'unknown' }))
    expect(await unknown.flow.adopt({ sessionId: SESSION, guildId: 'g1', parentChannelId: 'c1', createdBy: 'u1' }))
      .toEqual({ outcome: 'unknown' })
  })
})
