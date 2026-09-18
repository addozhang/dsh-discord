/**
 * The ask-service patch carrier (host-asks.ts). Contract under test:
 * thread-bound sessions' asks are claimed (rendered through ask-wiring,
 * settled by the settle ports, cancelled on abort); unbound sessions pass
 * through to the original service entries untouched; dispose() restores
 * both originals and cancels pending asks.
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

function fakeApprovalService() {
  const service = {
    request(req: HostApprovalRequest): Promise<HostApprovalOutcome> {
      calls.push(req)
      return Promise.resolve('unavailable')
    },
  }
  const calls: Array<HostApprovalRequest> = []
  return { service: service as HostApprovalServiceFace, calls }
}

function fakeQuestionService() {
  const service = {
    ask(req: HostQuestionRequest): Promise<HostQuestionAnswer> {
      calls.push(req)
      return Promise.resolve({ answers: [] })
    },
  }
  const calls: Array<HostQuestionRequest> = []
  return { service: service as HostQuestionServiceFace, calls }
}

function fakeDeps(threads: Record<string, string> = { 'sess-1': 'thread-1' }) {
  const approvalAsks: Array<Record<string, unknown>> = []
  const questionAsks: Array<Record<string, unknown>> = []
  const disabled: string[] = []
  return {
    deps: {
      threadForSession: (sessionId: string) => threads[sessionId],
      askWiring: {
        onApprovalRequested: (input: Record<string, unknown>) => { approvalAsks.push(input) },
        onQuestionRequested: (input: Record<string, unknown>) => { questionAsks.push(input) },
        disableControl: (key: string) => { disabled.push(key); return Promise.resolve() },
      },
      approvalTimeoutMs: () => 60_000,
      questionTimeoutMs: () => 60_000,
      nowMs: () => 1_000,
      log: () => {},
    },
    approvalAsks,
    questionAsks,
    disabled,
  }
}

describe('installAskServicePatches', () => {
  it('claims a thread-bound approval ask and settles by approvalId', async () => {
    const { service, calls } = fakeApprovalService()
    const { deps, approvalAsks } = fakeDeps()
    const patch = installAskServicePatches(service, undefined, deps)

    const decision = service.request({ agent: { id: 'sess-1' }, toolName: 'Bash', reason: 'rm -rf' })
    expect(calls).toHaveLength(0) // never passed through
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
    const { service } = fakeApprovalService()
    const { deps } = fakeDeps()
    installAskServicePatches(service, undefined, deps)
    const controller = new AbortController()
    const decision = service.request({ agent: { id: 'sess-1' }, signal: controller.signal })
    controller.abort()
    await expect(decision).resolves.toBe('cancelled')
  })

  it('settles an ask whose signal was already aborted before the claim', async () => {
    const { service } = fakeApprovalService()
    const { deps } = fakeDeps()
    installAskServicePatches(service, undefined, deps)
    const controller = new AbortController()
    controller.abort()
    await expect(service.request({ agent: { id: 'sess-1' }, signal: controller.signal })).resolves.toBe('cancelled')
  })

  it('claims a thread-bound question ask and settles with the answer batch', async () => {
    const approval = fakeApprovalService()
    const { service, calls } = fakeQuestionService()
    const { deps, questionAsks } = fakeDeps()
    const patch = installAskServicePatches(approval.service, service, deps)

    const answer = service.ask({ agent: { id: 'sess-1' }, questions: [{ id: 'q1', question: 'Which?' }] })
    expect(calls).toHaveLength(0)
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
    const { service, calls } = fakeApprovalService()
    const { deps } = fakeDeps()
    const patch = installAskServicePatches(service, undefined, deps)
    const decision = service.request({ agent: { id: 'sess-1' } })
    patch.dispose()
    await expect(decision).resolves.toBe('cancelled')
    // The restored entry passes through again.
    await expect(service.request({ agent: { id: 'sess-1' } })).resolves.toBe('unavailable')
    expect(calls).toHaveLength(1)
    expect(patch.settleApproval('whatever', 'rejected')).toBe(false)
  })
})
