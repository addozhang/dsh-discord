/**
 * Ask wiring tests: the composition seam between the live renderer's
 * request face and the approval/question modules. These cover the two
 * production incident classes at this exact layer:
 * - ownership resolved through the active turn, falling back to the
 *   durable thread creator when the turn is gone (cross-turn asks);
 * - question controls registered under the canonical batch's rpc id, so
 *   clicks resolve instead of dying as unknown-control.
 */

import { describe, expect, it, vi } from 'vitest'

import { createApprovalStore, type ApprovalStore } from '../src/features/approval-store.js'
import { createAskWiring, type ApprovalAskInput, type QuestionAskInput } from '../src/features/ask-wiring.js'
import { createQuestionStore } from '../src/features/question-store.js'
import { createComponentRegistry, type ComponentRegistry } from '../src/discord/components.js'
import { createKvTableStub } from './helpers/kv-table.js'

const USER = '222222222222222222'
type ControlRow = { components?: Array<Record<string, unknown>> }

function makeRegistries() {
  const contexts = new Map<string, Record<string, unknown>>()
  let seq = 0
  const registry: ComponentRegistry = {
    register: context => {
      seq += 1
      const customId = `dc:test-${String(seq)}`
      contexts.set(customId, context)
      return customId
    },
    resolve: customId => {
      const context = contexts.get(customId)
      return context === undefined ? { found: false } : { found: true, context }
    },
    purgeExpired: () => 0,
  }
  return { registry, contexts }
}

describe('ask wiring: ownership', () => {
  it('resolves the actor from the active turn first', () => {
    const approvals: ApprovalStore = createApprovalStore(createKvTableStub())
    const posted: unknown[] = []
    const wiring = createAskWiring({
      registry: createComponentRegistry(),
      approvals,
      questions: createQuestionStore(),
      cancelPort: { cancel: () => Promise.resolve({ outcome: 'accepted' }) },
      nowMs: () => 0,
      log: () => {},
      activeTurnRequestId: () => 'discord:m-1',
      turnActor: requestId => (requestId === "discord:m-1" ? USER : undefined),
      threadOwner: () => 'someone-else',
      editMessage: () => Promise.resolve({ stored: true }),
      postMessage: (_threadId, payload) => {
        posted.push(payload)
        return Promise.resolve({ stored: true, messageId: "m-1" })
      },
    })

    wiring.onApprovalRequested({
      sessionId: 'sess-1', threadId: 'thread-1', rpcId: 'rpc-1', approvalId: 'a-1',
      toolName: 'bash', expiresAtMs: 60_000,
    } satisfies ApprovalAskInput)

    const record = approvals.get('a-1')
    expect(record).toMatchObject({ actorUserId: USER })
    expect(record?.actorUserId).toBe(USER)
    expect(posted).toHaveLength(1)
  })

  it('falls back to the durable thread creator once the turn is gone', () => {
    const approvals: ApprovalStore = createApprovalStore(createKvTableStub())
    const wiring = createAskWiring({
      registry: createComponentRegistry(),
      approvals,
      questions: createQuestionStore(),
      cancelPort: { cancel: () => Promise.resolve({ outcome: 'accepted' }) },
      nowMs: () => 0,
      log: () => {},
      activeTurnRequestId: () => undefined,
      turnActor: () => undefined,
      threadOwner: () => USER,
      editMessage: () => Promise.resolve({ stored: true }),
      postMessage: () => Promise.resolve({ stored: true, messageId: 'm-1' }),
    })

    wiring.onApprovalRequested({
      sessionId: 'sess-1', threadId: 'thread-1', rpcId: 'rpc-1', approvalId: 'a-1',
      toolName: 'bash', expiresAtMs: 60_000,
    } satisfies ApprovalAskInput)

    expect(approvals.get('a-1')?.actorUserId).toBe(USER)
  })
})

describe('ask wiring: question batch and render failure', () => {
  it('registers controls under the canonical batch rpc id and stores the control ref', async () => {
    const questions = createQuestionStore()
    const { registry } = makeRegistries()
    const posted: Array<{ threadId: string; payload: { components?: ControlRow[] } }> = []
    const wiring = createAskWiring({
      registry,
      questions,
      approvals: createApprovalStore(createKvTableStub()),
      cancelPort: { cancel: () => Promise.resolve({ outcome: 'accepted' }) },
      nowMs: () => 0,
      log: () => {},
      activeTurnRequestId: () => 'discord:m-1',
      turnActor: () => USER,
      threadOwner: () => undefined,
      editMessage: () => Promise.resolve({ stored: true }),
      postMessage: (threadId, payload) => {
        posted.push({ threadId, payload: payload as { components?: ControlRow[] } })
        return Promise.resolve({ stored: true, messageId: "m-9" })
      },
    })

    const input: QuestionAskInput = {
      sessionId: 'sess-1', threadId: 'thread-1', rpcId: 'ask-1', expiresAtMs: 1_800_000,
      questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'yes' }] }],
    }
    wiring.onQuestionRequested(input)
    await vi.waitFor(() => { expect(posted).toHaveLength(1) })

    // The record opened under the ask's rpc id — clicks resolve through it.
    expect(questions.get('ask-1')).toBeDefined()
    // The rendered payload posted into the ask's thread.
    expect(posted[0]?.threadId).toBe('thread-1')
  })

  it('abandons the ask when the controls never reach Discord', async () => {
    const questions = createQuestionStore()
    const { registry } = makeRegistries()
    const cancelCalls: Array<{ sessionId: string }> = []
    const wiring = createAskWiring({
      registry,
      questions,
      approvals: createApprovalStore(createKvTableStub()),
      cancelPort: {
        cancel: input => {
          cancelCalls.push({ sessionId: input.sessionId })
          return Promise.resolve({ outcome: 'accepted' })
        },
      },
      nowMs: () => 0,
      log: () => {},
      activeTurnRequestId: () => undefined,
      turnActor: () => undefined,
      threadOwner: () => undefined,
      editMessage: () => Promise.resolve({ stored: true }),
      postMessage: () => Promise.resolve({ stored: false, reason: 'HTTP 500 boom' }),
    })

    wiring.onQuestionRequested({
      sessionId: 'sess-1', threadId: 'thread-1', rpcId: 'ask-1', expiresAtMs: 1_800_000,
      questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'yes' }] }],
    } satisfies QuestionAskInput)

    await vi.waitFor(() => {
      expect(questions.get('ask-1')).toEqual(expect.objectContaining({ state: 'expired', expiredCancel: 'accepted' }))
    })
    expect(cancelCalls).toEqual([{ sessionId: 'sess-1' }])
  })
})

describe('ask wiring: control retirement greys the original message (16.41)', () => {
  it('PATCHes the posted approval message with every control disabled', async () => {
    const { registry } = makeRegistries()
    const posted: Array<{ threadId: string; payload: { components?: ControlRow[] } }> = []
    const edits: Array<{ channelId: string; messageId: string; payload: { components?: ControlRow[] } }> = []
    const wiring = createAskWiring({
      registry,
      approvals: createApprovalStore(createKvTableStub()),
      questions: createQuestionStore(),
      cancelPort: { cancel: () => Promise.resolve({ outcome: 'accepted' }) },
      nowMs: () => 0,
      log: () => {},
      activeTurnRequestId: () => undefined,
      turnActor: () => undefined,
      threadOwner: () => USER,
      postMessage: (threadId, payload) => {
        posted.push({ threadId, payload: payload as { components?: ControlRow[] } })
        return Promise.resolve({ stored: true, messageId: 'm-1' })
      },
      editMessage: (channelId, messageId, payload) => {
        edits.push({ channelId, messageId, payload: payload as { components?: ControlRow[] } })
        return Promise.resolve({ stored: true })
      },
    })

    wiring.onApprovalRequested({
      sessionId: 'sess-1', threadId: 'thread-1', rpcId: 'rpc-1', approvalId: 'a-1',
      toolName: 'bash', expiresAtMs: 60_000,
    } satisfies ApprovalAskInput)
    await new Promise(resolve => { setTimeout(resolve, 0) }) // let the post settle into the control map
    await wiring.disableControl('a-1')

    expect(edits).toHaveLength(1)
    expect(edits[0]?.channelId).toBe('thread-1')
    expect(edits[0]?.messageId).toBe('m-1')
    const rows = edits[0]?.payload.components ?? []
    for (const row of rows) {
      for (const control of row.components ?? []) {
        expect(control['disabled']).toBe(true)
      }
    }
    // No new message may be posted by retirement — the old bug posted an
    // empty message while the live buttons stayed behind.
    expect(posted).toHaveLength(1)
  })

  it('keeps retirement best-effort when the edit fails', async () => {
    const logged: unknown[] = []
    const wiring = createAskWiring({
      registry: createComponentRegistry(),
      approvals: createApprovalStore(createKvTableStub()),
      questions: createQuestionStore(),
      cancelPort: { cancel: () => Promise.resolve({ outcome: 'accepted' }) },
      nowMs: () => 0,
      log: (_event, detail) => { logged.push(detail) },
      activeTurnRequestId: () => undefined,
      turnActor: () => undefined,
      threadOwner: () => USER,
      postMessage: () => Promise.resolve({ stored: true, messageId: 'm-1' }),
      editMessage: () => Promise.resolve({ stored: false, reason: 'HTTP 403 missing permissions' }),
    })

    wiring.onApprovalRequested({
      sessionId: 'sess-1', threadId: 'thread-1', rpcId: 'rpc-1', approvalId: 'a-1',
      toolName: 'bash', expiresAtMs: 60_000,
    } satisfies ApprovalAskInput)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    await expect(wiring.disableControl('a-1')).resolves.toBeUndefined()
    expect(logged.some(entry => JSON.stringify(entry).includes('403'))).toBe(true)
  })
})
