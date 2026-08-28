/**
 * Thread routing (design.md §4). A thread bound to a Session always routes to
 * that Session and its immutable cwd workspace — channel rebinds cannot move
 * it. Routing prefers the thread binding, falls back to the channel's current
 * workspace for NEW threads, and reports unbound when neither exists. New
 * thread bindings go through the same revision-fenced store so a duplicate
 * Thread-create race cannot rebind an existing thread to a different session.
 */

import type { ThreadBinding } from '../state/records.js'
import { threadBindingKey, type ThreadBindingScope } from '../state/domain.js'
import type { BindingStore } from '../state/bindings.js'

export interface ThreadRoutingDeps {
  threadBindings: BindingStore<ThreadBinding>
  applicationId: string
}

export type ThreadRoute =
  | { route: 'existing-session'; sessionId: string; workspaceId: string }
  | { route: 'new-session'; workspaceId: string }
  | { route: 'unbound' }

export interface ThreadRoutingService {
  bindThread(request: {
    scope: ThreadBindingScope
    request: { sessionId: string; workspaceId: string; createdBy: string; nowMs: number }
  }): Promise<{ ok: true; binding: ThreadBinding } | { ok: false; error: 'already-bound' | 'stale-revision' | 'not-bound' }>
  route(input: {
    guildId: string
    threadId: string
    /** The channel's current binding; undefined when the channel is unbound. */
    channelWorkspaceId: string | undefined
  }): ThreadRoute
}

export function createThreadRoutingService(deps: ThreadRoutingDeps): ThreadRoutingService {
  return {
    async bindThread({ scope, request }) {
      const result = await deps.threadBindings.bind(threadBindingKey(scope), {
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        createdBy: request.createdBy,
        createdAtMs: request.nowMs,
      })
      if (result.ok) return { ok: true, binding: result.binding }
      return { ok: false, error: result.error }
    },
    route({ guildId, threadId, channelWorkspaceId }) {
      const binding = deps.threadBindings.get(
        threadBindingKey({ applicationId: deps.applicationId, guildId, threadId }),
      )
      if (binding !== undefined) {
        return { route: 'existing-session', sessionId: binding.sessionId, workspaceId: binding.workspaceId }
      }
      if (channelWorkspaceId !== undefined) {
        return { route: 'new-session', workspaceId: channelWorkspaceId }
      }
      return { route: 'unbound' }
    },
  }
}
