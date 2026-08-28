/**
 * Durable-state foundation tests (6.1): key codecs for the two binding
 * families and the versioned domain spec they validate against.
 *
 * Keys: `app:<applicationId>:guild:<guildId>:channel:<channelId>` and
 * `app:<applicationId>:guild:<guildId>:thread:<threadId>`. Snowflake ids never
 * contain `:`, so the shape is unambiguous and guild-scoped scans derive from
 * parsed parts instead of fragile prefixes.
 *
 * Records are zod-strict at the durable boundary: unknown fields reject, so
 * newer-format state fails closed instead of half-decoding (6.7).
 */

import { describe, expect, it, vi } from 'vitest'

import {
  CHANNEL_BINDINGS_TABLE,
  DISCORD_DOMAIN_NAME,
  DISCORD_DOMAIN_VERSION,
  THREAD_BINDINGS_TABLE,
  channelBindingKey,
  discordDomainSpec,
  parseChannelBindingKey,
  parseThreadBindingKey,
  threadBindingKey,
} from '../src/state/domain.js'
import { ChannelBindingRecord, ThreadBindingRecord } from '../src/state/records.js'

const APP = '111111111111111111'
const GUILD = '333333333333333333'
const CHANNEL = '444444444444444444'
const THREAD = '555555555555555555'

describe('binding key codecs', () => {
  it('builds and parses channel binding keys round-trip', () => {
    const key = channelBindingKey({ applicationId: APP, guildId: GUILD, channelId: CHANNEL })
    expect(key).toBe(`app:${APP}:guild:${GUILD}:channel:${CHANNEL}`)
    expect(parseChannelBindingKey(key)).toEqual({ applicationId: APP, guildId: GUILD, channelId: CHANNEL })
  })

  it('builds and parses thread binding keys round-trip', () => {
    const key = threadBindingKey({ applicationId: APP, guildId: GUILD, threadId: THREAD })
    expect(key).toBe(`app:${APP}:guild:${GUILD}:thread:${THREAD}`)
    expect(parseThreadBindingKey(key)).toEqual({ applicationId: APP, guildId: GUILD, threadId: THREAD })
  })

  it('never cross-parses the two key families', () => {
    const channelKey = channelBindingKey({ applicationId: APP, guildId: GUILD, channelId: CHANNEL })
    const threadKey = threadBindingKey({ applicationId: APP, guildId: GUILD, threadId: THREAD })
    expect(parseThreadBindingKey(channelKey)).toBeUndefined()
    expect(parseChannelBindingKey(threadKey)).toBeUndefined()
  })

  it('rejects malformed keys instead of guessing', () => {
    for (const key of [
      '',
      'app:guild:channel',
      `app:${APP}:guild:${GUILD}:channel:`,
      `guild:${GUILD}:channel:${CHANNEL}`,
      `app:${APP}:guild::channel:${CHANNEL}`,
      'xapp:1:guild:2:channel:3',
    ]) {
      expect(parseChannelBindingKey(key), key).toBeUndefined()
      expect(parseThreadBindingKey(key), key).toBeUndefined()
    }
  })
})

describe('binding record schemas', () => {
  it('accepts a valid channel binding record', () => {
    const result = ChannelBindingRecord.safeParse({
      workspaceId: 'ws-1',
      revision: 3,
      boundBy: '555555555555555555',
      boundAtMs: 1_000,
    })
    expect(result.success).toBe(true)
  })

  it('rejects out-of-contract channel binding records', () => {
    for (const record of [
      {},
      { workspaceId: '', revision: 1, boundBy: '555555555555555555', boundAtMs: 1_000 },
      { workspaceId: 'ws-1', revision: 0, boundBy: '555555555555555555', boundAtMs: 1_000 },
      { workspaceId: 'ws-1', revision: 1.5, boundBy: '555555555555555555', boundAtMs: 1_000 },
      { workspaceId: 'ws-1', revision: 1, boundBy: '555555555555555555' },
      { workspaceId: 'ws-1', revision: 1, boundBy: '555555555555555555', boundAtMs: 'later' },
      // Unknown fields reject: newer formats fail closed (6.7).
      { workspaceId: 'ws-1', revision: 1, boundBy: '5', boundAtMs: 1, mystery: true },
    ]) {
      const result = ChannelBindingRecord.safeParse(record)
      expect(result.success, JSON.stringify(record)).toBe(false)
    }
  })

  it('accepts a valid thread binding record and rejects broken ones', () => {
    const valid = {
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      revision: 1,
      createdBy: '555555555555555555',
      createdAtMs: 2_000,
    }
    expect(ThreadBindingRecord.safeParse(valid).success).toBe(true)
    expect(ThreadBindingRecord.safeParse({ ...valid, sessionId: '' }).success).toBe(false)
    expect(ThreadBindingRecord.safeParse({ ...valid, revision: -1 }).success).toBe(false)
    expect(ThreadBindingRecord.safeParse({ ...valid, extra: 1 }).success).toBe(false)
  })
})

describe('domain spec', () => {
  it('uses a storage-legal name and a positive integer version', () => {
    expect(DISCORD_DOMAIN_NAME).toMatch(/^[a-z][a-z0-9_]*$/)
    expect(DISCORD_DOMAIN_VERSION).toBe(1)
  })

  it('declares exactly the two binding tables', () => {
    expect(Object.keys(discordDomainSpec.tables).sort()).toEqual(
      [CHANNEL_BINDINGS_TABLE, THREAD_BINDINGS_TABLE].sort(),
    )
    expect(discordDomainSpec.version).toBe(DISCORD_DOMAIN_VERSION)
  })

  it('opens through the facility and closes via the returned domain', async () => {
    const { openDiscordDomain } = await import('../src/state/domain.js')
    const close = vi.fn((): Promise<void> => Promise.resolve())
    const fakeDomain = { name: DISCORD_DOMAIN_NAME, close }
    const facility = { open: vi.fn((): Promise<typeof fakeDomain> => Promise.resolve(fakeDomain)) }

    const domain = await openDiscordDomain(facility as never)
    expect(facility.open).toHaveBeenCalledWith(discordDomainSpec)
    expect(domain.name).toBe(DISCORD_DOMAIN_NAME)
    await domain.close()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
