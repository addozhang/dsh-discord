/**
 * The in-process apiProxy face (9.x live-wiring). Contract under test: the
 * Host's RpcResponse envelope is parsed by shape (`result.ok` / `result.value`,
 * never a `payload` slot), every call is bounded (a silent Host resolves to an
 * unobservable outcome instead of wedging the handler), and every terminal
 * outcome is reported through the log sink.
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
  type DshApiProxyFace,
  type RpcResponseShape,
} from '../src/dsh/api-proxy-face.js'

function ok<T>(value: T): RpcResponseShape<T> {
  return { rpcId: 'rpc-1', result: { ok: true, value } }
}

function err(code: string, message: string): RpcResponseShape<never> {
  return { rpcId: 'rpc-1', result: { ok: false, error: { code, message } } }
}

function face(
  workspaceList?: Promise<unknown>,
  prompt?: Promise<unknown>,
  sessionList?: Promise<unknown>,
): DshApiProxyFace {
  return {
    workspace: {
      list: () => (workspaceList ?? Promise.resolve(ok({ items: [] }))) as ReturnType<DshApiProxyFace['workspace']['list']>,
    },
    sessions: {
      prompt: () => (prompt ?? Promise.resolve(ok({ accepted: true }))) as ReturnType<DshApiProxyFace['sessions']['prompt']>,
      create: () => Promise.resolve(ok({ sessionId: 'sess-1' })) as ReturnType<DshApiProxyFace['sessions']['create']>,
      cancel: () => Promise.resolve(ok({ accepted: true })) as ReturnType<DshApiProxyFace['sessions']['cancel']>,
      updateQueue: () => Promise.resolve(ok({ accepted: true })) as ReturnType<DshApiProxyFace['sessions']['updateQueue']>,
      list: () => (sessionList ?? Promise.resolve(ok({ items: [] }))) as ReturnType<DshApiProxyFace['sessions']['list']>,
      models: () => Promise.resolve(ok({
        current: { provider: 'p', model: 'm' },
        routable: true,
        groups: [],
        failures: [],
      })) as ReturnType<DshApiProxyFace['sessions']['models']>,
      selectModel: () => Promise.resolve(ok({ selected: { provider: 'p', model: 'm' } })) as ReturnType<DshApiProxyFace['sessions']['selectModel']>,
    },
  }
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
  it('maps a successful RpcResponse onto the completed outcome', async () => {
    const port = createWorkspaceCatalogPort(face(Promise.resolve(ok({
      items: [{ workspaceId: 'ws-1', title: 'Alpha' }],
    }))))
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
    const port = createWorkspaceCatalogPort(face(Promise.resolve(ok({
      items: [
        { workspaceId: 'ws-1', title: 'Alpha', path: '/private/tmp' },
        { workspaceId: 'ws-2', title: 'NoPath' },
      ],
      archivedSessionIds: ['session-abc', 'def-1'],
    }))))
    await expect(port.listWorkspaces()).resolves.toEqual({
      outcome: 'completed',
      workspaces: [
        { id: 'ws-1', title: 'Alpha', path: '/private/tmp' },
        { id: 'ws-2', title: 'NoPath' },
      ],
      archivedSessionIds: ['session-abc', 'def-1'],
    })
  })

  it('maps a definitive Host error onto failed, with the code logged', async () => {
    const logged: Array<[string, unknown]> = []
    const port = createWorkspaceCatalogPort(face(Promise.resolve(err('internal', 'boom'))), {
      log: (event, detail) => { logged.push([event, detail]) },
    })
    await expect(port.listWorkspaces()).resolves.toEqual({ outcome: 'failed' })
    expect(logged.some(([event]) => event === 'discord_workspace_list_rejected')).toBe(true)
  })

  it('maps a hung Host onto unknown within the bounded window', async () => {
    const port = createWorkspaceCatalogPort(face(new Promise<never>(() => {})), { timeoutMs: 10 })
    await expect(port.listWorkspaces()).resolves.toEqual({ outcome: 'unknown' })
  })

  it('treats a malformed body as a definitive failed outcome, never a completed empty catalog', async () => {
    const logged: Array<[string, unknown]> = []
    const port = createWorkspaceCatalogPort(face(Promise.resolve(undefined as unknown as RpcResponseShape<{ items: never[] }>)), {
      log: (event) => { logged.push([event, undefined]) },
    })
    await expect(port.listWorkspaces()).resolves.toEqual({ outcome: 'failed' })
    expect(logged.some(([event]) => event === 'discord_workspace_list_malformed')).toBe(true)
  })
})

describe('listSessionSummaries', () => {
  it('narrows wire rows defensively and carries the subagent origin (16.48)', async () => {
    const port = await listSessionSummaries(face(undefined, undefined, Promise.resolve(ok({
      items: [
        { sessionId: 's-1', updatedAt: 5, running: false, blank: false, cwd: '/w', origin: 'subagent', projections: { values: { title: 'Spawned probe' } } },
        { sessionId: 's-2', updatedAt: 4, running: true, blank: false, cwd: '/w' },
        { sessionId: '', updatedAt: 3, running: false, blank: false },
        'garbage',
      ],
    }))))
    expect(port).toEqual({
      outcome: 'completed',
      sessions: [
        { sessionId: 's-1', title: 'Spawned probe', updatedAt: 5, running: false, blank: false, cwd: '/w', origin: 'subagent' },
        { sessionId: 's-2', title: undefined, updatedAt: 4, running: true, blank: false, cwd: '/w' },
      ],
    })
  })
})

describe('createWorkspaceResolver', () => {
  const withCatalog = (items: Array<{ workspaceId: string; title: string }>): DshApiProxyFace =>
    face(Promise.resolve(ok({ items })))

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
    const resolver = createWorkspaceResolver(face(new Promise<never>(() => {})), { timeoutMs: 10 })
    await expect(resolver.resolve('ws:ws-1')).resolves.toEqual({ outcome: 'unknown' })
  })

  it('propagates a definitive Host error as failed', async () => {
    const resolver = createWorkspaceResolver(face(Promise.resolve(err('internal', 'boom'))))
    await expect(resolver.resolve('ws:ws-1')).resolves.toEqual({ outcome: 'failed' })
  })
})

describe('promptSession', () => {
  it('accepts when the Host echoes accepted', async () => {
    await expect(promptSession(face(undefined, Promise.resolve(ok({ accepted: true }))), {
      sessionId: 's-1',
      prompt: 'hi',
    })).resolves.toEqual({ outcome: 'accepted' })
  })

  it('rejects with the sanitized code on a definitive Host error', async () => {
    await expect(promptSession(face(undefined, Promise.resolve(err('session-not-found', 'no such session'))), {
      sessionId: 's-1',
      prompt: 'hi',
    })).resolves.toEqual({ outcome: 'rejected', reason: 'session-not-found' })
  })

  it('maps a hung Host onto unknown within the bounded window', async () => {
    await expect(promptSession(face(undefined, new Promise<never>(() => {})), {
      sessionId: 's-1',
      prompt: 'hi',
    }, { timeoutMs: 10 })).resolves.toEqual({ outcome: 'unknown' })
  })

  it('submits the adapter-owned requestId as the RPC id', async () => {
    const seen: Array<{ rpcId: string; payload: unknown }> = []
    const capturing = face(undefined, Promise.resolve(ok({ accepted: true })))
    capturing.sessions.prompt = (request) => {
      seen.push({ rpcId: request.rpcId, payload: request.payload })
      return Promise.resolve(ok({ accepted: true })) as ReturnType<DshApiProxyFace['sessions']['prompt']>
    }
    await promptSession(capturing, { sessionId: 's-1', prompt: 'hi' }, { rpcId: 'discord:m-1' })
    expect(seen[0]?.rpcId).toBe('discord:m-1')
    expect(seen[0]?.payload).toEqual({
      sessionId: 's-1',
      mode: 'queue',
      content: [{ type: 'text', text: 'hi' }],
    })
  })

  it('encodes image attachments as ordered image parts after the text part (16.50)', async () => {
    const seen: Array<{ payload: unknown }> = []
    const capturing = face(undefined, Promise.resolve(ok({ accepted: true })))
    capturing.sessions.prompt = (request) => {
      seen.push({ payload: request.payload })
      return Promise.resolve(ok({ accepted: true })) as ReturnType<DshApiProxyFace['sessions']['prompt']>
    }
    await promptSession(capturing, {
      sessionId: 's-1',
      prompt: 'what is this',
      images: [
        { mediaType: 'image/png', base64: 'cG5n' },
        { mediaType: 'image/gif', base64: 'Z2lm' },
      ],
    })
    expect(seen[0]?.payload).toEqual({
      sessionId: 's-1',
      mode: 'queue',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', mediaType: 'image/png', data: 'cG5n' },
        { type: 'image', mediaType: 'image/gif', data: 'Z2lm' },
      ],
    })
  })
})

describe('createSessionViaProxy', () => {
  it('completes with the Host-adopted session id', async () => {
    const f = face()
    f.sessions.create = () => Promise.resolve(ok({ sessionId: 'sess-1' })) as ReturnType<DshApiProxyFace['sessions']['create']>
    await expect(createSessionViaProxy(f, { sessionId: 'sess-1', workspaceId: 'ws-1' }))
      .resolves.toEqual({ outcome: 'completed', sessionId: 'sess-1' })
  })

  it('rejects with the sanitized code', async () => {
    const f = face()
    f.sessions.create = () => Promise.resolve(err('session-conflict', 'cwd mismatch')) as ReturnType<DshApiProxyFace['sessions']['create']>
    await expect(createSessionViaProxy(f, { sessionId: 'sess-1', workspaceId: 'ws-1' }))
      .resolves.toEqual({ outcome: 'rejected', reason: 'session-conflict' })
  })

  it('maps a hung Host onto unknown', async () => {
    const f = face()
    f.sessions.create = () => new Promise<never>(() => {}) as ReturnType<DshApiProxyFace['sessions']['create']>
    await expect(createSessionViaProxy(f, { sessionId: 'sess-1', workspaceId: 'ws-1' }, { timeoutMs: 10 }))
      .resolves.toEqual({ outcome: 'unknown' })
  })
})

describe('steerSession / cancelSessionViaProxy / removeQueueItemViaProxy', () => {
  it('steers with mode steer and a stable rpcId', async () => {
    const seen: Array<{ rpcId: string; payload: unknown }> = []
    const f = face(undefined, Promise.resolve(ok({ accepted: true })))
    f.sessions.prompt = (request) => {
      seen.push({ rpcId: request.rpcId, payload: request.payload })
      return Promise.resolve(ok({ accepted: true })) as ReturnType<DshApiProxyFace['sessions']['prompt']>
    }
    await expect(steerSession(f, { sessionId: 's-1', prompt: 'focus' }, { rpcId: 'req-9' }))
      .resolves.toEqual({ outcome: 'accepted' })
    expect(seen[0]?.rpcId).toBe('req-9')
    expect(seen[0]?.payload).toEqual({
      sessionId: 's-1',
      mode: 'steer',
      content: [{ type: 'text', text: 'focus' }],
    })
  })

  it('cancels a session turn', async () => {
    const f = face()
    f.sessions.cancel = () => Promise.resolve(ok({ accepted: true })) as ReturnType<DshApiProxyFace['sessions']['cancel']>
    await expect(cancelSessionViaProxy(f, { sessionId: 's-1' })).resolves.toEqual({ outcome: 'accepted' })
  })

  it('maps cancel rejection to rejected', async () => {
    const f = face()
    f.sessions.cancel = () => Promise.resolve(err('agent-busy', 'not running')) as ReturnType<DshApiProxyFace['sessions']['cancel']>
    await expect(cancelSessionViaProxy(f, { sessionId: 's-1' })).resolves.toEqual({ outcome: 'rejected', reason: 'agent-busy' })
  })

  it('removes one queue item', async () => {
    const seen: Array<unknown> = []
    const f = face()
    f.sessions.updateQueue = (request) => {
      seen.push(request.payload)
      return Promise.resolve(ok({ accepted: true })) as ReturnType<DshApiProxyFace['sessions']['updateQueue']>
    }
    await expect(removeQueueItemViaProxy(f, { sessionId: 's-1', itemId: 'm-2' })).resolves.toEqual({ outcome: 'accepted' })
    expect(seen[0]).toEqual({ sessionId: 's-1', itemId: 'm-2', action: { kind: 'remove' } })
  })
})
