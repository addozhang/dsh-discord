/**
 * The in-process apiProxy face (9.x live-wiring). Contract under test: the
 * Host's RpcResponse envelope is parsed by shape (`result.ok` / `result.value`,
 * never a `payload` slot), every call is bounded (a silent Host resolves to an
 * unobservable outcome instead of wedging the handler), and every terminal
 * outcome is reported through the log sink.
 */

import { describe, expect, it } from 'vitest'

import {
  createWorkspaceCatalogPort,
  promptSession,
  RpcTimeoutError,
  withRpcTimeout,
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
): DshApiProxyFace {
  return {
    workspace: {
      list: () => (workspaceList ?? Promise.resolve(ok({ items: [] }))) as ReturnType<DshApiProxyFace['workspace']['list']>,
    },
    sessions: {
      prompt: () => (prompt ?? Promise.resolve(ok({ accepted: true }))) as ReturnType<DshApiProxyFace['sessions']['prompt']>,
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
})
