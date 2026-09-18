/**
 * The 0.1.6 ask carrier. The composed-answerer waterfalls dispatch inside
 * the base tree's context chain, and no registration surface reachable from
 * an external plugin (own-tree listeners, global hooks, the shared events
 * service, a bridge plugin on the approval service's own context) is
 * enumerated by that dispatch — only in-tree plugins like the web
 * forwarder receive it (verified empirically on the real host,
 * 2026-09-18). The supported reach for an adapter is therefore the service
 * boundary: this module wraps `ApprovalService.request` and
 * `UserQuestionService.ask`, and for sessions bound to a Discord thread
 * renders the ask through the adapter's ask-wiring (buttons, ownership,
 * expiry) and resolves with the user's answer; every other ask passes
 * through to the original path (the web UI keeps working unchanged).
 */

/** Narrow approval-request shape the service receives. */
export interface HostApprovalRequest {
  agent?: { id?: string } | undefined
  toolName?: string
  callId?: string
  reason?: string
  signal?: AbortSignal
}

/** Narrow user-question request shape the service receives. */
export interface HostQuestionRequest {
  agent?: { id?: string } | undefined
  questions?: ReadonlyArray<Record<string, unknown>>
  signal?: AbortSignal
}

/** The approval outcome vocabulary the service normalizes onto. */
export type HostApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** The answer payload the questions service resolves with. */
export interface HostQuestionAnswer {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
}

/** Narrow approval-service face: the public ask entry we wrap. */
export interface HostApprovalServiceFace {
  request(req: HostApprovalRequest): Promise<HostApprovalOutcome>
}

/** Narrow user-questions-service face: the public ask entry we wrap. */
export interface HostQuestionServiceFace {
  ask(req: HostQuestionRequest): Promise<HostQuestionAnswer>
}

export interface HostAskDeps {
  threadForSession(sessionId: string): string | undefined
  askWiring: {
    onApprovalRequested(input: {
      sessionId: string
      threadId: string
      rpcId: string
      approvalId: string
      toolName: string
      reason?: string | undefined
      expiresAtMs: number
    }): void
    onQuestionRequested(input: {
      sessionId: string
      threadId: string
      rpcId: string
      expiresAtMs: number
      questions: ReadonlyArray<Record<string, unknown>>
    }): void
    disableControl(key: string): Promise<void>
  }
  approvalTimeoutMs(): number
  questionTimeoutMs(): number
  nowMs(): number
  log(event: string, detail?: unknown): void
}

/** One claimed ask: a settle promise raced against the ask's abort signal. */
class PendingAsk<T> {
  private settle: (value: T) => void = () => {}
  readonly promise: Promise<T>
  private readonly cancel: () => void

  constructor(private readonly owner: Map<string, PendingAsk<T>>, private readonly key: string, signal: AbortSignal | undefined, cancelled: () => T) {
    this.promise = new Promise<T>(resolve => {
      this.settle = value => {
        if (this.owner.get(this.key) !== this) return
        this.owner.delete(this.key)
        resolve(value)
      }
    })
    this.cancel = () => { this.settle(cancelled()) }
    signal?.addEventListener('abort', this.cancel, { once: true })
    // An already-aborted signal never fires its 'abort' event: settle now or
    // the claim would hang past the host's own cancellation.
    if (signal?.aborted === true) this.cancel()
  }

  /** Resolve the ask; a no-op when it already settled. */
  resolve(value: T): boolean {
    if (this.owner.get(this.key) !== this) return false
    this.settle(value)
    return true
  }

  dispose(): void {
    this.cancel()
  }
}

/**
 * Wrap both ask services. Thread-bound sessions get the Discord ask flow;
 * everything else passes through untouched. Returns the settle ports the
 * click pipeline answers through, plus a dispose() the plugin teardown
 * calls to restore the original entries.
 */
export function installAskServicePatches(
  approval: HostApprovalServiceFace,
  questions: HostQuestionServiceFace | undefined,
  deps: HostAskDeps,
): {
  /** Settle one claimed approval ask; false when no pending ask owns the id. */
  settleApproval(approvalId: string, outcome: HostApprovalOutcome): boolean
  /** Settle one claimed question ask; false when no pending ask owns the id. */
  settleQuestion(rpcId: string, answer: HostQuestionAnswer): boolean
  /** Restore both services to their original entries. */
  dispose(): void
} {
  const pendingApprovals = new Map<string, PendingAsk<HostApprovalOutcome>>()
  const pendingQuestions = new Map<string, PendingAsk<HostQuestionAnswer>>()

  // Capture the current entries (own or prototype) before patching; dispose
  // restores exactly these.
  const originalRequest = approval.request.bind(approval)
  const originalAsk = questions !== undefined ? questions.ask.bind(questions) : undefined

  const patch = {
    settleApproval(approvalId: string, outcome: HostApprovalOutcome): boolean {
      return pendingApprovals.get(approvalId)?.resolve(outcome) ?? false
    },
    settleQuestion(rpcId: string, answer: HostQuestionAnswer): boolean {
      return pendingQuestions.get(rpcId)?.resolve(answer) ?? false
    },
    dispose(): void {
      approval.request = originalRequest
      if (questions !== undefined && originalAsk !== undefined) {
        questions.ask = originalAsk
      }
      for (const [, pending] of [...pendingApprovals]) pending.dispose()
      pendingApprovals.clear()
      for (const [, pending] of [...pendingQuestions]) pending.dispose()
      pendingQuestions.clear()
    },
  }

  approval.request = async (req: HostApprovalRequest): Promise<HostApprovalOutcome> => {
    const agentId = req.agent?.id
    const sessionId = agentId !== undefined && agentId !== '' ? agentId : undefined
    const threadId = sessionId !== undefined ? deps.threadForSession(sessionId) : undefined
    if (sessionId === undefined || threadId === undefined) {
      deps.log('discord_ask_passthrough', { sessionId: sessionId ?? '', kind: 'approval' })
      return originalRequest(req)
    }
    const approvalId = crypto.randomUUID()
    deps.log('discord_approval_claimed', { approvalId, sessionId, threadId, toolName: req.toolName })
    deps.askWiring.onApprovalRequested({
      sessionId,
      threadId,
      // The settle port keys by approvalId; the rpcId field is vestigial in
      // this model (no wire echo exists).
      rpcId: approvalId,
      approvalId,
      toolName: typeof req.toolName === 'string' ? req.toolName : '',
      reason: typeof req.reason === 'string' ? req.reason : undefined,
      expiresAtMs: deps.nowMs() + deps.approvalTimeoutMs(),
    })
    const pending = new PendingAsk(pendingApprovals, approvalId, req.signal, () => 'cancelled' as const)
    pendingApprovals.set(approvalId, pending)
    if (req.signal?.aborted === true) pending.dispose()
    void pending.promise.then(() => { void deps.askWiring.disableControl(approvalId) })
    return pending.promise
  }

  if (questions !== undefined && originalAsk !== undefined) {
    questions.ask = async (req: HostQuestionRequest): Promise<HostQuestionAnswer> => {
      const agentId = req.agent?.id
      const sessionId = agentId !== undefined && agentId !== '' ? agentId : undefined
      const threadId = sessionId !== undefined ? deps.threadForSession(sessionId) : undefined
      if (sessionId === undefined || threadId === undefined) {
        deps.log('discord_ask_passthrough', { sessionId: sessionId ?? '', kind: 'question' })
        return originalAsk(req)
      }
      const rows = Array.isArray(req.questions) ? req.questions : []
      if (rows.length === 0) return originalAsk(req)
      const rpcId = crypto.randomUUID()
      deps.log('discord_question_claimed', { rpcId, sessionId, threadId, questions: rows.length })
      deps.askWiring.onQuestionRequested({
        sessionId,
        threadId,
        rpcId,
        expiresAtMs: deps.nowMs() + deps.questionTimeoutMs(),
        questions: rows,
      })
      const cancelledAnswer: HostQuestionAnswer = { answers: [] }
      const pending = new PendingAsk(pendingQuestions, rpcId, req.signal, () => cancelledAnswer)
      pendingQuestions.set(rpcId, pending)
      if (req.signal?.aborted === true) pending.dispose()
      void pending.promise.then(() => { void deps.askWiring.disableControl(rpcId) })
      return pending.promise
    }
  }

  return patch
}
