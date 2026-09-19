/**
 * The typed防腐层 over the Host's 0.1.6 controller services — the cordis
 * services `sessionController`, `workspaceController`, and `sessionQuery`
 * that replaced the 0.1.1-rc.2 `apiProxy` gateway. Domain methods speak the
 * typert faces directly: plain request objects in, plain values out, and
 * business rejections carried as thrown `RemoteError`s (`{code, message}`).
 * Two guarantees are preserved from the rc.2 seam:
 *
 * 1. Boundedness — a Host that never answers must not wedge an interaction
 *    handler (or a Discord ephemeral) forever; every call races a timeout and
 *    resolves to an unobservable outcome instead.
 * 2. Observability — every terminal outcome is reported through the injected
 *    log sink, so a silent-void call can never again be misread as a hang.
 *
 * The exported port-level API (function names, outcome unions) is unchanged
 * from the rc.2 face: the Discord features and their tests keep their
 * vocabulary while this module alone absorbs the host-side rebase.
 */

import type { ProjectListPort } from '../features/project-list.js'
import type { WorkspaceResolver } from '../features/project-bind.js'
import { parseWorkspaceReference } from '../policy/disclosure.js'
import type { DshModelPort } from '../features/model-control.js'
import type { DshPermissionPort } from '../features/permission-control.js'

/** The workspace rows the catalog port needs (subset of WorkspaceView). */
export interface WorkspaceCatalogEntry {
  workspaceId: string
  title: string
  /** Canonical directory; present in Host responses, rendered only to proven administrators. */
  path?: string | undefined
}

/**
 * Narrow slice of the 0.1.6 `sessionController` cordis service. Method
 * shapes mirror the typert descriptors in @deepseek-ai/dsh-api-session-controller.
 */
export interface DshSessionControllerFace {
  prompt(request: {
    requestId: string
    sessionId: string
    mode: 'queue' | 'steer'
    content: Array<{ type: 'text'; text: string } | { type: 'image'; mediaType: string; data: string }>
    clientTimeZone?: string
  }, signal: AbortSignal): Promise<{ accepted: true }>
  create(request: {
    workspaceId?: string
    cwd?: string
    sessionId?: string
    agentPreset?: string
  }): Promise<{ sessionId: string; agentPreset?: string }>
  /** The durable Session list; the host takes ONLY an optional cancellation signal. */
  list(signal: AbortSignal | undefined): Promise<{ items: unknown[] }>
  cancel(request: { sessionId: string }): Promise<{ accepted: true }>
  updateQueue(request: {
    sessionId: string
    itemId: string
    action: { kind: 'remove' }
  }): Promise<{ accepted: true }>
  selectModel(request: {
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  }): Promise<{ selected: ModelSelectionShape }>
  modelCatalog(): Promise<ModelCatalogWireShape>
  /** Per-session durable journal stream (live frames after one opening snapshot). */
  follow(request: {
    address: { kind: 'session'; sessionId: string }
    assistantStream?: true
  }, signal: AbortSignal): AsyncIterable<unknown>
  /** Host-wide live state stream (queue/jobs/projection frames over one baseline). */
  control(signal: AbortSignal): AsyncIterable<unknown>
  /**
   * Resolve or resume one Session's live Agent (0.1.6 probe-verified shape
   * `{agent} | {error}`); the agent object stays opaque — it exists only to
   * feed `commands.execute` for the Host-native `/permission` command path.
   */
  resolveAgent(sessionId: string): Promise<{ agent?: unknown; error?: { code?: string; message?: string } }>
}

/**
 * Narrow slice of the 0.1.6 `workspaceController` cordis service. The
 * registry baseline (`baseline()`) is the synchronous successor of the rc.2
 * unary `workspace.list` RPC.
 */
export interface DshWorkspaceControllerFace {
  /** Workspace state stream; every generation starts with exactly one baseline frame. */
  follow(signal: AbortSignal): AsyncIterable<unknown>
}

/**
 * Narrow slice of `sessionQuery` — the per-session projection read the /model
 * surface needs for the session's live selection (the rc.2 `sessions.models`
 * RPC split into the global `modelCatalog` plus this projection).
 */
export interface DshSessionQueryFace {
  observeSession(sessionId: string): Promise<{
    header?: { cwd?: string }
    projections?: { values?: Record<string, unknown> }
  } & Partial<AsyncDisposable>>
}

/**
 * Narrow slice of the `commands` cordis service (dsh-commands). `execute`
 * runs one registered slash command against an exact agent WITHOUT sending
 * it to the model, logging the command/run + command/done journal pair; the
 * signal is owned by the caller. Signatures 2026-09-19 real-host verified.
 */
export interface DshCommandsFace {
  execute(
    agent: unknown,
    line: string,
    submittedAttachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{ commandId: string; result?: { kind?: unknown; text?: unknown } } | undefined>
}

/**
 * Narrow slice of the `permissionPresets` cordis service
 * (dsh-permission-presets): the deployment's configured preset table.
 */
export interface DshPermissionPresetsFace {
  catalog(): Promise<{ options?: unknown }>
}

/** The host-generation model catalog (`session/modelCatalog`, host-wide). */
export interface ModelCatalogWireShape {
  default: ModelSelectionShape
  routableProviders: string[]
  groups: ModelProviderGroupShape[]
  failures: Array<{ id: string; name: string; message: string }>
}

/** The composite host face every port factory in this module consumes. */
export interface DshHostFace {
  session: DshSessionControllerFace
  workspace: DshWorkspaceControllerFace
  sessionQuery: DshSessionQueryFace
  commands: DshCommandsFace
  permissionPresets: DshPermissionPresetsFace
}

/**
 * Resolve the 0.1.6 controller services off the Cordis context. Throws one
 * actionable TypeError naming every absent service — the composition root
 * treats that as a fail-loud startup boundary, never a silent half-mount.
 */
export function resolveHostFace(ctx: { get(name: string): unknown }): DshHostFace {
  const missing: string[] = []
  for (const name of ['sessionController', 'workspaceController', 'sessionQuery', 'commands', 'permissionPresets'] as const) {
    if (ctx.get(name) === undefined || ctx.get(name) === null) missing.push(name)
  }
  if (missing.length > 0) {
    throw new TypeError(`dsh-discord requires the 0.1.6 host controller services; missing ${missing.map(name => `'${name}'`).join(', ')}`)
  }
  return {
    session: ctx.get('sessionController') as DshSessionControllerFace,
    workspace: ctx.get('workspaceController') as DshWorkspaceControllerFace,
    sessionQuery: ctx.get('sessionQuery') as DshSessionQueryFace,
    commands: ctx.get('commands') as DshCommandsFace,
    permissionPresets: ctx.get('permissionPresets') as DshPermissionPresetsFace,
  }
}

/** Defensive read of the title projection in a list row's values. */
export interface SessionProjectionsShape {
  values?: { title?: unknown }
}

/** The per-session summary `session.list` returns (rich rows, untrusted wire). */
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

/**
 * The detached model directory the /model cascade browses (port shape,
 * unchanged from rc.2): the session's live selection, whether its route
 * still serves, and the per-provider catalog groups.
 */
export interface SessionModelsShape {
  current: ModelSelectionShape
  routable: boolean
  groups: ModelProviderGroupShape[]
  failures: Array<{ id: string; name: string; message: string }>
}

/** Raised when the Host did not answer within the bounded window. */
export class RpcTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`dsh host call did not answer within ${String(timeoutMs)}ms`)
    this.name = 'RpcTimeoutError'
  }
}

/** Race one host promise against a bounded window. */
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
/** Default bounded window for the model directory read. */
const MODELS_TIMEOUT_MS = 10_000

/** Diagnostic sink shared by every face function. */
export type ApiProxyLog = (event: string, detail?: unknown) => void

export interface ApiProxyFaceOptions {
  timeoutMs?: number
  log?: ApiProxyLog
}

/**
 * A definitive Host business rejection: the 0.1.6 controllers throw
 * `RemoteError` ({code, message}) for every admission refusal. Anything else
 * in a catch is a host fault, not a business verdict.
 */
function remoteRejectionOf(error: unknown): { code: string } | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code !== '' ? { code } : undefined
}

/** Defensive record probe: the wire is untrusted regardless of declared types. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Map a Host RemoteError code onto the adapter's stable internal vocabulary:
 * the `session/` namespace prefix is stripped (`session/agent-busy` →
 * `agent-busy`), matching the rc.2 reasons the Discord copy interpolates.
 * Unknown namespaces pass through verbatim.
 */
function rejectionReason(error: unknown): string {
  const rejection = remoteRejectionOf(error)
  if (rejection === undefined) return 'host-error'
  return rejection.code.startsWith('session/')
    ? rejection.code.slice('session/'.length)
    : rejection.code
}

/** Pull exactly the first frame of one stream (the opening baseline). */
function firstFrameOf(stream: AsyncIterable<unknown>): Promise<unknown> {
  const iterator = stream[Symbol.asyncIterator]()
  return iterator.next().then(result => {
    if (result.done === true) throw new Error('workspace stream closed before the baseline frame')
    return result.value
  })
}

/**
 * Read the registry baseline as the follow stream's opening frame: one
 * short-lived subscription, aborted the moment the baseline lands. Returns
 * the narrowed baseline record, or undefined when the frame is malformed.
 */
async function readWorkspaceBaseline(
  dsh: DshHostFace,
  timeoutMs: number,
): Promise<{ items: WorkspaceCatalogEntry[]; archivedSessionIds: string[] }> {
  const per = new AbortController()
  let frame: unknown
  try {
    frame = await withRpcTimeout(firstFrameOf(dsh.workspace.follow(per.signal)), timeoutMs)
  } finally {
    per.abort()
  }
  const value = isRecord(frame) && frame['type'] === 'baseline' ? frame['value'] : undefined
  if (!isRecord(value) || !Array.isArray(value['items'])) throw new Error('workspace baseline frame is malformed')
  return {
    items: value['items'] as WorkspaceCatalogEntry[],
    archivedSessionIds: Array.isArray(value['archivedSessionIds']) ? value['archivedSessionIds'] as string[] : [],
  }
}

/**
 * The bind flow's catalog verifier: resolves an opaque `ws:` reference
 * against the live workspace baseline. A well-formed reference the registry
 * no longer knows — and any malformed one — resolve `stale` (fail-closed, no
 * write can follow); a Host error is `failed`; a timeout is `unknown`.
 */
export function createWorkspaceResolver(
  dsh: DshHostFace,
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
 * The `/project list` catalog port over the workspace registry baseline.
 * Outcomes follow the port contract: a definitive Host error is `failed`
 * (sanitized before Discord), while a timeout or unreadable body is
 * `unknown` — delivery was not observed, so no retry is implied.
 */
export function createWorkspaceCatalogPort(
  dsh: DshHostFace,
  options: ApiProxyFaceOptions = {},
): ProjectListPort {
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS
  const log = options.log
  return {
    async listWorkspaces() {
      let baseline: { items: WorkspaceCatalogEntry[]; archivedSessionIds: string[] }
      try {
        baseline = await readWorkspaceBaseline(dsh, timeoutMs)
      } catch (cause) {
        if (cause instanceof RpcTimeoutError) {
          log?.('discord_workspace_list_timeout', { timeoutMs })
          return { outcome: 'unknown' }
        }
        log?.('discord_workspace_list_threw', { cause: String(cause) })
        return { outcome: 'failed' }
      }
      if (!isRecord(baseline) || !Array.isArray(baseline['items'])) {
        log?.('discord_workspace_list_malformed')
        return { outcome: 'failed' }
      }
      const rows = baseline['items'] as unknown[]
      return {
        outcome: 'completed',
        workspaces: rows
          .filter(workspace => isRecord(workspace) && typeof workspace['workspaceId'] === 'string' && workspace['workspaceId'] !== '')
          .map(workspace => {
            const row = workspace as { workspaceId: string; title?: unknown; path?: unknown }
            return {
              id: row.workspaceId,
              title: typeof row.title === 'string' ? row.title : row.workspaceId,
              // The registered path rides every baseline row (Host
              // WorkspaceView); /session resume scopes candidates by it and
              // /project autocomplete abbreviates it — dropping it here once
              // silently emptied the resume list everywhere (16.46).
              ...(typeof row.path === 'string' ? { path: row.path } : {}),
            }
          }),
        // The registry's archived set rides the baseline (session.list rows
        // carry NO archived marker): /session resume subtracts it — resuming
        // an archived session dead-ends in a thread whose turns never run
        // (16.49).
        archivedSessionIds: Array.isArray(baseline['archivedSessionIds'])
          ? (baseline['archivedSessionIds'] as unknown[]).filter((id): id is string => typeof id === 'string')
          : [],
      }
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
  dsh: DshHostFace,
  reference: string,
  options: ApiProxyFaceOptions = {},
): Promise<WorkspaceDetailOutcome> {
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS
  const log = options.log
  let baseline: { items: WorkspaceCatalogEntry[] }
  try {
    baseline = await readWorkspaceBaseline(dsh, timeoutMs)
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_workspace_detail_timeout', { timeoutMs })
      return { outcome: 'unknown' }
    }
    log?.('discord_workspace_detail_threw', { cause: String(cause) })
    return { outcome: 'failed' }
  }
  const items: WorkspaceCatalogEntry[] = Array.isArray(baseline.items) ? baseline.items : []
  const id = parseWorkspaceReference(reference) ?? (reference === '' ? undefined : reference)
  const found = items.find(workspace => workspace.workspaceId === id)
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
 * Submit one prompt turn through the session controller. A definitive Host
 * rejection (thrown RemoteError) is a rejection carrying the sanitized
 * reason; a timeout or host fault is `unknown` — the turn may or may not
 * have been admitted, so callers must not resubmit. `options.rpcId` pins
 * the adapter-owned stable request id, which the Host records on the
 * durable user message (`source.rpcId`) and de-duplicates on — the 0.1.6
 * admission layer replays `{accepted: true}` for a repeated id, keeping the
 * at-most-once discipline observable. Images (16.50) encode as ordered
 * `image` parts after the text part.
 */
export async function promptSession(
  dsh: DshHostFace,
  request: {
    sessionId: string
    prompt: string
    images?: ReadonlyArray<{ mediaType: string; base64: string }>
  },
  options: ApiProxyFaceOptions & { rpcId?: string } = {},
): Promise<PromptOutcome> {
  return submitPromptTurn(dsh, { ...request, mode: 'queue' }, options)
}

/**
 * Steer the session's active turn: `session.prompt` with `mode: 'steer'`,
 * carrying the same stable request-id discipline as the queue path.
 */
export async function steerSession(
  dsh: DshHostFace,
  request: { sessionId: string; prompt: string },
  options: ApiProxyFaceOptions & { rpcId?: string } = {},
): Promise<PromptOutcome> {
  return submitPromptTurn(dsh, { ...request, mode: 'steer' }, options)
}

async function submitPromptTurn(
  dsh: DshHostFace,
  request: {
    sessionId: string
    prompt: string
    mode: 'queue' | 'steer'
    images?: ReadonlyArray<{ mediaType: string; base64: string }>
  },
  options: ApiProxyFaceOptions & { rpcId?: string },
): Promise<PromptOutcome> {
  const timeoutMs = options.timeoutMs ?? PROMPT_TIMEOUT_MS
  const log = options.log
  const per = new AbortController()
  try {
    await withRpcTimeout(
      dsh.session.prompt({
        requestId: options.rpcId ?? crypto.randomUUID(),
        sessionId: request.sessionId,
        mode: request.mode,
        content: [
          { type: 'text', text: request.prompt },
          ...(request.images ?? []).map(image => ({ type: 'image' as const, mediaType: image.mediaType, data: image.base64 })),
        ],
      }, per.signal),
      timeoutMs,
    )
    // The controller schema pins accepted to literal true; admission
    // returning at all is the accepted verdict.
    return { outcome: 'accepted' }
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_prompt_submit_timeout', { timeoutMs, sessionId: request.sessionId })
      return { outcome: 'unknown' }
    }
    const rejection = remoteRejectionOf(cause)
    if (rejection !== undefined) {
      log?.('discord_prompt_submit_rejected', {
        code: rejection.code,
        sessionId: request.sessionId,
      })
      return { outcome: 'rejected', reason: rejectionReason(cause) }
    }
    log?.('discord_prompt_submit_threw', { cause: String(cause), sessionId: request.sessionId })
    return { outcome: 'unknown' }
  } finally {
    // The host checks the signal only before admission; releasing it after
    // the bounded window keeps the caller's cancellation observable.
    per.abort()
  }
}

export type CreateSessionOutcome =
  | { outcome: 'completed'; sessionId: string }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown' }

/**
 * Create one DSH Session against a preallocated id (design.md §10): the 0.1.6
 * controller adopts the same session id idempotently, so an uncertain
 * response never forks a second Session. Same outcome discipline as the
 * prompt path.
 */
export async function createSessionViaProxy(
  dsh: DshHostFace,
  request: { sessionId: string; workspaceId: string },
  options: ApiProxyFaceOptions = {},
): Promise<CreateSessionOutcome> {
  const timeoutMs = options.timeoutMs ?? PROMPT_TIMEOUT_MS
  const log = options.log
  try {
    const value = await withRpcTimeout(
      dsh.session.create({
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
      }),
      timeoutMs,
    )
    if (!isRecord(value) || typeof value['sessionId'] !== 'string') {
      log?.('discord_session_create_malformed', { sessionId: request.sessionId })
      return { outcome: 'unknown' }
    }
    return { outcome: 'completed', sessionId: value['sessionId'] }
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_session_create_timeout', { timeoutMs, sessionId: request.sessionId })
      return { outcome: 'unknown' }
    }
    const rejection = remoteRejectionOf(cause)
    if (rejection !== undefined) {
      log?.('discord_session_create_rejected', { code: rejection.code, sessionId: request.sessionId })
      return { outcome: 'rejected', reason: rejectionReason(cause) }
    }
    log?.('discord_session_create_threw', { cause: String(cause), sessionId: request.sessionId })
    return { outcome: 'unknown' }
  }
}

/** The durable Session-id baseline reconciliation reconciles against. */
export type SessionIdListOutcome =
  | { outcome: 'completed'; ids: string[] }
  | { outcome: 'failed' }
  | { outcome: 'unknown' }

/** List durable Session ids (`session.list` returns everything in one page). */
export async function listSessionIds(
  dsh: DshHostFace,
  options: ApiProxyFaceOptions = {},
): Promise<SessionIdListOutcome> {
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS
  const log = options.log
  let items: unknown[]
  try {
    const value: unknown = await withRpcTimeout(dsh.session.list(undefined), timeoutMs)
    // In-process the controller returns the BARE array; the {items} envelope
    // is the typert wire shape. Accept both.
    items = Array.isArray(value) ? value : (isRecord(value) && Array.isArray(value['items']) ? value['items'] as unknown[] : [])
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_session_list_timeout', { timeoutMs })
      return { outcome: 'unknown' }
    }
    log?.('discord_session_list_threw', { cause: String(cause) })
    return { outcome: 'unknown' }
  }
  const ids: string[] = []
  for (const item of items) {
    const row = item as Partial<{ sessionId: unknown }>
    if (typeof row.sessionId === 'string' && row.sessionId !== '') ids.push(row.sessionId)
  }
  return { outcome: 'completed', ids }
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
 * The rich `session.list` for the /session resume surface: titles ride each
 * row's projection values (absence = the session has no title yet), blank
 * sessions are flagged, and rows arrive updatedAt-descending. Defensive
 * narrowing: the wire is untrusted, extra/missing fields never throw.
 */
export async function listSessionSummaries(
  dsh: DshHostFace,
  options: ApiProxyFaceOptions = {},
): Promise<SessionSummariesOutcome> {
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS
  const log = options.log
  let items: unknown[]
  try {
    const value: unknown = await withRpcTimeout(dsh.session.list(undefined), timeoutMs)
    // In-process the controller returns the BARE array; the {items} envelope
    // is the typert wire shape. Accept both.
    items = Array.isArray(value) ? value : (isRecord(value) && Array.isArray(value['items']) ? value['items'] as unknown[] : [])
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_session_summaries_timeout', { timeoutMs })
      return { outcome: 'unknown' }
    }
    log?.('discord_session_summaries_threw', { cause: String(cause) })
    return { outcome: 'unknown' }
  }
  const sessions: SessionResumeRow[] = []
  // The wire is untrusted: narrow every row defensively before use.
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
  dsh: DshHostFace,
  request: { sessionId: string },
  options: ApiProxyFaceOptions = {},
): Promise<CancelOutcome> {
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS
  const log = options.log
  try {
    await withRpcTimeout(dsh.session.cancel({ sessionId: request.sessionId }), timeoutMs)
    return { outcome: 'accepted' }
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_session_cancel_timeout', { timeoutMs, sessionId: request.sessionId })
      return { outcome: 'unknown' }
    }
    const rejection = remoteRejectionOf(cause)
    if (rejection !== undefined) {
      log?.('discord_session_cancel_rejected', { code: rejection.code, sessionId: request.sessionId })
      return { outcome: 'rejected', reason: rejectionReason(cause) }
    }
    log?.('discord_session_cancel_threw', { cause: String(cause), sessionId: request.sessionId })
    return { outcome: 'unknown' }
  }
}

export type QueueRemoveOutcome =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown' }

/** Remove one pending inbox item (`session.updateQueue`, action remove). */
export async function removeQueueItemViaProxy(
  dsh: DshHostFace,
  request: { sessionId: string; itemId: string },
  options: ApiProxyFaceOptions = {},
): Promise<QueueRemoveOutcome> {
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS
  const log = options.log
  try {
    await withRpcTimeout(
      dsh.session.updateQueue({
        sessionId: request.sessionId,
        itemId: request.itemId,
        action: { kind: 'remove' },
      }),
      timeoutMs,
    )
    return { outcome: 'accepted' }
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_queue_remove_timeout', { timeoutMs, sessionId: request.sessionId })
      return { outcome: 'unknown' }
    }
    const rejection = remoteRejectionOf(cause)
    if (rejection !== undefined) {
      log?.('discord_queue_remove_rejected', { code: rejection.code, sessionId: request.sessionId })
      return { outcome: 'rejected', reason: rejectionReason(cause) }
    }
    log?.('discord_queue_remove_threw', { cause: String(cause), sessionId: request.sessionId })
    return { outcome: 'unknown' }
  }
}

export type SessionModelsOutcome =
  | { outcome: 'completed'; models: SessionModelsShape }
  | { outcome: 'failed' }
  | { outcome: 'unknown' }

/**
 * Read the session's live selection off the `modelSelection` projection
 * (wired view `{lastUsed, next}`); defensively accept either wired or raw
 * (`pending`) state shapes. Any read failure resolves undefined — the
 * catalog default takes over, never a hard failure.
 */
async function readSessionSelection(
  dsh: DshHostFace,
  sessionId: string,
  options: ApiProxyFaceOptions,
): Promise<ModelSelectionShape | undefined> {
  const log = options.log
  let observation: Awaited<ReturnType<DshSessionQueryFace['observeSession']>> | undefined
  try {
    observation = await withRpcTimeout(dsh.sessionQuery.observeSession(sessionId), options.timeoutMs ?? CATALOG_TIMEOUT_MS)
  } catch {
    return undefined
  }
  try {
    const projections = isRecord(observation) && isRecord(observation['projections'])
      ? observation['projections'] as Record<string, unknown>
      : undefined
    const values = projections !== undefined && isRecord(projections['values'])
      ? projections['values']
      : undefined
    const selection = (values !== undefined ? values['modelSelection'] : undefined) as
      | { lastUsed?: unknown; next?: unknown; pending?: unknown }
      | undefined
    const candidate = selection?.next ?? selection?.pending ?? selection?.lastUsed
    if (candidate === null || candidate === undefined) return undefined
    const typed = candidate as Partial<ModelSelectionShape>
    if (typeof typed.provider !== 'string' || typeof typed.model !== 'string') return undefined
    return {
      provider: typed.provider,
      model: typed.model,
      ...(typeof typed.reasoningEffort === 'string' ? { reasoningEffort: typed.reasoningEffort } : {}),
    }
  } finally {
    const dispose = (observation as { [Symbol.asyncDispose]?: () => unknown } | undefined)?.[Symbol.asyncDispose]
      ?? (observation as { dispose?: () => unknown } | undefined)?.dispose
    if (typeof dispose === 'function') {
      try { void dispose.call(observation) } catch (cause) { log?.('discord_session_selection_dispose_threw', { cause: String(cause) }) }
    }
  }
}

/**
 * The session's detached model directory: the live selection, whether its
 * route still serves, and the per-provider catalog groups the /model
 * cascade browses. Composed from the 0.1.6 global `modelCatalog` plus the
 * session's `modelSelection` projection — the rc.2 per-session
 * `sessions.models` RPC no longer exists.
 */
export async function sessionModels(
  dsh: DshHostFace,
  request: { sessionId: string },
  options: ApiProxyFaceOptions = {},
): Promise<SessionModelsOutcome> {
  const timeoutMs = options.timeoutMs ?? MODELS_TIMEOUT_MS
  const log = options.log
  let catalog: ModelCatalogWireShape
  try {
    catalog = await withRpcTimeout(dsh.session.modelCatalog(), timeoutMs)
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_models_timeout', { sessionId: request.sessionId })
      return { outcome: 'unknown' }
    }
    const rejection = remoteRejectionOf(cause)
    log?.('discord_models_failed', { sessionId: request.sessionId, code: rejection?.code ?? 'malformed' })
    return { outcome: 'failed' }
  }
  if (!isRecord(catalog) || !Array.isArray(catalog['groups'])) {
    log?.('discord_models_malformed', { sessionId: request.sessionId })
    return { outcome: 'failed' }
  }
  const selection = await readSessionSelection(dsh, request.sessionId, options)
  const fallback: Record<string, unknown> = isRecord(catalog['default']) ? catalog['default'] : {}
  const current: ModelSelectionShape = selection ?? {
    provider: typeof fallback['provider'] === 'string' ? fallback['provider'] : '',
    model: typeof fallback['model'] === 'string' ? fallback['model'] : '',
    ...(typeof fallback['reasoningEffort'] === 'string' ? { reasoningEffort: fallback['reasoningEffort'] } : {}),
  }
  const routableProviders = Array.isArray(catalog['routableProviders']) ? catalog['routableProviders'] as unknown[] : []
  const routable = routableProviders.includes(current.provider)
  return {
    outcome: 'completed',
    models: {
      current,
      routable,
      groups: catalog['groups'],
      failures: Array.isArray(catalog['failures']) ? catalog['failures'] : [],
    },
  }
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
  dsh: DshHostFace,
  request: { sessionId: string; provider: string; model: string; reasoningEffort?: string },
  options: ApiProxyFaceOptions = {},
): Promise<SelectModelOutcome> {
  const timeoutMs = options.timeoutMs ?? PROMPT_TIMEOUT_MS
  const log = options.log
  try {
    const value = await withRpcTimeout(
      dsh.session.selectModel({
        sessionId: request.sessionId,
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      }),
      timeoutMs,
    )
    const selected: unknown = isRecord(value) ? value['selected'] : undefined
    if (!isRecord(selected) || typeof selected['provider'] !== 'string' || typeof selected['model'] !== 'string') {
      log?.('discord_model_select_malformed', { sessionId: request.sessionId })
      return { outcome: 'unknown' }
    }
    const chosen: ModelSelectionShape = {
      provider: selected['provider'],
      model: selected['model'],
      ...(typeof selected['reasoningEffort'] === 'string' ? { reasoningEffort: selected['reasoningEffort'] } : {}),
    }
    return { outcome: 'completed', selected: chosen }
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_model_select_timeout', { sessionId: request.sessionId })
      return { outcome: 'unknown' }
    }
    const rejection = remoteRejectionOf(cause)
    if (rejection !== undefined) {
      log?.('discord_model_select_rejected', { code: rejection.code, sessionId: request.sessionId })
      return { outcome: 'rejected', reason: rejectionReason(cause) }
    }
    log?.('discord_model_select_threw', { cause: String(cause), sessionId: request.sessionId })
    return { outcome: 'unknown' }
  }
}

/**
 * The /model surface over the session controller: the composed per-session
 * directory and the guarded selection mutation — the shapes model-control
 * reasons about.
 */
export function createModelPort(
  dsh: DshHostFace,
  options: ApiProxyFaceOptions = {},
): DshModelPort {
  return {
    models: sessionId => sessionModels(dsh, { sessionId }, options),
    selectModel: request => selectSessionModel(dsh, request, options),
  }
}

// ── The /permission surface (16.59; signatures probe-verified 2026-09-19) ──

/** One normalized preset row off the catalog's `options` array. */
export interface PermissionCatalogEntry {
  value: string
  name?: string
}

export type PermissionCatalogOutcome =
  | { outcome: 'completed'; entries: PermissionCatalogEntry[] }
  | { outcome: 'failed' }

/** Read the deployment's preset table (`permissionPresets.catalog`). */
export async function permissionCatalog(
  dsh: DshHostFace,
  options: ApiProxyFaceOptions = {},
): Promise<PermissionCatalogOutcome> {
  const log = options.log
  try {
    const catalog = await withRpcTimeout(dsh.permissionPresets.catalog(), options.timeoutMs ?? CATALOG_TIMEOUT_MS)
    if (!isRecord(catalog) || !Array.isArray(catalog['options'])) {
      log?.('discord_permission_catalog_malformed', {})
      return { outcome: 'failed' }
    }
    const entries: PermissionCatalogEntry[] = []
    for (const row of catalog['options'] as unknown[]) {
      if (!isRecord(row) || typeof row['value'] !== 'string') continue
      entries.push({
        value: row['value'],
        ...(typeof row['name'] === 'string' ? { name: row['name'] } : {}),
      })
    }
    return { outcome: 'completed', entries }
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_permission_catalog_timeout', {})
      return { outcome: 'failed' }
    }
    log?.('discord_permission_catalog_failed', { cause: String(cause) })
    return { outcome: 'failed' }
  }
}

/**
 * Read the session's current preset off the `permissions` projection view
 * (`{currentValue}`, stateVersion 2). Any read failure resolves failed —
 * show degrades to "current unknown", never a hard failure.
 */
async function readSessionPermission(
  dsh: DshHostFace,
  sessionId: string,
  options: ApiProxyFaceOptions,
): Promise<string | undefined> {
  const log = options.log
  let observation: Awaited<ReturnType<DshSessionQueryFace['observeSession']>> | undefined
  try {
    observation = await withRpcTimeout(dsh.sessionQuery.observeSession(sessionId), options.timeoutMs ?? CATALOG_TIMEOUT_MS)
  } catch {
    return undefined
  }
  try {
    const projections = isRecord(observation) && isRecord(observation['projections'])
      ? observation['projections'] as Record<string, unknown>
      : undefined
    const values = projections !== undefined && isRecord(projections['values'])
      ? projections['values']
      : undefined
    const permission = values !== undefined ? values['permissions'] : undefined
    const current = isRecord(permission) ? permission['currentValue'] : undefined
    return typeof current === 'string' ? current : undefined
  } finally {
    const dispose = (observation as { [Symbol.asyncDispose]?: () => unknown } | undefined)?.[Symbol.asyncDispose]
      ?? (observation as { dispose?: () => unknown } | undefined)?.dispose
    if (typeof dispose === 'function') {
      try { void dispose.call(observation) } catch (cause) { log?.('discord_session_permission_dispose_threw', { cause: String(cause) }) }
    }
  }
}

export type SwitchSessionPermissionOutcome =
  | { outcome: 'completed'; preset: string }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown' }

/**
 * Switch the session's preset through the Host's OWN `/permission` command
 * path (resolveAgent → commands.execute) — the same entry the web UI uses,
 * inheriting its journal audit pair and admission checks. An execute throw
 * is unknown (the command may have run): callers never retry blindly.
 */
export async function switchSessionPermission(
  dsh: DshHostFace,
  request: { sessionId: string; preset: string },
  options: ApiProxyFaceOptions = {},
): Promise<SwitchSessionPermissionOutcome> {
  const log = options.log
  const controller = new AbortController()
  try {
    const resolved = await withRpcTimeout(dsh.session.resolveAgent(request.sessionId), options.timeoutMs ?? PROMPT_TIMEOUT_MS)
    if (!isRecord(resolved) || resolved['agent'] === undefined) {
      const message = isRecord(resolved['error']) && typeof resolved['error']['message'] === 'string'
        ? resolved['error']['message']
        : 'session unavailable'
      log?.('discord_permission_agent_unresolved', { sessionId: request.sessionId })
      return { outcome: 'rejected', reason: message }
    }
    const agent: unknown = resolved['agent']
    const execution = await withRpcTimeout(
      dsh.commands.execute(agent, `/permission ${request.preset}`, [], controller.signal),
      options.timeoutMs ?? PROMPT_TIMEOUT_MS,
    )
    if (execution === undefined) {
      // Unmatched command: this Host has no /permission registered.
      log?.('discord_permission_command_missing', { sessionId: request.sessionId })
      return { outcome: 'rejected', reason: 'the Host has no /permission command' }
    }
    const result = isRecord(execution) && isRecord(execution['result']) ? execution['result'] : undefined
    const kind = result !== undefined ? result['kind'] : undefined
    const text = result !== undefined && typeof result['text'] === 'string' ? result['text'] : ''
    if (kind === 'success') {
      return { outcome: 'completed', preset: request.preset }
    }
    log?.('discord_permission_command_error', { sessionId: request.sessionId, text })
    return { outcome: 'rejected', reason: text === '' ? 'the Host rejected the switch' : text }
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) {
      log?.('discord_permission_switch_timeout', { sessionId: request.sessionId })
      return { outcome: 'unknown' }
    }
    log?.('discord_permission_switch_threw', { sessionId: request.sessionId, cause: String(cause) })
    return { outcome: 'unknown' }
  }
}

/** The /permission surface over the controller, command, and preset services. */
export function createPermissionPort(
  dsh: DshHostFace,
  options: ApiProxyFaceOptions = {},
): DshPermissionPort {
  return {
    catalog: () => permissionCatalog(dsh, options),
    current: async sessionId => {
      const preset = await readSessionPermission(dsh, sessionId, options)
      return preset === undefined ? { outcome: 'failed' } : { outcome: 'completed', preset }
    },
    set: (sessionId, preset) => switchSessionPermission(dsh, { sessionId, preset }, options),
  }
}
