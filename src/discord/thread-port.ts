/**
 * The REST-backed DiscordThreadPort (Phase 1 wiring). Thread creation is
 * anchored to the source message (`message_id`): Discord moves the message
 * into the thread as its durable first post, which is exactly what the
 * crash-recovery lookup matches on — list the parent's active threads, read
 * each one's oldest message, and the id equality IS the deterministic
 * recovery the design requires. Outcomes map one-to-one onto the port's
 * contract; retry policy belongs to the shared REST client.
 */

import type { DiscordThreadPort } from '../features/thread-creation.js'
import type { RestMethod, RestResult, SharedRestClient } from './rest.js'

/** Scripted route outcome for tests (shape mirrors RestClient outcomes). */
export type ScriptedRoute =
  | { outcome: 'completed'; body: unknown; status?: number }
  | { outcome: 'rejected'; status?: number; error?: { code: number | string; message: string } }
  | { outcome: 'unknown'; reason?: 'network-unreachable' | 'aborted' }

/** The narrow request face this port needs (SharedRestClient-compatible). */
export interface ThreadPortRest {
  request<T>(method: RestMethod, path: string, body?: unknown): Promise<RestResult<T>>
}

/** Bound the crash-recovery scan: never walk an unbounded thread list. */
const MAX_THREADS_SCANNED = 25

export function createRestThreadPort(rest: ThreadPortRest): DiscordThreadPort {
  return {
    async createThread(request) {
      const made = await rest.request<{ id?: string } | undefined>('POST', `/channels/${request.parentChannelId}/threads`, {
        name: request.name,
        type: 11,
        message_id: request.sourceMessageId,
      })
      if (made.outcome === 'completed' && typeof made.body?.id === 'string') {
        return { outcome: 'completed', threadId: made.body.id }
      }
      return made.outcome === 'rejected' ? { outcome: 'failed' } : { outcome: 'unknown' }
    },

    async findThreadBySource(request) {
      const listed = await rest.request<{ threads?: Array<{ id: string }> } | undefined>(
        'GET',
        `/channels/${request.parentChannelId}/threads/active`,
      )
      if (listed.outcome !== 'completed') return { outcome: 'not-found' }
      const threads = Array.isArray(listed.body?.threads) ? listed.body.threads : []
      for (const thread of threads.slice(0, MAX_THREADS_SCANNED)) {
        const oldest = await rest.request<Array<{ id: string }>>(
          'GET',
          `/channels/${thread.id}/messages?after=0&limit=1`,
        )
        if (oldest.outcome !== 'completed') continue
        const first = Array.isArray(oldest.body) ? oldest.body[0] : undefined
        if (first?.id === request.sourceMessageId) {
          return { outcome: 'found', threadId: thread.id }
        }
      }
      return { outcome: 'not-found' }
    },
  }
}

// Re-export so composition can type against the shared client directly.
export type { SharedRestClient }
