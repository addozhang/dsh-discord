/**
 * The REST-backed DiscordThreadPort (Kimaki thread model). Thread creation
 * is anchored to the source message (`message_id`): Discord moves the user's
 * task message into the thread as its durable first post, so the thread
 * opens with what reads exactly like the user's own task post. Crash-window
 * recovery matches a thread by its anchored first message (the source
 * message id). The author is joined to the thread so it appears in their
 * sidebar. Outcomes map one-to-one onto the port's contract; retry policy
 * belongs to the shared REST client.
 */

import type { DiscordThreadPort } from '../features/thread-creation.js'
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

/** Kimaki's OneDay archive is the default; the deployment can widen or narrow it. */
const DEFAULT_AUTO_ARCHIVE_MINUTES = 1440

export interface ThreadPortOptions {
  /** Live archive-duration reader (Discord accepts 60/1440/4320/10080). */
  autoArchiveMinutes?: () => number | undefined
}

export function createRestThreadPort(rest: ThreadPortRest, options: ThreadPortOptions = {}): DiscordThreadPort {
  return {
    async createThread(request) {
      // Anchored creation uses the documented message-scoped route: Discord
      // moves the source message into the thread as its first post. The
      // channel-scoped route ignores a `message_id` body field, so anchoring
      // silently no-ops there (seen live).
      const made = await rest.request<{ id?: string } | undefined>(
        'POST',
        `/channels/${request.parentChannelId}/messages/${request.sourceMessageId}/threads`,
        {
          name: request.name,
          type: 11,
          auto_archive_duration: options.autoArchiveMinutes?.() ?? DEFAULT_AUTO_ARCHIVE_MINUTES,
        },
      )
      if (made.outcome === 'completed' && typeof made.body?.id === 'string') {
        return { outcome: 'completed', threadId: made.body.id }
      }
      return made.outcome === 'rejected' ? { outcome: 'failed' } : { outcome: 'unknown' }
    },

    async findThreadBySource(request) {
      // Active-thread listing is GUILD-scoped only: the channel-scoped
      // `threads/active` route does not exist in the Discord API (archived
      // listing is the only channel-level one), so recovery would 404 forever.
      const listed = await rest.request<{ threads?: Array<{ id: string }> } | undefined>(
        'GET',
        `/guilds/${request.guildId}/threads/active`,
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

    async joinThread(request) {
      // Idempotent per Discord (joining an existing member answers 2xx);
      // callers treat this as best-effort and never fail the task on it.
      const joined = await rest.request('PUT', `/channels/${request.threadId}/thread-members/${request.userId}`)
      return joined.outcome === 'completed' ? { outcome: 'completed' } : { outcome: 'failed' }
    },
  }
}
