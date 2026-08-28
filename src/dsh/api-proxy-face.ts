/**
 * The typed face over the Host's in-process `ctx.apiProxy` service
 * (ApiProxyService, the transport-agnostic gateway's direct implementation).
 * Its domain methods speak the narrow RPC signature: `RpcRequest<P>` in,
 * `RpcResponse<T>` out, business errors on `result.ok === false` — they never
 * throw for business outcomes. Two guarantees are added here:
 *
 * 1. Boundedness — a Host that never answers must not wedge an interaction
 *    handler (or a Discord ephemeral) forever; every call races a timeout and
 *    resolves to an unobservable outcome instead.
 * 2. Observability — every terminal outcome is reported through the injected
 *    log sink, so a silent-void call can never again be misread as a hang.
 */

import type { ProjectListPort } from '../features/project-list.js'

/** The workspace rows the catalog port needs (subset of WorkspaceView). */
export interface WorkspaceCatalogEntry {
  workspaceId: string
  title: string
}

/** The narrow slice of ApiProxy this module speaks. */
export interface DshApiProxyFace {
  workspace: {
    list(request: RpcRequestShape<Record<string, never>>): Promise<RpcResponseShape<{ items: WorkspaceCatalogEntry[] }>>
  }
  sessions: {
    prompt(request: RpcRequestShape<{
      sessionId: string
      mode: 'queue'
      content: Array<{ type: 'text'; text: string }>
    }>): Promise<RpcResponseShape<{ accepted: true }>>
  }
}

/** Signature-layer narrow request form (RpcId brand erased at this seam). */
export interface RpcRequestShape<P> {
  rpcId: string
  payload: P
}

/** Signature-layer narrow response form with the business ok/error result. */
export interface RpcResponseShape<T> {
  rpcId: string
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
}

/** Raised when the Host did not answer within the bounded window. */
export class RpcTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`dsh apiProxy call did not answer within ${String(timeoutMs)}ms`)
    this.name = 'RpcTimeoutError'
  }
}

/** Race one apiProxy promise against a bounded window. */
export function withRpcTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new RpcTimeoutError(timeoutMs)) }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** Default bounded window for unary catalog reads (local, no model work). */
const CATALOG_TIMEOUT_MS = 5_000
/** Default bounded window for prompt admission (the Host may enqueue). */
const PROMPT_TIMEOUT_MS = 30_000

/** Diagnostic sink shared by both faces. */
export type ApiProxyLog = (event: string, detail?: unknown) => void

export interface ApiProxyFaceOptions {
  timeoutMs?: number
  log?: ApiProxyLog
}

/** Mint a request envelope the way every client shape does. */
function mintRequest<P>(payload: P): RpcRequestShape<P> {
  return { rpcId: crypto.randomUUID(), payload }
}

/**
 * The `/project list` catalog port satisfied by the in-process apiProxy.
 * Outcomes follow the port contract: a definitive Host error is `failed`
 * (sanitized before Discord), while a timeout or unreadable body is
 * `unknown` — delivery was not observed, so no retry is implied.
 */
export function createWorkspaceCatalogPort(
  dsh: DshApiProxyFace,
  options: ApiProxyFaceOptions = {},
): ProjectListPort {
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS
  const log = options.log
  return {
    async listWorkspaces() {
      let response: RpcResponseShape<{ items: WorkspaceCatalogEntry[] }>
      try {
        response = await withRpcTimeout(
          dsh.workspace.list(mintRequest({})),
          timeoutMs,
        )
      } catch (cause) {
        if (cause instanceof RpcTimeoutError) {
          log?.('discord_workspace_list_timeout', { timeoutMs })
          return { outcome: 'unknown' }
        }
        log?.('discord_workspace_list_threw', { cause: String(cause) })
        return { outcome: 'failed' }
      }
      // A malformed envelope is a definitive, sanitized failure: the Host
      // answered, so a retry is safe and semantics stay observable-free.
      const result = (response as Partial<RpcResponseShape<{ items: WorkspaceCatalogEntry[] }>> | undefined)?.result
      if (result === undefined) {
        log?.('discord_workspace_list_malformed')
        return { outcome: 'failed' }
      }
      if (result.ok) {
        const items = Array.isArray(result.value.items)
          ? result.value.items
          : []
        return {
          outcome: 'completed',
          workspaces: items.map(workspace => ({
            id: workspace.workspaceId,
            title: workspace.title,
          })),
        }
      }
      log?.('discord_workspace_list_rejected', {
        code: result.error.code,
        message: result.error.message,
      })
      return { outcome: 'failed' }    },
  }
}

export type PromptOutcome =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown' }

/**
 * Submit one prompt turn through the in-process apiProxy. A definitive Host
 * error is a rejection carrying the sanitized code; a timeout is `unknown` —
 * the turn may or may not have been admitted, so callers must not resubmit.
 */
export async function promptSession(
  dsh: DshApiProxyFace,
  request: { sessionId: string; prompt: string },
  options: ApiProxyFaceOptions = {},
): Promise<PromptOutcome> {
  const timeoutMs = options.timeoutMs ?? PROMPT_TIMEOUT_MS
  const log = options.log
  let response: RpcResponseShape<{ accepted: true }>
  try {
    response = await withRpcTimeout(
      dsh.sessions.prompt(mintRequest({
        sessionId: request.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: request.prompt }],
      })),
      timeoutMs,
    )
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_prompt_submit_timeout', { timeoutMs, sessionId: request.sessionId })
      return { outcome: 'unknown' }
    }
    log?.('discord_prompt_submit_threw', { cause: String(cause), sessionId: request.sessionId })
    return { outcome: 'unknown' }
  }
  const result = (response as Partial<RpcResponseShape<{ accepted: true }>> | undefined)?.result
  if (result === undefined) {
    // An unreadable body leaves admission unobservable: the turn MAY have
    // been admitted, so the at-most-once discipline forbids resubmission.
    log?.('discord_prompt_submit_malformed', { sessionId: request.sessionId })
    return { outcome: 'unknown' }
  }
  if (result.ok) {
    // The wire schema pins accepted to literal true; the Host's own zod
    // parse enforces it before this seam ever sees the body.
    return { outcome: 'accepted' }
  }
  log?.('discord_prompt_submit_rejected', {
    code: result.error.code,
    sessionId: request.sessionId,
  })
  return { outcome: 'rejected', reason: result.error.code }
}
