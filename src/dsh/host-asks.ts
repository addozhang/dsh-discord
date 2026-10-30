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
 *
 * Dual surface (16.105, 2026-10-30): a claimed ask is ALSO forwarded to
 * the original entry under a relayed abort signal, so a connected web
 * client renders the same card. The two surfaces race and the first
 * decisive answer wins: a web answer settles the claimed ask and retires
 * the Discord controls; a Discord answer aborts the relay and the web wait
 * closes. The pre-binding passthrough direction stays single-surface (the
 * 2026-10-26 decision on issue #11 — status quo).
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
    /** Record a web-surface resolution and retire the Discord controls. */
    onApprovalResolved(input: { sessionId: string; approvalId: string; outcome?: string | undefined }): void
    /** Record a web-surface resolution and retire the Discord controls. */
    onQuestionResolved(input: { sessionId: string; questionRpcId: string; outcome: 'answered' | 'cancelled' }): void
  }
  approvalTimeoutMs(): number
  questionTimeoutMs(): number
  nowMs(): number
  log(event: string, detail?: unknown): void
  /**
   * Claim/settle steering for the live progress line (turn-progress spec):
   * called with `true` when a thread-bound ask is claimed, `false` when it
   * settles (answered, cancelled, or expired).
   */
  onWaitState?(threadId: string, waiting: boolean): void
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
 * Relays the host's abort signal into an owned controller so the losing
 * ask surface's wait can be closed independently: the web leg receives
 * `relay.signal` instead of the host's own signal, and a Discord answer
 * aborts it to settle the web card without touching the host's signal.
 */
class SignalRelay {
  private readonly controller = new AbortController()

  constructor(source: AbortSignal | undefined) {
    if (source === undefined) return
    if (source.aborted) {
      this.controller.abort(source.reason)
      return
    }
    source.addEventListener('abort', () => { this.controller.abort(source.reason) }, { once: true })
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Close the relayed wait (a no-op when the source signal already did). */
  abort(reason?: unknown): void {
    this.controller.abort(reason)
  }
}

/** The question waterfall's "no connected answerer" rejection shape. */
function isNoProvider(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null
    && (cause as { code?: unknown }).code === 'NO_PROVIDER'
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
  /** Live web-surface waits for claimed asks, keyed by ask id. */
  const webRelays = new Map<string, SignalRelay>()

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
      // Close every live web wait before cancelling the Discord surface:
      // the relayed abort lets the original entries settle their cards.
      for (const [, relay] of [...webRelays]) relay.abort()
      webRelays.clear()
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
    deps.onWaitState?.(threadId, true)
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
    // Dual surface (16.105): the web surface races the Discord buttons
    // through the original entry under a relayed signal. The first
    // decisive outcome wins; 'unavailable' (no connected answerer, or an
    // answerer failure the host normalizes fail-closed) and 'cancelled'
    // (an abort racing the decision) never decide for the user.
    const relay = new SignalRelay(req.signal)
    webRelays.set(approvalId, relay)
    void Promise.resolve()
      .then(() => originalRequest({ ...req, signal: relay.signal }))
      .then(outcome => {
        if (outcome !== 'allowed-once' && outcome !== 'rejected') {
          deps.log('discord_ask_dual_web_ignored', { kind: 'approval', approvalId, outcome })
          return
        }
        if (!pending.resolve(outcome)) return
        deps.log('discord_ask_dual_web_won', { kind: 'approval', approvalId, outcome })
        deps.askWiring.onApprovalResolved({ sessionId, approvalId, outcome })
      })
      .catch((cause: unknown) => {
        // The real entry normalizes answerer failures to 'unavailable';
        // a rejection here means the relay closed the wait (the Discord
        // surface won) or the host aborted — both already settled.
        if (relay.signal.aborted) return
        deps.log('discord_ask_dual_web_failed', { kind: 'approval', approvalId, cause: String(cause) })
      })
    if (req.signal?.aborted === true) pending.dispose()
    void pending.promise.then(() => {
      webRelays.delete(approvalId)
      // Close the web wait when the Discord surface settled first (a
      // no-op when the web answer already won or the host aborted).
      relay.abort()
      deps.onWaitState?.(threadId, false)
      void deps.askWiring.disableControl(approvalId).catch((cause: unknown) => {
        deps.log('discord_ask_control_disable_failed', { key: approvalId, cause: String(cause) })
      })
    }).catch((cause: unknown) => {
      // The ask itself has settled; a failing wait-state clear must not
      // escape as an unhandled rejection.
      deps.log('discord_ask_wait_clear_failed', { threadId, cause: String(cause) })
    })
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
      deps.onWaitState?.(threadId, true)
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
      // Dual surface (16.105): mirror the batch to the web surface under
      // the relayed signal; the first complete answer batch wins.
      const relay = new SignalRelay(req.signal)
      webRelays.set(rpcId, relay)
      void Promise.resolve()
        .then(() => originalAsk({ ...req, signal: relay.signal }))
        .then(answer => {
          if (!pending.resolve(answer)) return
          deps.log('discord_ask_dual_web_won', { kind: 'question', rpcId })
          deps.askWiring.onQuestionResolved({ sessionId, questionRpcId: rpcId, outcome: 'answered' })
        })
        .catch((cause: unknown) => {
          // NO_PROVIDER = no connected web client: the Discord surface
          // carries the ask alone (the pre-dual-surface behavior).
          if (isNoProvider(cause)) {
            deps.log('discord_ask_dual_web_absent', { kind: 'question', rpcId })
            return
          }
          if (relay.signal.aborted) return
          deps.log('discord_ask_dual_web_failed', { kind: 'question', rpcId, cause: String(cause) })
        })
      if (req.signal?.aborted === true) pending.dispose()
      void pending.promise.then(() => {
        webRelays.delete(rpcId)
        // Close the web wait when the Discord surface settled first (a
        // no-op when the web answer already won or the host aborted).
        relay.abort()
        deps.onWaitState?.(threadId, false)
        void deps.askWiring.disableControl(rpcId).catch((cause: unknown) => {
          deps.log('discord_ask_control_disable_failed', { key: rpcId, cause: String(cause) })
        })
      }).catch((cause: unknown) => {
        deps.log('discord_ask_wait_clear_failed', { threadId, cause: String(cause) })
      })
      return pending.promise
    }
  }

  return patch
}
