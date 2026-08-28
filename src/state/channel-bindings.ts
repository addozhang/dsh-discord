/**
 * The Channel→Workspace binding service: the composition of the versioned
 * key codec, the revision-fenced binding store, and guild-scoped listing.
 * Keys carry the full ownership scope (application+guild+channel), so
 * bindings are independent across channels and guilds by construction, and
 * a guild-scoped scan parses keys instead of guessing with prefixes.
 */

import type { ChannelBinding } from './records.js'
import { channelBindingKey, parseChannelBindingKey, type ChannelBindingScope } from './domain.js'
import type { BindingStore, BindOutcome } from './bindings.js'

export interface GuildBindingEntry {
  scope: ChannelBindingScope
  binding: ChannelBinding
}

export interface ChannelBindingService {
  keyFor(scope: ChannelBindingScope): string
  resolve(scope: ChannelBindingScope): ChannelBinding | undefined
  bind(
    scope: ChannelBindingScope,
    request: { workspaceId: string; actorId: string; nowMs: number },
    options?: { expectedRevision?: number | undefined; beforeWrite?: () => Promise<void> | void },
  ): Promise<BindOutcome<ChannelBinding>>
  release(scope: ChannelBindingScope, options: { expectedRevision: number }): Promise<BindOutcome<ChannelBinding>>
  /** All bindings inside one guild (parsed keys, not prefix guesses). */
  listForGuild(guildId: string): GuildBindingEntry[]
}

export function createChannelBindingService(deps: {
  store: BindingStore<ChannelBinding>
  applicationId: string
  /** Raw key access for guild scans; the domain's table provides it. */
  listKeys?: () => Iterable<string>
}): ChannelBindingService {
  const { store, applicationId, listKeys } = deps
  function keyFor(scope: ChannelBindingScope): string {
    return channelBindingKey(scope)
  }

  return {
    keyFor,
    resolve: scope => store.get(keyFor(scope)),
    bind(scope, request, options = {}) {
      return store.bind(
        keyFor(scope),
        {
          workspaceId: request.workspaceId,
          boundBy: request.actorId,
          boundAtMs: request.nowMs,
        },
        {
          ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
          ...(options.beforeWrite === undefined ? {} : { beforeWrite: options.beforeWrite }),
        },
      )
    },
    release: (scope, options) => store.release(keyFor(scope), options),
    listForGuild(guildId) {
      if (listKeys === undefined) return []
      const entries: GuildBindingEntry[] = []
      for (const key of listKeys()) {
        const scope = parseChannelBindingKey(key)
        if (scope === undefined || scope.applicationId !== applicationId || scope.guildId !== guildId) continue
        const binding = store.get(key)
        if (binding !== undefined) entries.push({ scope, binding })
      }
      return entries
    },
  }
}
