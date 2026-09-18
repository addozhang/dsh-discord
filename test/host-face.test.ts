/**
 * The in-process 0.1.6 controller face (host-face.ts). Contract under test:
 * the Host's plain-value controller methods are consumed by shape (values in,
 * thrown RemoteErrors as business rejections), the `session/` error-code
 * namespace is translated onto the adapter's stable reason vocabulary, every
 * call is bounded (a silent Host resolves to an unobservable outcome instead
 * of wedging the handler), and every terminal outcome is reported through
 * the log sink.
 */

import { describe, expect, it } from 'vitest'

import {
  cancelSessionViaProxy,
  createSessionViaProxy,
  createWorkspaceCatalogPort,
  createWorkspaceResolver,
  promptSession,
  removeQueueItemViaProxy,
  RpcTimeoutError,
  steerSession,
  withRpcTimeout,
  listSessionSummaries,
  sessionModels,
  type DshHostFace,
} from '../src/dsh/host-face.js'

/** One thrown Host RemoteError ({code, message}) — the 0.1.6 rejection carrier. */
function remoteError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

type SessionFace = DshHostFace['session'] & {
  promptCalls: Array<Record<string, unknown>>
}

function face(
  baseline?: (() => unknown),
  prompt?: () => Promise<unknown>,
  sessionList?: () => Promise<unknown>,
  observation?: () => Promise<unknown>,
): DshHostFace & { session: SessionFace } {
  const promptCalls: Array<Record<string, unknown>> = []
  const session: SessionFace = {
    promptCalls,
    prompt(request, _signal) {
      void _signal
      promptCalls.push(request as unknown as Record<string, unknown>)
      return (prompt ? prompt() : Promise.resolve({ accepted: true as const })) as ReturnType<SessionFace['prompt']>
    },
    create: () => (sessionCreate ? sessionCreate() : Promise.resolve({ sessionId: 'sess-1' })) as ReturnType<SessionFace['create']>,
    cancel: () => (sessionCancel ? sessionCancel() : Promise.resolve({ accepted: true as const })) as ReturnType<SessionFace['cancel']>,
    updateQueue: () => (sessionUpdateQueue ? sessionUpdateQueue() : Promise.resolve({ accepted: true as const })) as ReturnType<SessionFace['updateQueue']>,
    list: (_signal) => (sessionList ? sessionList() : Promise.resolve({ items: [] })) as ReturnType<SessionFace['list']>,
    selectModel: () => Promise.resolve({ selected: { provider: 'p', model: 'm' } }) as ReturnType<SessionFace['selectModel']>,
    modelCatalog: () => (modelCatalog ? modelCatalog() : Promise.resolve({
      default: { provider: 'p', model: 'm' },
      routableProviders: ['p'],
      groups: [],
      failures: [],
    })) as ReturnType<SessionFace['modelCatalog']>,
    follow: () => { throw new Error('not under test') },
    control: () => { throw new Error('not under test') },
  }
  let sessionCreate: (() => Promise<unknown>) | undefined
  let sessionCancel: (() => Promise<unknown>) | undefined
  let sessionUpdateQueue: (() => Promise<unknown>) | undefined
  let modelCatalog: (() => Promise<unknown>) | undefined
  const wired = {
    session,
    workspace: {
      follow: (signal: AbortSignal) => ({
        async *[Symbol.asyncIterator]() {
          if (signal.aborted) return
          const value = baseline ? await baseline() : { items: [], archivedSessionIds: [] }
          yield { type: 'baseline', value }
        },
      }),
    },
    sessionQuery: {
      observeSession: () => (observation ? observation() : Promise.resolve({})) as ReturnType<DshHostFace['sessionQuery']['observeSession']>,
    },
  } as DshHostFace & { session: SessionFace }
  // Late-bound mutators so individual cases can override after construction.
  Object.defineProperties(wired, {
    __setCreate: { value: (fn: () => Promise<unknown>) => { sessionCreate = fn } },
    __setCancel: { value: (fn: () => Promise<unknown>) => { sessionCancel = fn } },
    __setUpdateQueue: { value: (fn: () => Promise<unknown>) => { sessionUpdateQueue = fn } },
    __setModelCatalog: { value: (fn: () => Promise<unknown>) => { modelCatalog = fn } },
  })
  return wired
}

describe('withRpcTimeout', () => {
  it('resolves when the Host answers in time', async () => {
    await expect(withRpcTimeout(Promise.resolve('value'), 1_000)).resolves.toBe('value')
  })

  it('rejects with RpcTimeoutError when the Host never answers', async () => {
    const never = new Promise<never>(() => {})
    await expect(withRpcTimeout(never, 10)).rejects.toBeInstanceOf(RpcTimeoutError)
  })
})

describe('createWorkspaceCatalogPort', () => {
  it('maps a successful baseline onto the completed outcome', async () => {
    const port = createWorkspaceCatalogPort(face(() => ({
      items: [{ workspaceId: 'ws-1', title: 'Alpha' }],
      archivedSessionIds: [],
    })))
    await expect(port.listWorkspaces()).resolves.toEqual({
      outcome: 'completed',
      workspaces: [{ id: 'ws-1', title: 'Alpha' }],
      archivedSessionIds: [],
    })
  })

  it('carries the Host-supplied path through to the catalog rows (16.46)', async () => {
    // Regression 16.46: the narrowing map once dropped `path`, so the
    // /session resume workspace scoping (cwd === registered path) filtered
    // to zero candidates in every channel — and /project autocomplete
    // labels silently lost their abbreviated paths.
    const port = createWorkspaceCatalogPort(face(() => ({
      items: [
        { workspaceId: 'ws-1', title: 'Alpha', path: '/private/tmp' },
        { workspaceId: 'ws-2', title: 'NoPath' },
      ],
      archivedSessionIds: ['session-abc', 'def-1'],
    })))
    await expect(port.listWorkspaces()).resolves.toEqual({
      outcome: 'completed',
      workspaces: [
        { id: 'ws-1', title: 'Alpha', path: '/private/tmp' },
        { id: 'ws-2', title: 'NoPath' },
      ],
      archivedSessionIds: ['session-abc', 'def-1'],
    })
  })

  it('maps a definitive Host rejection onto failed, with the code logged', async () => {
    const logged: Array<[string, unknown]> = []
    const port = createWorkspaceCatalogPort(face(() => { throw remoteError('gateway/internal', 'boom') }), {
      log: (event, detail) => { logged.push([event, detail]) },
    })
    await expect(port.listWorkspaces()).resolves.toEqual({ outcome: 'failed' })
    expect(logged.some(([event]) => event === 'discord_workspace_list_threw')).toBe(true)
  })

  it('maps a hung Host onto unknown within the bounded window', async () => {
    const hung = face(() => new Promise<never>(() => {}))
    const port = createWorkspaceCatalogPort(hung, { timeoutMs: 10 })
    await expect(port.listWorkspaces()).resolves.toEqual({ outcome: 'unknown' })
  })

  it('maps a stream that closes before the baseline onto failed', async () => {
    const logged: Array<[string, unknown]> = []
    const emptyStream = face(() => { throw new Error('no baseline') })
    const port = createWorkspaceCatalogPort(emptyStream, { log: (event) => { logged.push([event, undefined]) } })
    await expect(port.listWorkspaces()).resolves.toEqual({ outcome: 'failed' })
    expect(logged.some(([event]) => event === 'discord_workspace_list_threw')).toBe(true)
  })

  it('treats a malformed frame as a definitive failed outcome, never a completed empty catalog', async () => {
    const logged: Array<[string, unknown]> = []
    // A first frame that is not a baseline envelope: the value rides a non-baseline type.
    const port = createWorkspaceCatalogPort(face(() => { throw new Error('workspace baseline frame is malformed') }), {
      log: (event) => { logged.push([event, undefined]) },
    })
    await expect(port.listWorkspaces()).resolves.toEqual({ outcome: 'failed' })
    expect(logged.some(([event]) => event === 'discord_workspace_list_threw')).toBe(true)
  })
})

describe('listSessionSummaries', () => {
  it('narrows wire rows defensively and carries the subagent origin (16.48)', async () => {
    const result = await listSessionSummaries(face(undefined, undefined, () => Promise.resolve({
      items: [
        { sessionId: 's-1', updatedAt: 5, running: false, blank: false, cwd: '/w', origin: 'subagent', projections: { values: { title: 'Spawned probe' } } },
        { sessionId: 's-2', updatedAt: 4, running: true, blank: false, cwd: '/w' },
        { sessionId: '', updatedAt: 3, running: false, blank: false },
        'garbage',
      ],
    })))
    expect(result).toEqual({
      outcome: 'completed',
      sessions: [
        { sessionId: 's-1', title: 'Spawned probe', updatedAt: 5, running: false, blank: false, cwd: '/w', origin: 'subagent' },
        { sessionId: 's-2', title: undefined, updatedAt: 4, running: true, blank: false, cwd: '/w' },
      ],
    })
  })
})

describe('createWorkspaceResolver', () => {
  const withCatalog = (items: Array<{ workspaceId: string; title: string }>): DshHostFace =>
    face(() => ({ items, archivedSessionIds: [] }))

  it('resolves a known ws: reference to the sanitized workspace pair', async () => {
    const resolver = createWorkspaceResolver(withCatalog([
      { workspaceId: 'ws-1', title: 'Alpha' },
    ]))
    await expect(resolver.resolve('ws:ws-1')).resolves.toEqual({
      outcome: 'found',
      workspace: { id: 'ws-1', title: 'Alpha' },
    })
  })

  it('resolves a well-formed unknown reference as stale', async () => {
    const resolver = createWorkspaceResolver(withCatalog([]))
    await expect(resolver.resolve('ws:gone')).resolves.toEqual({ outcome: 'stale' })
  })

  it('resolves a malformed reference as stale without reading a workspace', async () => {
    const resolver = createWorkspaceResolver(withCatalog([{ workspaceId: 'ws-1', title: 'Alpha' }]))
    await expect(resolver.resolve('not-a-reference')).resolves.toEqual({ outcome: 'stale' })
    await expect(resolver.resolve('ws:')).resolves.toEqual({ outcome: 'stale' })
  })

  it('propagates a hung catalog as unknown', async () => {
    const resolver = createWorkspaceResolver(face(() => new Promise<never>(() => {})), { timeoutMs: 10 })
    await expect(resolver.resolve('ws:ws-1')).resolves.toEqual({ outcome: 'unknown' })
  })

  it('propagates a definitive Host error as failed', async () => {
    const resolver = createWorkspaceResolver(face(() => { throw remoteError('gateway/internal', 'boom') }))
    await expect(resolver.resolve('ws:ws-1')).resolves.toEqual({ outcome: 'failed' })
  })
})

describe('promptSession', () => {
  it('accepts when the controller returns', async () => {
    await expect(promptSession(face(undefined, () => Promise.resolve({ accepted: true })), {
      sessionId: 's-1',
      prompt: 'hi',
    })).resolves.toEqual({ outcome: 'accepted' })
  })

  it('rejects with the session/ prefix stripped on a definitive Host rejection', async () => {
    await expect(promptSession(face(undefined, () => Promise.reject(remoteError('session/agent-busy', 'prompt rejected'))), {
      sessionId: 's-1',
      prompt: 'hi',
    })).resolves.toEqual({ outcome: 'rejected', reason: 'agent-busy' })
  })

  it('passes non-session namespaces through verbatim', async () => {
    await expect(promptSession(face(undefined, () => Promise.reject(remoteError('gateway/bad-request', 'empty content'))), {
      sessionId: 's-1',
      prompt: 'hi',
    })).resolves.toEqual({ outcome: 'rejected', reason: 'gateway/bad-request' })
  })

  it('maps a host fault (non-Remote throw) onto unknown, never rejected', async () => {
    await expect(promptSession(face(undefined, () => Promise.reject(new Error('host bug'))), {
      sessionId: 's-1',
      prompt: 'hi',
    })).resolves.toEqual({ outcome: 'unknown' })
  })

  it('maps a hung Host onto unknown within the bounded window', async () => {
    await expect(promptSession(face(undefined, () => new Promise<never>(() => {})), {
      sessionId: 's-1',
      prompt: 'hi',
    }, { timeoutMs: 10 })).resolves.toEqual({ outcome: 'unknown' })
  })

  it('submits the adapter-owned requestId (the 0.1.6 required idempotency key)', async () => {
    const f = face(undefined, () => Promise.resolve({ accepted: true }))
    await promptSession(f, { sessionId: 's-1', prompt: 'hi' }, { rpcId: 'discord:m-1' })
    expect(f.session.promptCalls[0]).toEqual({
      requestId: 'discord:m-1',
      sessionId: 's-1',
      mode: 'queue',
      content: [{ type: 'text', text: 'hi' }],
    })
  })

  it('mints a fresh requestId when the caller supplies none', async () => {
    const f = face(undefined, () => Promise.resolve({ accepted: true }))
    await promptSession(f, { sessionId: 's-1', prompt: 'hi' })
    const requestId = f.session.promptCalls[0]?.['requestId']
    expect(typeof requestId).toBe('string')
    expect(requestId).not.toBe('')
  })

  it('encodes image attachments as ordered image parts after the text part (16.50)', async () => {
    const f = face(undefined, () => Promise.resolve({ accepted: true }))
    await promptSession(f, {
      sessionId: 's-1',
      prompt: 'what is this',
      images: [
        { mediaType: 'image/png', base64: 'cG5n' },
        { mediaType: 'image/gif', base64: 'Z2lm' },
      ],
    })
    const seen = f.session.promptCalls[0] as { requestId?: unknown; sessionId?: unknown; mode?: unknown; content?: unknown }
    expect(typeof seen.requestId).toBe('string')
    expect(seen.sessionId).toBe('s-1')
    expect(seen.mode).toBe('queue')
    expect(seen.content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image', mediaType: 'image/png', data: 'cG5n' },
      { type: 'image', mediaType: 'image/gif', data: 'Z2lm' },
    ])
  })
})

describe('createSessionViaProxy', () => {
  it('completes with the Host-adopted session id', async () => {
    const f = face()
    ;(f as unknown as { __setCreate: (fn: () => Promise<unknown>) => void }).__setCreate(() => Promise.resolve({ sessionId: 'sess-1' }))
    await expect(createSessionViaProxy(f, { sessionId: 'sess-1', workspaceId: 'ws-1' }))
      .resolves.toEqual({ outcome: 'completed', sessionId: 'sess-1' })
  })

  it('rejects with the sanitized code', async () => {
    const f = face()
    ;(f as unknown as { __setCreate: (fn: () => Promise<unknown>) => void }).__setCreate(() => Promise.reject(remoteError('session/conflict', 'cwd mismatch')))
    await expect(createSessionViaProxy(f, { sessionId: 'sess-1', workspaceId: 'ws-1' }))
      .resolves.toEqual({ outcome: 'rejected', reason: 'conflict' })
  })

  it('maps a hung Host onto unknown', async () => {
    const f = face()
    ;(f as unknown as { __setCreate: (fn: () => Promise<unknown>) => void }).__setCreate(() => new Promise<never>(() => {}))
    await expect(createSessionViaProxy(f, { sessionId: 'sess-1', workspaceId: 'ws-1' }, { timeoutMs: 10 }))
      .resolves.toEqual({ outcome: 'unknown' })
  })

  it('treats a malformed value as unknown (adoption unobservable)', async () => {
    const f = face()
    ;(f as unknown as { __setCreate: (fn: () => Promise<unknown>) => void }).__setCreate(() => Promise.resolve({ noSessionId: true }))
    await expect(createSessionViaProxy(f, { sessionId: 'sess-1', workspaceId: 'ws-1' }))
      .resolves.toEqual({ outcome: 'unknown' })
  })
})

describe('steerSession / cancelSessionViaProxy / removeQueueItemViaProxy', () => {
  it('steers with mode steer and a stable requestId', async () => {
    const f = face(undefined, () => Promise.resolve({ accepted: true }))
    await expect(steerSession(f, { sessionId: 's-1', prompt: 'focus' }, { rpcId: 'req-9' }))
      .resolves.toEqual({ outcome: 'accepted' })
    expect(f.session.promptCalls[0]).toEqual({
      requestId: 'req-9',
      sessionId: 's-1',
      mode: 'steer',
      content: [{ type: 'text', text: 'focus' }],
    })
  })

  it('cancels a session turn', async () => {
    const f = face()
    await expect(cancelSessionViaProxy(f, { sessionId: 's-1' })).resolves.toEqual({ outcome: 'accepted' })
  })

  it('maps cancel rejection to rejected with the translated code', async () => {
    const f = face()
    ;(f as unknown as { __setCancel: (fn: () => Promise<unknown>) => void }).__setCancel(() => Promise.reject(remoteError('session/agent-busy', 'not running')))
    await expect(cancelSessionViaProxy(f, { sessionId: 's-1' })).resolves.toEqual({ outcome: 'rejected', reason: 'agent-busy' })
  })

  it('removes one queue item', async () => {
    const seen: Array<unknown> = []
    const f = face()
    ;(f as unknown as { __setUpdateQueue: (fn: () => Promise<unknown>) => void }).__setUpdateQueue(() => Promise.resolve({ accepted: true }))
    // Capture through a wrapping face: the controller receives the exact mutation shape.
    const wrapped: DshHostFace = {
      ...f,
      session: {
        ...f.session,
        updateQueue(request) {
          seen.push(request)
          return Promise.resolve({ accepted: true })
        },
      },
    }
    await expect(removeQueueItemViaProxy(wrapped, { sessionId: 's-1', itemId: 'm-2' })).resolves.toEqual({ outcome: 'accepted' })
    expect(seen[0]).toEqual({ sessionId: 's-1', itemId: 'm-2', action: { kind: 'remove' } })
  })
})

describe('sessionModels (modelCatalog + modelSelection projection)', () => {
  it('composes the session selection over the host-wide catalog', async () => {
    const f = face(
      undefined,
      undefined,
      undefined,
      () => Promise.resolve({
        projections: { values: { modelSelection: { lastUsed: null, next: { provider: 'deepseek', model: 'ds-4' } } } },
      }),
    )
    ;(f as unknown as { __setModelCatalog: (fn: () => Promise<unknown>) => void }).__setModelCatalog(() => Promise.resolve({
      default: { provider: 'p', model: 'm' },
      routableProviders: ['deepseek'],
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [] }],
      failures: [],
    }))
    await expect(sessionModels(f, { sessionId: 's-1' })).resolves.toEqual({
      outcome: 'completed',
      models: {
        current: { provider: 'deepseek', model: 'ds-4' },
        routable: true,
        groups: [{ id: 'deepseek', name: 'DeepSeek', models: [] }],
        failures: [],
      },
    })
  })

  it('falls back to the catalog default when the projection read fails or is absent', async () => {
    const f = face(undefined, undefined, undefined, () => Promise.reject(new Error('no session')))
    await expect(sessionModels(f, { sessionId: 's-1' })).resolves.toEqual({
      outcome: 'completed',
      models: {
        current: { provider: 'p', model: 'm' },
        routable: true,
        groups: [],
        failures: [],
      },
    })
  })

  it('maps an unroutable current selection onto routable false', async () => {
    const f = face(
      undefined,
      undefined,
      undefined,
      () => Promise.resolve({
        projections: { values: { modelSelection: { lastUsed: { provider: 'gone', model: 'x' }, next: null } } },
      }),
    )
    await expect(sessionModels(f, { sessionId: 's-1' })).resolves.toMatchObject({
      outcome: 'completed',
      models: {
        current: { provider: 'gone', model: 'x' },
        routable: false,
      },
    })
  })

  it('maps a rejected catalog read onto failed', async () => {
    const f = face()
    ;(f as unknown as { __setModelCatalog: (fn: () => Promise<unknown>) => void }).__setModelCatalog(() => Promise.reject(remoteError('gateway/internal', 'boom')))
    await expect(sessionModels(f, { sessionId: 's-1' })).resolves.toEqual({ outcome: 'failed' })
  })
})
