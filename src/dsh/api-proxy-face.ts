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
import type { WorkspaceResolver } from '../features/project-bind.js'
import { parseWorkspaceReference } from '../policy/disclosure.js'
import { validateImageUrl } from '../features/image-download.js'
import type { DiscordAttachment } from '../gateway/inbound.js'

/** One prompt content part accepted by the DSH session.prompt wire schema. */
export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string }

/** The workspace rows the catalog port needs (subset of WorkspaceView). */
export interface WorkspaceCatalogEntry {
  workspaceId: string
  title: string
  /** Canonical directory; present in Host responses, rendered only to proven administrators. */
  path?: string | undefined
}

/** The narrow slice of ApiProxy this module speaks. */
export interface DshApiProxyFace {
  workspace: {
    list(request: RpcRequestShape<Record<string, never>>): Promise<RpcResponseShape<{ items: WorkspaceCatalogEntry[] }>>
  }
  sessions: {
    prompt(request: RpcRequestShape<{
      sessionId: string
      mode: 'queue' | 'steer'
      content: PromptContentPart[]
    }>): Promise<RpcResponseShape<{ accepted: true }>>
    create(request: RpcRequestShape<{
      workspaceId?: string
      sessionId?: string
      agentPreset?: string
    }>): Promise<RpcResponseShape<{ sessionId: string }>>
    cancel(request: RpcRequestShape<{ sessionId: string }>): Promise<RpcResponseShape<{ accepted: true }>>
    updateQueue(request: RpcRequestShape<{
      sessionId: string
      itemId: string
      action: { kind: 'remove' }
    }>): Promise<RpcResponseShape<{ accepted: true }>>
    list(request: RpcRequestShape<{ cursor?: string }>): Promise<RpcResponseShape<{ items: SessionSummaryShape[] }>>
    models(request: RpcRequestShape<{ sessionId: string }>): Promise<RpcResponseShape<SessionModelsShape>>
    selectModel(request: RpcRequestShape<{
      sessionId: string
      provider: string
      model: string
      reasoningEffort?: string
    }>): Promise<RpcResponseShape<{ selected: ModelSelectionShape }>>
  }
}

/** Defensive read of the title projection in a list row's values. */
export interface SessionProjectionsShape {
  values?: { title?: unknown }
}

/** The per-session summary `sessions.list` returns (rc.2 rich rows). */
export interface SessionSummaryShape {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  agentPreset?: string
  origin?: 'subagent'
  projections?: SessionProjectionsShape
}

/** The complete provider/model/reasoning selection (dsh-agent ModelSelection). */
export interface ModelSelectionShape {
  provider: string
  model: string
  reasoningEffort?: string
}

/** One reasoning effort a model's adapter advertises (sessions.d.ts). */
import type { DshModelPort } from '../features/model-control.js'

export interface ModelReasoningEffortShape {
  id: string
  name: string
  description?: string
}

/** Exact-route reasoning metadata for one catalog model. */
export interface ModelReasoningShape {
  efforts: ModelReasoningEffortShape[]
  defaultEffort?: string
}

/** One model inside a provider group (sessions.d.ts ModelCatalogModel). */
export interface ModelCatalogModelShape {
  id: string
  name: string
  description?: string
  reasoning?: ModelReasoningShape
}

/** One provider group and its models (sessions.d.ts ModelProviderGroup). */
export interface ModelProviderGroupShape {
  id: string
  name: string
  models: ModelCatalogModelShape[]
}

/** The detached model directory `session.models` returns for one session. */
export interface SessionModelsShape {
  current: ModelSelectionShape
  routable: boolean
  groups: ModelProviderGroupShape[]
  failures: Array<{ id: string; name: string; message: string }>
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
function mintRequest<P>(payload: P, rpcId?: string): RpcRequestShape<P> {
  return { rpcId: rpcId ?? crypto.randomUUID(), payload }
}

/**
 * The bind flow's catalog verifier: resolves an opaque `ws:` reference
 * against the live workspace list. A well-formed reference the catalog no
 * longer knows — and any malformed one — resolve `stale` (fail-closed, no
 * write can follow); a Host error is `failed`; a timeout is `unknown`.
 */
export function createWorkspaceResolver(
  dsh: DshApiProxyFace,
  options: ApiProxyFaceOptions = {},
): WorkspaceResolver {
  const port = createWorkspaceCatalogPort(dsh, options)
  return {
    async resolve(reference) {
      const catalog = await port.listWorkspaces()
      if (catalog.outcome !== 'completed') {
        return catalog.outcome === 'unknown' ? { outcome: 'unknown' } : { outcome: 'failed' }
      }
      const id = parseWorkspaceReference(reference)
      const found = id === undefined
        ? undefined
        : catalog.workspaces.find(workspace => workspace.id === id)
      return found === undefined
        ? { outcome: 'stale' }
        : { outcome: 'found', workspace: { id: found.id, title: found.title } }
    },
  }
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
      let response: RpcResponseShape<{ items: WorkspaceCatalogEntry[]; archivedSessionIds?: unknown }>
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
      const result = (response as Partial<RpcResponseShape<{ items: WorkspaceCatalogEntry[]; archivedSessionIds?: ReadonlyArray<unknown> }>> | undefined)?.result
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
            // The registered path rides every workspace.* row (Host
            // WorkspaceView); /session resume scopes candidates by it and
            // /project autocomplete abbreviates it — dropping it here once
            // silently emptied the resume list everywhere (16.46).
            ...(typeof workspace.path === 'string' ? { path: workspace.path } : {}),
          })),
          // The registry's archived set rides the workspace.list value
          // (sessions.list rows carry NO archived marker): /session resume
          // subtracts it — resuming an archived session dead-ends in a
          // thread whose turns never run (16.49).
          archivedSessionIds: Array.isArray(result.value.archivedSessionIds)
            ? result.value.archivedSessionIds.filter((id): id is string => typeof id === 'string')
            : [],
        }
      }
      log?.('discord_workspace_list_rejected', {
        code: result.error.code,
        message: result.error.message,
      })
      return { outcome: 'failed' }
    },
  }
}

export type WorkspaceDetailOutcome =
  | { outcome: 'found'; workspace: { id: string; title: string; path: string | undefined } }
  | { outcome: 'stale' }
  | { outcome: 'failed' }
  | { outcome: 'unknown' }

/**
 * Read one Workspace's full view (title plus canonical path). The path is
 * for the administrator-only ephemeral info response — the disclosure
 * policy owns whether it ever renders; this face only carries it in memory.
 */
export async function readWorkspaceDetail(
  dsh: DshApiProxyFace,
  reference: string,
  options: ApiProxyFaceOptions = {},
): Promise<WorkspaceDetailOutcome> {
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS
  const log = options.log
  let response: RpcResponseShape<{ items: WorkspaceCatalogEntry[] }>
  try {
    response = await withRpcTimeout(dsh.workspace.list(mintRequest({})), timeoutMs)
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_workspace_detail_timeout', { timeoutMs })
      return { outcome: 'unknown' }
    }
    log?.('discord_workspace_detail_threw', { cause: String(cause) })
    return { outcome: 'failed' }
  }
  const result = (response as Partial<RpcResponseShape<{ items: WorkspaceCatalogEntry[] }>> | undefined)?.result
  if (result === undefined) {
    log?.('discord_workspace_detail_malformed')
    return { outcome: 'failed' }
  }
  if (!result.ok) {
    log?.('discord_workspace_detail_rejected', { code: result.error.code })
    return { outcome: 'failed' }
  }
  const id = parseWorkspaceReference(reference) ?? (reference === '' ? undefined : reference)
  const found = Array.isArray(result.value.items)
    ? result.value.items.find(workspace => workspace.workspaceId === id)
    : undefined
  if (found === undefined) return { outcome: 'stale' }
  return {
    outcome: 'found',
    workspace: {
      id: found.workspaceId,
      title: found.title,
      path: typeof found.path === 'string' ? found.path : undefined,
    },
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
 * `options.rpcId` pins the adapter-owned stable request id, which the Host
 * records on the durable `user/message` (`source.rpcId`) for reconciliation.
 */
export async function promptSession(
  dsh: DshApiProxyFace,
  request: { sessionId: string; prompt: string; images?: DiscordAttachment[] },
  options: ApiProxyFaceOptions & { rpcId?: string } = {},
): Promise<PromptOutcome> {
  return submitPromptTurn(dsh, { ...request, mode: 'queue' }, options)
}

/**
 * Steer the session's active turn: `session.prompt` with `mode: 'steer'`,
 * carrying the same stable request-id discipline as the queue path.
 */
export async function steerSession(
  dsh: DshApiProxyFace,
  request: { sessionId: string; prompt: string; images?: DiscordAttachment[] },
  options: ApiProxyFaceOptions & { rpcId?: string } = {},
): Promise<PromptOutcome> {
  return submitPromptTurn(dsh, { ...request, mode: 'steer' }, options)
}

/** Image media types accepted by the DSH prompt content schema. */
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

/** Build the DSH prompt `content` array: text parts plus any downloaded image parts. */
async function buildPromptContent(
  request: { prompt: string; images?: DiscordAttachment[] },
): Promise<PromptContentPart[] | undefined> {
  const parts: PromptContentPart[] = []
  const trimmed = typeof request.prompt === 'string' ? request.prompt.trim() : ''
  if (trimmed !== '') parts.push({ type: 'text', text: trimmed })
  const images = Array.isArray(request.images) ? request.images : []
  for (const image of images) {
    const part = await downloadImagePart(image)
    if (part === undefined) return undefined
    parts.push(part)
  }
  return parts
}

/** Download one Discord attachment and encode it as a DSH image content part. */
async function downloadImagePart(image: DiscordAttachment): Promise<PromptContentPart | undefined> {
  const url = image.url
  if (typeof url !== 'string' || url === '') return undefined
  const validation = validateImageUrl(url)
  if (!validation.ok) return undefined
  let response: Response
  try {
    response = await fetch(url)
  } catch {
    return undefined
  }
  if (response.status !== 200) return undefined
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) return undefined
  const buf = await response.arrayBuffer()
  if (buf.byteLength === 0) return undefined
  const data = Buffer.from(buf).toString('base64')
  return { type: 'image', mediaType, data }
}

async function submitPromptTurn(
  dsh: DshApiProxyFace,
  request: { sessionId: string; prompt: string; mode: 'queue' | 'steer'; images?: DiscordAttachment[] },
  options: ApiProxyFaceOptions & { rpcId?: string },
): Promise<PromptOutcome> {
  const timeoutMs = options.timeoutMs ?? PROMPT_TIMEOUT_MS
  const log = options.log
  const content = await buildPromptContent(request)
  if (content === undefined) {
    log?.('discord_prompt_image_download_failed', { sessionId: request.sessionId })
    return { outcome: 'rejected', reason: 'image-download-failed' }
  }
  let response: RpcResponseShape<{ accepted: true }>
  try {
    response = await withRpcTimeout(
      dsh.sessions.prompt(mintRequest({
        sessionId: request.sessionId,
        mode: request.mode,
        content,
      }, options.rpcId)),
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

export type CreateSessionOutcome =
  | { outcome: 'completed'; sessionId: string }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown' }

/**
 * Create one DSH Session against a preallocated id (design.md §10): DSH
 * adopts the same session id idempotently, so an uncertain response never
 * forks a second Session. Same outcome discipline as the prompt path.
 */
export async function createSessionViaProxy(
  dsh: DshApiProxyFace,
  request: { sessionId: string; workspaceId: string },
  options: ApiProxyFaceOptions = {},
): Promise<CreateSessionOutcome> {
  const timeoutMs = options.timeoutMs ?? PROMPT_TIMEOUT_MS
  const log = options.log
  let response: RpcResponseShape<{ sessionId: string }>
  try {
    response = await withRpcTimeout(
      dsh.sessions.create(mintRequest({
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
      })),
      timeoutMs,
    )
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_session_create_timeout', { timeoutMs, sessionId: request.sessionId })
      return { outcome: 'unknown' }
    }
    log?.('discord_session_create_threw', { cause: String(cause), sessionId: request.sessionId })
    return { outcome: 'unknown' }
  }
  const result = (response as Partial<RpcResponseShape<{ sessionId: string }>> | undefined)?.result
  if (result === undefined) {
    log?.('discord_session_create_malformed', { sessionId: request.sessionId })
    return { outcome: 'unknown' }
  }
  if (result.ok) {
    return { outcome: 'completed', sessionId: result.value.sessionId }
  }
  log?.('discord_session_create_rejected', { code: result.error.code, sessionId: request.sessionId })
  return { outcome: 'rejected', reason: result.error.code }
}

/** The durable Session-id baseline reconciliation reconciles against. */
export type SessionIdListOutcome =
  | { outcome: 'completed'; ids: string[] }
  | { outcome: 'failed' }
  | { outcome: 'unknown' }

/** List durable Session ids (`session.list`, v1 returns everything). */
export async function listSessionIds(
  dsh: DshApiProxyFace,
  options: ApiProxyFaceOptions = {},
): Promise<SessionIdListOutcome> {
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS
  const log = options.log
  let response: RpcResponseShape<{ items: Array<{ sessionId: string }> }>
  try {
    response = await withRpcTimeout(dsh.sessions.list(mintRequest({})), timeoutMs)
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_session_list_timeout', { timeoutMs })
      return { outcome: 'unknown' }
    }
    log?.('discord_session_list_threw', { cause: String(cause) })
    return { outcome: 'unknown' }
  }
  const result = (response as Partial<RpcResponseShape<{ items: Array<{ sessionId: string }> }>> | undefined)?.result
  if (result === undefined) {
    log?.('discord_session_list_malformed')
    return { outcome: 'failed' }
  }
  if (result.ok) {
    return { outcome: 'completed', ids: Array.isArray(result.value.items) ? result.value.items.map(item => item.sessionId) : [] }
  }
  log?.('discord_session_list_rejected', { code: result.error.code })
  return { outcome: 'failed' }
}

/** A list row narrowed to what the /session resume surface renders. */
export interface SessionResumeRow {
  sessionId: string
  title: string | undefined
  updatedAt: number
  running: boolean
  blank: boolean
  cwd: string | undefined
  origin: 'subagent' | undefined
}

export type SessionSummariesOutcome =
  | { outcome: 'completed'; sessions: SessionResumeRow[] }
  | { outcome: 'failed' }
  | { outcome: 'unknown' }

/**
 * The rich `sessions.list` for the /session resume surface: titles ride each
 * row's projection values (absence = the session has no title yet), blank
 * sessions are flagged, and rows arrive updatedAt-descending. Defensive
 * narrowing: the wire is untrusted, extra/missing fields never throw.
 */
export async function listSessionSummaries(
  dsh: DshApiProxyFace,
  options: ApiProxyFaceOptions = {},
): Promise<SessionSummariesOutcome> {
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS
  const log = options.log
  let response: RpcResponseShape<{ items: SessionSummaryShape[] }>
  try {
    response = await withRpcTimeout(dsh.sessions.list(mintRequest({})), timeoutMs)
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_session_summaries_timeout', { timeoutMs })
      return { outcome: 'unknown' }
    }
    log?.('discord_session_summaries_threw', { cause: String(cause) })
    return { outcome: 'unknown' }
  }
  const result = (response as Partial<RpcResponseShape<{ items: SessionSummaryShape[] }>> | undefined)?.result
  if (result === undefined || !result.ok || !Array.isArray(result.value.items)) {
    log?.('discord_session_summaries_malformed')
    return { outcome: 'failed' }
  }
  const sessions: SessionResumeRow[] = []
  // The wire is untrusted: narrow every row defensively before use.
  const items: unknown[] = Array.isArray(result.value.items) ? result.value.items : []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Partial<SessionSummaryShape> & { projections?: { values?: { title?: unknown } } }
    if (typeof row.sessionId !== 'string' || row.sessionId === '') continue
    const values = row.projections?.values
    const title = typeof values?.title === 'string' && values.title !== '' ? values.title : undefined
    sessions.push({
      sessionId: row.sessionId,
      title,
      updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
      running: row.running ?? false,
      blank: row.blank === true,
      cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
      origin: row.origin === 'subagent' ? 'subagent' : undefined,
    })
  }
  return { outcome: 'completed', sessions }
}

export type CancelOutcome =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown' }

/** Cancel the session's active turn (`session.cancel`); DSH preserves the pending inbox. */
export async function cancelSessionViaProxy(
  dsh: DshApiProxyFace,
  request: { sessionId: string },
  options: ApiProxyFaceOptions = {},
): Promise<CancelOutcome> {
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS
  const log = options.log
  let response: RpcResponseShape<{ accepted: true }>
  try {
    response = await withRpcTimeout(
      dsh.sessions.cancel(mintRequest({ sessionId: request.sessionId })),
      timeoutMs,
    )
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_session_cancel_timeout', { timeoutMs, sessionId: request.sessionId })
      return { outcome: 'unknown' }
    }
    log?.('discord_session_cancel_threw', { cause: String(cause), sessionId: request.sessionId })
    return { outcome: 'unknown' }
  }
  const result = (response as Partial<RpcResponseShape<{ accepted: true }>> | undefined)?.result
  if (result === undefined) {
    log?.('discord_session_cancel_malformed', { sessionId: request.sessionId })
    return { outcome: 'unknown' }
  }
  if (result.ok) return { outcome: 'accepted' }
  log?.('discord_session_cancel_rejected', { code: result.error.code, sessionId: request.sessionId })
  return { outcome: 'rejected', reason: result.error.code }
}

export type QueueRemoveOutcome =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown' }

/** Remove one pending inbox item (`session.updateQueue`, action remove). */
export async function removeQueueItemViaProxy(
  dsh: DshApiProxyFace,
  request: { sessionId: string; itemId: string },
  options: ApiProxyFaceOptions = {},
): Promise<QueueRemoveOutcome> {
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS
  const log = options.log
  let response: RpcResponseShape<{ accepted: true }>
  try {
    response = await withRpcTimeout(
      dsh.sessions.updateQueue(mintRequest({
        sessionId: request.sessionId,
        itemId: request.itemId,
        action: { kind: 'remove' },
      })),
      timeoutMs,
    )
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_queue_remove_timeout', { timeoutMs, sessionId: request.sessionId })
      return { outcome: 'unknown' }
    }
    log?.('discord_queue_remove_threw', { cause: String(cause), sessionId: request.sessionId })
    return { outcome: 'unknown' }
  }
  const result = (response as Partial<RpcResponseShape<{ accepted: true }>> | undefined)?.result
  if (result === undefined) {
    log?.('discord_queue_remove_malformed', { sessionId: request.sessionId })
    return { outcome: 'unknown' }
  }
  if (result.ok) return { outcome: 'accepted' }
  log?.('discord_queue_remove_rejected', { code: result.error.code, sessionId: request.sessionId })
  return { outcome: 'rejected', reason: result.error.code }
}

/** The carrier verdict apiProxy.respond resolves with (RpcReceipt). */
export type RespondReceipt =
  | { accepted: true }
  | { accepted: false; reason: 'not-pending' | 'bad-response' }
  | { accepted: unknown }

export type RespondOutcome =
  | { outcome: 'confirmed' }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown' }

/**
 * The respond face for answerable server-requests (approvals, questions).
 * Builds the full ClientResponse envelope — {type: 'client-response',
 * rpcId, result: {ok: true, value}} is the wire contract; posting the bare
 * payload is silently ignored by the Host (rpcId never resolves) — and
 * maps the RpcReceipt onto the port outcome. Like every call in this module
 * it is bounded (a Host that never resolves the receipt must not wedge an
 * interaction handler or an expiry sweep forever) and never throws: a Host
 * rejection or timeout resolves to `unknown` — the response may or may not
 * have landed, and the callers park the ask `unresolved` on exactly that.
 */
export function createClientRespondPort(
  dsh: { respond(message: unknown): Promise<unknown> },
  options: ApiProxyFaceOptions = {},
): {
  respond(rpcId: string, value: unknown): Promise<RespondOutcome>
} {
  const log = options.log
  const timeoutMs = options.timeoutMs ?? PROMPT_TIMEOUT_MS
  return {
    async respond(rpcId, value): Promise<RespondOutcome> {
      let receipt: unknown
      try {
        const response = await withRpcTimeout(
          dsh.respond({
            type: 'client-response',
            rpcId,
            result: { ok: true, value },
          }),
          timeoutMs,
        )
        receipt = response
      } catch (cause) {
        const reason = cause instanceof RpcTimeoutError ? 'discord_client_respond_timeout' : 'discord_client_respond_threw'
        log?.(reason, { rpcId, ...(cause instanceof RpcTimeoutError ? { timeoutMs } : { cause: String(cause) }) })
        return { outcome: 'unknown' }
      }
      const table = receipt as { accepted?: unknown; reason?: unknown } | undefined
      log?.('discord_client_respond_receipt', { rpcId, receipt: table ?? null })
      if (table?.accepted === true) return { outcome: 'confirmed' }
      if (table?.accepted === false) {
        return { outcome: 'rejected', reason: typeof table.reason === 'string' ? table.reason : 'respond-refused' }
      }
      return { outcome: 'unknown' }
    },
  }
}

/** Bounded window for the per-session model directory read. */
const MODELS_TIMEOUT_MS = 10_000

export type SessionModelsOutcome =
  | { outcome: 'completed'; models: SessionModelsShape }
  | { outcome: 'failed' }
  | { outcome: 'unknown' }

/**
 * The session's detached model directory: the live selection, whether the
 * current route still serves, and the per-provider catalog groups the
 * /model cascade browses.
 */
export async function sessionModels(
  dsh: DshApiProxyFace,
  request: { sessionId: string },
  options: ApiProxyFaceOptions = {},
): Promise<SessionModelsOutcome> {
  const timeoutMs = options.timeoutMs ?? MODELS_TIMEOUT_MS
  let response: RpcResponseShape<SessionModelsShape>
  try {
    response = await withRpcTimeout(
      dsh.sessions.models(mintRequest({ sessionId: request.sessionId })),
      timeoutMs,
    )
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      options.log?.('discord_models_timeout', { sessionId: request.sessionId })
      return { outcome: 'unknown' }
    }
    options.log?.('discord_models_threw', { cause: String(cause), sessionId: request.sessionId })
    return { outcome: 'unknown' }
  }
  const result = (response as Partial<RpcResponseShape<SessionModelsShape>> | undefined)?.result
  if (result === undefined || !result.ok) {
    options.log?.('discord_models_malformed', {
      sessionId: request.sessionId,
      code: result?.ok === false ? result.error.code : 'malformed',
    })
    return { outcome: 'failed' }
  }
  return { outcome: 'completed', models: result.value }
}

export type SelectModelOutcome =
  | { outcome: 'completed'; selected: ModelSelectionShape }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown' }

/**
 * Select the complete model selection for one session (session.selectModel):
 * the session switches immediately and the Host records the choice as the
 * default for sessions that have not logged their own — the response only
 * proves the session switch, so callers must not claim the persistence
 * outcome (design.md §7).
 */
export async function selectSessionModel(
  dsh: DshApiProxyFace,
  request: { sessionId: string; provider: string; model: string; reasoningEffort?: string },
  options: ApiProxyFaceOptions = {},
): Promise<SelectModelOutcome> {
  const timeoutMs = options.timeoutMs ?? PROMPT_TIMEOUT_MS
  let response: RpcResponseShape<{ selected: ModelSelectionShape }>
  try {
    response = await withRpcTimeout(
      dsh.sessions.selectModel(mintRequest({
        sessionId: request.sessionId,
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      })),
      timeoutMs,
    )
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      options.log?.('discord_model_select_timeout', { sessionId: request.sessionId })
      return { outcome: 'unknown' }
    }
    options.log?.('discord_model_select_threw', { cause: String(cause), sessionId: request.sessionId })
    return { outcome: 'unknown' }
  }
  const result = (response as Partial<RpcResponseShape<{ selected: ModelSelectionShape }>> | undefined)?.result
  if (result === undefined) {
    options.log?.('discord_model_select_malformed', { sessionId: request.sessionId })
    return { outcome: 'unknown' }
  }
  if (result.ok) {
    return { outcome: 'completed', selected: result.value.selected }
  }
  options.log?.('discord_model_select_rejected', { code: result.error.code, sessionId: request.sessionId })
  return { outcome: 'rejected', reason: result.error.code }
}

/**
 * The /model surface over the real session RPCs: the per-session live
 * directory (`session.models`) and the guarded selection mutation
 * (`session.selectModel`) — the shapes model-control reasons about.
 */
export function createModelPort(
  dsh: DshApiProxyFace,
  options: ApiProxyFaceOptions = {},
): DshModelPort {
  return {
    models: sessionId => sessionModels(dsh, { sessionId }, options),
    selectModel: request => selectSessionModel(dsh, request, options),
  }
}
