/**
 * Bounded retention tests (6.6). Completed intents and deliveries default to
 * a 30-day retention, resolved interactions to 7 days, and no policy may go
 * below the 7-day floor. Unresolved records — claimed or unknown — never
 * expire on a timer; they survive until explicit resolution or a Guild
 * forget. Active bindings are not retention data. A Guild forget removes only
 * that guild's adapter records; DSH workspaces and sessions are never touched.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_COMPLETED_RETENTION_MS,
  DEFAULT_INTERACTION_RETENTION_MS,
  MINIMUM_RETENTION_MS,
  guildKeysToForget,
  normalizeRetentionPolicy,
  sweepExpired,
} from '../src/state/retention.js'
import type { InboundIntentRecord } from '../src/state/intents.js'

const DAY = 24 * 60 * 60_000
const NOW = 100 * DAY

function intent(state: InboundIntentRecord['state'], resolvedAtMs?: number): InboundIntentRecord {
  return {
    contentHash: 'h',
    state,
    claimedAtMs: NOW - 10 * DAY,
    ...(resolvedAtMs === undefined ? {} : { resolvedAtMs }),
  }
}

describe('retention policy', () => {
  it('defaults to 30 days completed and 7 days interactions', () => {
    expect(normalizeRetentionPolicy({})).toEqual({
      completedRetentionMs: DEFAULT_COMPLETED_RETENTION_MS,
      interactionRetentionMs: DEFAULT_INTERACTION_RETENTION_MS,
    })
    expect(DEFAULT_COMPLETED_RETENTION_MS).toBe(30 * DAY)
    expect(DEFAULT_INTERACTION_RETENTION_MS).toBe(7 * DAY)
  })

  it('clamps every configured value up to the 7-day minimum', () => {
    const policy = normalizeRetentionPolicy({
      completedRetentionMs: 1 * DAY,
      interactionRetentionMs: 0,
    })
    expect(policy.completedRetentionMs).toBe(MINIMUM_RETENTION_MS)
    expect(policy.interactionRetentionMs).toBe(MINIMUM_RETENTION_MS)
    expect(MINIMUM_RETENTION_MS).toBe(7 * DAY)
  })
})

describe('sweep', () => {
  it('sweeps only completed records older than their retention window', () => {
    const intents = new Map<string, InboundIntentRecord>([
      ['old-succeeded', intent('succeeded', NOW - 31 * DAY)],
      ['recent-succeeded', intent('succeeded', NOW - 10 * DAY)],
      ['old-failed', intent('failed', NOW - 45 * DAY)],
      ['old-claimed', intent('claimed')],
      ['old-unknown', intent('unknown', NOW - 50 * DAY)],
    ])

    const swept = sweepExpired(
      { intents: [...intents], resolvedInteractions: [] },
      { nowMs: NOW, policy: {} },
    )

    expect(swept.intentKeys.sort()).toEqual(['old-failed', 'old-succeeded'])
    expect(swept.interactionKeys).toEqual([])
    // Unresolved records survive even when far older than the window.
    expect(intents.get('old-claimed')).toBeDefined()
    expect(intents.get('old-unknown')).toBeDefined()
  })

  it('sweeps resolved interactions past 7 days and keeps recent ones', () => {
    const interactions: Array<[string, { resolvedAtMs: number }]> = [
      ['old', { resolvedAtMs: NOW - 8 * DAY }],
      ['recent', { resolvedAtMs: NOW - 6 * DAY }],
    ]
    const swept = sweepExpired(
      { intents: [], resolvedInteractions: interactions },
      { nowMs: NOW, policy: {} },
    )
    expect(swept.interactionKeys).toEqual(['old'])
  })

  it('respects the configured (floor-clamped) windows', () => {
    const intents = new Map<string, InboundIntentRecord>([
      ['edge', intent('succeeded', NOW - 7 * DAY - 1)],
    ])
    const swept = sweepExpired(
      { intents: [...intents], resolvedInteractions: [] },
      { nowMs: NOW, policy: { completedRetentionMs: 1 * DAY } },
    )
    // Config asked for 1 day; the floor clamps to 7 days, and the record is
    // exactly past that clamped window.
    expect(swept.intentKeys).toEqual(['edge'])
  })
})

describe('guild forget', () => {
  it('collects only the forgotten guild keys and never DSH-side data', () => {
    const channelKeys = [
      'app:111:guild:g1:channel:c1',
      'app:111:guild:g2:channel:c2',
    ]
    const threadKeys = [
      'app:111:guild:g1:thread:t1',
      'app:111:guild:g3:thread:t3',
    ]
    const intents = new Map([
      ['m1', intent('succeeded')],
    ])

    const plan = guildKeysToForget({
      guildId: 'g1',
      channelBindingKeys: channelKeys,
      threadBindingKeys: threadKeys,
    })

    expect(plan.channelKeys).toEqual(['app:111:guild:g1:channel:c1'])
    expect(plan.threadKeys).toEqual(['app:111:guild:g1:thread:t1'])
    // Intent keys are message-scoped, not guild-scoped in the key itself:
    // forget planning does NOT include them unless the caller correlates
    // guild metadata, so DSH sessions/workspaces are structurally untouched.
    expect(plan.intentKeys).toEqual([])
    void intents
  })
})
