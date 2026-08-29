/**
 * The REST-backed DiscordThreadPort (Kimaki thread model). Threads are
 * created UNANCHORED under the parent channel; the author's channel message
 * is mirrored once into the fresh thread through a per-thread webhook that
 * renders as the author (name + avatar), so the thread opens with what reads
 * exactly like the user's own task post. Crash-window recovery lists the
 * parent's active threads and matches the deterministic task title — the
 * name only changes later, via the session-title rename. Outcomes map
 * one-to-one onto the port's contract; retry policy belongs to the shared
 * REST client.
 */

import type { DiscordThreadPort, ThreadOpener } from '../features/thread-creation.js'
import { buildOutboundMessage } from '../stream/outbound.js'
import type { RestMethod, RestResult } from './rest.js'

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

/** The adapter's opener webhook name (reused when present, created when not). */
const OPENER_WEBHOOK_NAME = 'dsh-discord'

/** Discord message flag: suppress @-mention pings in mirrored user content. */
const SUPPRESS_MENTIONS_FLAG = 1 << 12

interface DiscordWebhook {
  id: string
  token?: string
  name?: string
}

export function createRestThreadPort(rest: ThreadPortRest): DiscordThreadPort {
  /** Reuse the adapter's opener webhook in the thread, or create one. */
  async function openerWebhook(threadId: string): Promise<{ id: string; token: string } | undefined> {
    const listed = await rest.request<DiscordWebhook[] | undefined>('GET', `/channels/${threadId}/webhooks`)
    if (listed.outcome === 'completed') {
      const existing = Array.isArray(listed.body)
        ? listed.body.find(hook => hook.name === OPENER_WEBHOOK_NAME && typeof hook.token === 'string')
        : undefined
      if (existing !== undefined) return { id: existing.id, token: existing.token ?? '' }
    }
    const made = await rest.request<DiscordWebhook | undefined>('POST', `/channels/${threadId}/webhooks`, { name: OPENER_WEBHOOK_NAME })
    if (made.outcome === 'completed' && typeof made.body?.id === 'string' && typeof made.body.token === 'string') {
      return { id: made.body.id, token: made.body.token }
    }
    return undefined
  }

  return {
    async createThread(request) {
      const made = await rest.request<{ id?: string } | undefined>('POST', `/channels/${request.parentChannelId}/threads`, {
        name: request.name,
        type: 11,
      })
      if (made.outcome !== 'completed' || typeof made.body?.id !== 'string') {
        return made.outcome === 'rejected' ? { outcome: 'failed' } : { outcome: 'unknown' }
      }
      const threadId = made.body.id
      await mirrorOpener(threadId, request.opener)
      return { outcome: 'completed', threadId }
    },

    async findThreadBySource(request) {
      const listed = await rest.request<{ threads?: Array<{ id: string; name?: string }> } | undefined>(
        'GET',
        `/channels/${request.parentChannelId}/threads/active`,
      )
      if (listed.outcome !== 'completed') return { outcome: 'not-found' }
      const threads = Array.isArray(listed.body?.threads) ? listed.body.threads : []
      for (const thread of threads.slice(0, MAX_THREADS_SCANNED)) {
        if (thread.name === request.threadName) {
          return { outcome: 'found', threadId: thread.id }
        }
      }
      return { outcome: 'not-found' }
    },
  }

  /**
   * Mirror the author's channel message into the fresh thread as the first
   * post, rendered as the author. Best-effort: a failed mirror leaves the
   * thread usable — the streaming renderer owns everything that follows.
   */
  async function mirrorOpener(threadId: string, opener: ThreadOpener): Promise<void> {
    try {
      const webhook = await openerWebhook(threadId)
      if (webhook === undefined || webhook.token === '') return
      const payload = buildOutboundMessage({ kind: 'assistant', content: opener.content })
      await rest.request(
        'POST',
        `/webhooks/${webhook.id}/${webhook.token}?wait=true`,
        {
          content: payload.content,
          flags: SUPPRESS_MENTIONS_FLAG,
          username: opener.authorName,
          ...(opener.authorAvatarUrl === undefined ? {} : { avatar_url: opener.authorAvatarUrl }),
        },
      )
    } catch {
      return
    }
  }
}

// Re-export so composition can type against the shared client directly.
export type { RestResult }
