/**
 * Session creation tests (8.3): the adapter preallocates the DSH session id
 * before calling `session.create` so an uncertain response can be reconciled
 * idempotently later; success binds the thread to the session durably, and
 * any replay of an already-bound thread returns the same session without
 * calling DSH again. Rejection and unknown outcomes never leave a binding.
 */

import { describe, expect, it, vi } from 'vitest'

import { createKvTableStub } from './helpers/kv-table.js'
import { createBindingStore } from '../src/state/bindings.js'
import type { ThreadBinding } from '../src/state/records.js'
import { createSessionCreationFlow, type DshSessionPort } from '../src/features/session-creation.js'

const THREAD = 'thread-1'
const GUILD = 'g1'

function setup(createResult: () => ReturnType<DshSessionPort['createSession']>) {
  const threadBindings = createBindingStore<ThreadBinding>(createKvTableStub())
  const createSession = vi.fn((_request: { sessionId: string; workspaceId: string }): ReturnType<DshSessionPort['createSession']> => createResult())
  const sessionPort: DshSessionPort = { createSession }
  const flow = createSessionCreationFlow({
    sessions: sessionPort,
    threadBindings,
    newSessionId: () => 'preallocated-1',
  })
  return { flow, threadBindings, createSession }
}

describe('session creation flow', () => {
  it('creates a session with the preallocated id and binds the thread', async () => {
    const { flow, threadBindings, createSession } = setup(() =>
      Promise.resolve({ outcome: 'completed', sessionId: 'sess-adopted' }))

    const result = await flow.ensureSession({
      scope: { applicationId: 'app', guildId: GUILD, threadId: THREAD },
      workspaceId: 'ws-1',
      createdBy: 'u1',
      nowMs: 100,
    })

    expect(result).toMatchObject({ outcome: 'created', sessionId: 'sess-adopted' })
    const firstCall = createSession.mock.calls[0]?.[0]
    expect(firstCall).toEqual(expect.objectContaining({ sessionId: 'preallocated-1', workspaceId: 'ws-1' }))
    const binding = threadBindings.get(`app:app:guild:${GUILD}:thread:${THREAD}`)
    expect(binding).toMatchObject({ sessionId: 'sess-adopted', workspaceId: 'ws-1' })
  })

  it('returns the existing session for an already-bound thread without calling DSH', async () => {
    const { flow, threadBindings, createSession } = setup(() =>
      Promise.resolve({ outcome: 'completed', sessionId: 'sess-1' }))
    await flow.ensureSession({ scope: { applicationId: 'app', guildId: GUILD, threadId: THREAD }, workspaceId: 'ws-1', createdBy: 'u1', nowMs: 100 })
    expect(createSession.mock.calls).toHaveLength(1)

    const replay = await flow.ensureSession({ scope: { applicationId: 'app', guildId: GUILD, threadId: THREAD }, workspaceId: 'ws-OTHER', createdBy: 'u1', nowMs: 200 })
    expect(replay).toEqual({ outcome: 'created', sessionId: 'sess-1' })
    expect(createSession.mock.calls).toHaveLength(1)
    // The original workspace on the binding is untouched.
    expect(threadBindings.get(`app:app:guild:${GUILD}:thread:${THREAD}`)?.workspaceId).toBe('ws-1')
  })

  it('binds nothing when DSH rejects the creation', async () => {
    const { flow, threadBindings } = setup(() =>
      Promise.resolve({ outcome: 'rejected', reason: 'workspace-not-found' }))

    const result = await flow.ensureSession({ scope: { applicationId: 'app', guildId: GUILD, threadId: THREAD }, workspaceId: 'ws-1', createdBy: 'u1', nowMs: 100 })
    expect(result).toEqual({ outcome: 'rejected' })
    expect(threadBindings.get(`app:app:guild:${GUILD}:thread:${THREAD}`)).toBeUndefined()
  })

  it('leaves the thread unbound on an unknown outcome for reconciliation', async () => {
    const { flow, threadBindings } = setup(() =>
      Promise.resolve({ outcome: 'unknown' }))

    const result = await flow.ensureSession({ scope: { applicationId: 'app', guildId: GUILD, threadId: THREAD }, workspaceId: 'ws-1', createdBy: 'u1', nowMs: 100 })
    expect(result).toEqual({ outcome: 'unknown' })
    // No binding: the reconciler decides after checking DSH history.
    expect(threadBindings.get(`app:app:guild:${GUILD}:thread:${THREAD}`)).toBeUndefined()
  })
})
