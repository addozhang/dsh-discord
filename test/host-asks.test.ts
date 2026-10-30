/**
 * The ask-service patch carrier (host-asks.ts). Contract under test:
 * thread-bound sessions' asks are claimed (rendered through ask-wiring,
 * settled by the settle ports, cancelled on abort) and ALSO forwarded to
 * the original entry through a relayed signal — the web surface races the
 * Discord surface and the first decisive answer wins, the loser retires.
 * Unbound sessions pass through to the original service entries untouched;
 * dispose() restores both originals and cancels pending asks.
 */

import { describe, expect, it } from 'vitest'

import {
  installAskServicePatches,
  type HostApprovalOutcome,
  type HostApprovalRequest,
  type HostApprovalServiceFace,
  type HostQuestionAnswer,
  type HostQuestionRequest,
  type HostQuestionServiceFace,
} from '../src/dsh/host-asks.js'

const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

interface ApprovalFakeOptions {
  /** Deferred mode: the original entry settles only via decide(). */
  manual?: boolean
  /** Immediate outcome for auto mode (default 'unavailable'). */
  autoOutcome?: HostApprovalOutcome
}

function fakeApprovalService(options: ApprovalFakeOptions = {}) {
  const calls: Array<HostApprovalRequest> = []
  const resolvers: Array<(outcome: HostApprovalOutcome) => void> = []
  const service = {
    request(req: HostApprovalRequest): Promise<HostApprovalOutcome> {
      calls.push(req)
      if (options.manual === true) {
        return new Promise(resolve => { resolvers.push(resolve) })
      }
      return Promise.resolve(options.autoOutcome ?? 'unavailable')
    },
  }
  return {
    service: service as HostApprovalServiceFace,
    calls,
    /** Settle the manual-mode original entry call number `index`. */
    decide(index: number, outcome: HostApprovalOutcome): void {
      const resolve = resolvers[index]
      if (resolve !== undefined) resolve(outcome)
    },
  }
}

interface QuestionFakeOptions {
  /** Deferred mode: the original entry settles only via answer(). */
  manual?: boolean
  /** Rejection code for auto mode (overrides the resolved batch). */
  rejectWithCode?: string
}

function fakeQuestionService(options: QuestionFakeOptions = {}) {
  const calls: Array<HostQuestionRequest> = []
  const resolvers: Array<(answer: HostQuestionAnswer) => void> = []
  const service = {
    ask(req: HostQuestionRequest): Promise<HostQuestionAnswer> {
      calls.push(req)
      if (options.rejectWithCode !== undefined) {
        const cause = Object.assign(new Error('no answerer accepted the request'), { code: options.rejectWithCode })
        return Promise.reject(cause)
      }
      if (options.manual === true) {
        return new Promise(resolve => { resolvers.push(resolve) })
      }
      return Promise.resolve({ answers: [] })
    },
  }
  return {
    service: service as HostQuestionServiceFace,
    calls,
    /** Settle the manual-mode original entry call number `index`. */
    answer(index: number, value: HostQuestionAnswer): void {
      const resolve = resolvers[index]
      if (resolve !== undefined) resolve(value)
    },
  }
}

function fakeDeps(threads: Record<string, string> = { 'sess-1': 'thread-1' }) {
  const approvalAsks: Array<Record<string, unknown>> = []
  const questionAsks: Array<Record<string, unknown>> = []
  const approvalResolved: Array<Record<string, unknown>> = []
  const questionResolved: Array<Record<string, unknown>> = []
  const disabled: string[] = []
  const logs: Array<{ event: string; detail?: unknown }> = []
  return {
    deps: {
      threadForSession: (sessionId: string) => threads[sessionId],
      askWiring: {
        onApprovalRequested: (input: Record<string, unknown>) => { approvalAsks.push(input) },
        onQuestionRequested: (input: Record<string, unknown>) => { questionAsks.push(input) },
        onApprovalResolved: (input: Record<string, unknown>) => { approvalResolved.push(input) },
        onQuestionResolved: (input: Record<string, unknown>) => { questionResolved.push(input) },
        disableControl: (key: string) => { disabled.push(key); return Promise.resolve() },
      },
      approvalTimeoutMs: () => 60_000,
      questionTimeoutMs: () => 60_000,
      nowMs: () => 1_000,
      log: (event: string, detail?: unknown) => { logs.push({ event, detail }) },
    },
    approvalAsks,
    questionAsks,
    approvalResolved,
    questionResolved,
    disabled,
    logs,
  }
}

describe('installAskServicePatches', () => {
  it('claims a thread-bound approval ask and settles by approvalId', async () => {
    const { service, calls } = fakeApprovalService({ manual: true })
    const { deps, approvalAsks } = fakeDeps()
    const patch = installAskServicePatches(service, undefined, deps)

    const decision = service.request({ agent: { id: 'sess-1' }, toolName: 'Bash', reason: 'rm -rf' })
    await flush()
    // Dual surface: the web entry also sees the ask, through a relayed signal.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(calls[0]?.signal?.aborted).toBe(false)
    expect(approvalAsks).toHaveLength(1)
    expect(approvalAsks[0]).toMatchObject({
      sessionId: 'sess-1',
      threadId: 'thread-1',
      toolName: 'Bash',
      reason: 'rm -rf',
      expiresAtMs: 61_000,
    })
    const approvalId = approvalAsks[0]?.['approvalId'] as string
    expect(typeof approvalId).toBe('string')

    expect(patch.settleApproval(approvalId, 'allowed-once')).toBe(true)
    await expect(decision).resolves.toBe('allowed-once')
  })

  it('passes unbound approvals through to the original entry', async () => {
    const { service, calls } = fakeApprovalService()
    const { deps } = fakeDeps({})
    installAskServicePatches(service, undefined, deps)

    await expect(service.request({ agent: { id: 'sess-x' } })).resolves.toBe('unavailable')
    expect(calls).toHaveLength(1)
  })

  it('settles an aborted approval ask as cancelled', async () => {
    const { service } = fakeApprovalService({ manual: true })
    const { deps } = fakeDeps()
    installAskServicePatches(service, undefined, deps)
    const controller = new AbortController()
    const decision = service.request({ agent: { id: 'sess-1' }, signal: controller.signal })
    controller.abort()
    await expect(decision).resolves.toBe('cancelled')
  })

  it('settles an ask whose signal was already aborted before the claim', async () => {
    const { service } = fakeApprovalService({ manual: true })
    const { deps } = fakeDeps()
    installAskServicePatches(service, undefined, deps)
    const controller = new AbortController()
    controller.abort()
    await expect(service.request({ agent: { id: 'sess-1' }, signal: controller.signal })).resolves.toBe('cancelled')
  })

  it('claims a thread-bound question ask and settles with the answer batch', async () => {
    const approval = fakeApprovalService()
    const { service, calls } = fakeQuestionService({ manual: true })
    const { deps, questionAsks } = fakeDeps()
    const patch = installAskServicePatches(approval.service, service, deps)

    const answer = service.ask({ agent: { id: 'sess-1' }, questions: [{ id: 'q1', question: 'Which?' }] })
    await flush()
    expect(calls).toHaveLength(1) // dual surface: the web entry also sees the ask
    const rpcId = questionAsks[0]?.['rpcId'] as string
    expect(patch.settleQuestion(rpcId, { answers: [{ id: 'q1', selected: ['a'] }] })).toBe(true)
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['a'] }] })
  })

  it('passes question asks with no rows or no bound thread through', async () => {
    const approval = fakeApprovalService()
    const { service, calls } = fakeQuestionService()
    const { deps } = fakeDeps()
    installAskServicePatches(approval.service, service, deps)

    await service.ask({ agent: { id: 'sess-1' }, questions: [] })
    await service.ask({ agent: { id: 'other' }, questions: [{ id: 'q' }] })
    expect(calls).toHaveLength(2)
  })

  it('dispose restores originals and cancels pending asks', async () => {
    const approval = fakeApprovalService({ manual: true })
    const { service, calls } = approval
    const { deps } = fakeDeps()
    const patch = installAskServicePatches(service, undefined, deps)
    const decision = service.request({ agent: { id: 'sess-1' } })
    patch.dispose()
    await expect(decision).resolves.toBe('cancelled')
    // The restored entry passes through again (manual fake: settle it).
    const restored = service.request({ agent: { id: 'sess-1' } })
    approval.decide(1, 'unavailable')
    await expect(restored).resolves.toBe('unavailable')
    expect(calls).toHaveLength(2)
    expect(patch.settleApproval('whatever', 'rejected')).toBe(false)
  })
})

describe('ask patches: approval-wait steering for the progress line', () => {
  it('reports claim as waiting and settle as released', async () => {
    const waits: Array<{ threadId: string; waiting: boolean }> = []
    const fake = fakeDeps()
    const deps = { ...fake.deps, onWaitState: (threadId: string, waiting: boolean) => { waits.push({ threadId, waiting }) } }
    const approval = fakeApprovalService({ manual: true })
    const questions = fakeQuestionService({ manual: true })
    const patch = installAskServicePatches(approval.service, questions.service, deps)

    const outcome = approval.service.request({ agent: { id: 'sess-1' }, toolName: 'bash' })
    await new Promise(resolve => { setTimeout(resolve, 5) })
    expect(waits).toEqual([{ threadId: 'thread-1', waiting: true }])

    patch.settleApproval(fake.approvalAsks[0] !== undefined ? String(fake.approvalAsks[0]['approvalId']) : '', 'allowed-once')
    await outcome
    await new Promise(resolve => { setTimeout(resolve, 5) })
    expect(waits).toEqual([
      { threadId: 'thread-1', waiting: true },
      { threadId: 'thread-1', waiting: false },
    ])
    patch.dispose()
  })
})

describe('dual-surface asks: the web surface races the Discord surface', () => {
  it('lets a web question answer win and retires the Discord surface', async () => {
    const approval = fakeApprovalService()
    const questions = fakeQuestionService({ manual: true })
    const fake = fakeDeps()
    const patch = installAskServicePatches(approval.service, questions.service, fake.deps)

    const answer = questions.service.ask({ agent: { id: 'sess-1' }, questions: [{ id: 'q1', question: '?' }] })
    await flush()
    const rpcId = fake.questionAsks[0]?.['rpcId'] as string

    questions.answer(0, { answers: [{ id: 'q1', selected: ['web'] }] })
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['web'] }] })

    // The Discord surface retired: remote-resolution recorded, controls disabled.
    expect(fake.questionResolved).toEqual([{ sessionId: 'sess-1', questionRpcId: rpcId, outcome: 'answered' }])
    expect(fake.disabled).toContain(rpcId)
    // A late Discord click can no longer settle the ask.
    expect(patch.settleQuestion(rpcId, { answers: [{ id: 'q1', selected: ['discord'] }] })).toBe(false)
    patch.dispose()
  })

  it('aborts the web question wait when Discord answers first', async () => {
    const approval = fakeApprovalService()
    const questions = fakeQuestionService({ manual: true })
    const fake = fakeDeps()
    const patch = installAskServicePatches(approval.service, questions.service, fake.deps)

    const answer = questions.service.ask({ agent: { id: 'sess-1' }, questions: [{ id: 'q1', question: '?' }] })
    await flush()
    const rpcId = fake.questionAsks[0]?.['rpcId'] as string

    expect(patch.settleQuestion(rpcId, { answers: [{ id: 'q1', selected: ['discord'] }] })).toBe(true)
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['discord'] }] })
    // The web wait is closed through the relayed signal.
    expect(questions.calls[0]?.signal?.aborted).toBe(true)
    // The web answer never reached the wiring (no remote resolution recorded).
    expect(fake.questionResolved).toEqual([])
    patch.dispose()
  })

  it('keeps the Discord question surface when the web side has no answerer', async () => {
    const approval = fakeApprovalService()
    const questions = fakeQuestionService({ rejectWithCode: 'NO_PROVIDER' })
    const fake = fakeDeps()
    const patch = installAskServicePatches(approval.service, questions.service, fake.deps)

    const answer = questions.service.ask({ agent: { id: 'sess-1' }, questions: [{ id: 'q1', question: '?' }] })
    await flush()
    // NO_PROVIDER is an expected absence, never surfaced as a failure.
    expect(fake.logs.some(entry => entry.event === 'discord_ask_dual_web_failed')).toBe(false)

    const rpcId = fake.questionAsks[0]?.['rpcId'] as string
    expect(patch.settleQuestion(rpcId, { answers: [{ id: 'q1', selected: ['discord'] }] })).toBe(true)
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['discord'] }] })
    patch.dispose()
  })

  it('lets a web approval decision win and retires the Discord surface', async () => {
    const approval = fakeApprovalService({ manual: true })
    const fake = fakeDeps()
    const patch = installAskServicePatches(approval.service, undefined, fake.deps)

    const decision = approval.service.request({ agent: { id: 'sess-1' }, toolName: 'Bash' })
    await flush()
    const approvalId = fake.approvalAsks[0]?.['approvalId'] as string

    approval.decide(0, 'rejected')
    await expect(decision).resolves.toBe('rejected')

    expect(fake.approvalResolved).toEqual([{ sessionId: 'sess-1', approvalId, outcome: 'rejected' }])
    expect(fake.disabled).toContain(approvalId)
    expect(patch.settleApproval(approvalId, 'allowed-once')).toBe(false)
    patch.dispose()
  })

  it('aborts the web approval wait when Discord decides first', async () => {
    const approval = fakeApprovalService({ manual: true })
    const fake = fakeDeps()
    const patch = installAskServicePatches(approval.service, undefined, fake.deps)

    const decision = approval.service.request({ agent: { id: 'sess-1' }, toolName: 'Bash' })
    await flush()
    const approvalId = fake.approvalAsks[0]?.['approvalId'] as string

    expect(patch.settleApproval(approvalId, 'allowed-once')).toBe(true)
    await expect(decision).resolves.toBe('allowed-once')
    expect(approval.calls[0]?.signal?.aborted).toBe(true)
    expect(fake.approvalResolved).toEqual([])
    patch.dispose()
  })

  it('ignores indifferent web approval outcomes and keeps the Discord surface', async () => {
    for (const outcome of ['unavailable', 'cancelled'] as const) {
      const approval = fakeApprovalService({ autoOutcome: outcome })
      const fake = fakeDeps()
      const patch = installAskServicePatches(approval.service, undefined, fake.deps)

      const decision = approval.service.request({ agent: { id: 'sess-1' }, toolName: 'Bash' })
      await flush()
      const approvalId = fake.approvalAsks[0]?.['approvalId'] as string
      expect(fake.approvalResolved).toEqual([])

      expect(patch.settleApproval(approvalId, 'allowed-once')).toBe(true)
      await expect(decision).resolves.toBe('allowed-once')
      patch.dispose()
    }
  })

  it('dispose closes open web waits', async () => {
    const approval = fakeApprovalService({ manual: true })
    const questions = fakeQuestionService({ manual: true })
    const fake = fakeDeps()
    const patch = installAskServicePatches(approval.service, questions.service, fake.deps)

    void questions.service.ask({ agent: { id: 'sess-1' }, questions: [{ id: 'q1', question: '?' }] })
    await flush()
    patch.dispose()
    expect(questions.calls[0]?.signal?.aborted).toBe(true)
  })
})
