/**
 * Channel preset tests (10.1): a project channel can show, select, and reset
 * its default Agent Preset; missing or broken presets report cleanly; the
 * channel default is passed ONLY to future `session.create` calls — existing
 * sessions never change.
 */

import { describe, expect, it, vi } from 'vitest'

import { createKvTableStub } from './helpers/kv-table.js'
import { createPresetControl, type DshPresetPort } from '../src/features/preset-control.js'

function catalogPort(presets: Array<{ id: string; name: string }> = [], hostDefault: string | undefined = 'standard'): DshPresetPort {
  return {
    listPresets: () => Promise.resolve({ outcome: 'completed', presets }),
    hostDefaultPreset: () => Promise.resolve({ outcome: 'completed', presetId: hostDefault }),
  }
}

function setup(presets?: Array<{ id: string; name: string }>) {
  const table = createKvTableStub<{ presetId: string }>()
  const flow = createPresetControl({ presets: catalogPort(presets), channelStore: table })
  return { flow, table }
}

describe('channel preset control', () => {
  it('shows the channel default or the host default when unset', async () => {
    const { flow } = setup([{ id: 'p1', name: 'Planner' }])

    await flow.select({ guildId: 'g', channelId: 'c', presetId: 'p1' })
    expect(await flow.show({ guildId: 'g', channelId: 'c' })).toEqual({
      outcome: 'ok',
      channelPreset: 'p1',
      hostDefault: 'standard',
    })
  })

  it('shows only the host default when the channel has none', async () => {
    const { flow } = setup([{ id: 'p1', name: 'Planner' }])
    expect(await flow.show({ guildId: 'g', channelId: 'c' })).toEqual({
      outcome: 'ok',
      channelPreset: undefined,
      hostDefault: 'standard',
    })
  })

  it('selects only a preset that exists in the host catalog', async () => {
    const { flow } = setup([{ id: 'p1', name: 'Planner' }])

    const missing = await flow.select({ guildId: 'g', channelId: 'c', presetId: 'nope' })
    expect(missing).toEqual({ outcome: 'failed', reason: 'preset-not-in-catalog' })

    const ok = await flow.select({ guildId: 'g', channelId: 'c', presetId: 'p1' })
    expect(ok).toEqual({ outcome: 'selected', presetId: 'p1' })
  })

  it('reports a broken preset catalog without writing', async () => {
    const { table } = setup()
    const broken: DshPresetPort = {
      listPresets: () => Promise.resolve({ outcome: 'failed' }),
      hostDefaultPreset: () => Promise.resolve({ outcome: 'completed', presetId: undefined }),
    }
    const flow2 = createPresetControl({ presets: broken, channelStore: table })
    const result = await flow2.select({ guildId: 'g', channelId: 'c', presetId: 'p1' })
    expect(result).toEqual({ outcome: 'failed', reason: 'preset-catalog-unavailable' })
    expect(table.get('g:c')).toBeUndefined()
  })

  it('resets the channel default so future sessions follow the host', async () => {
    const { flow, table } = setup([{ id: 'p1', name: 'Planner' }])
    await flow.select({ guildId: 'g', channelId: 'c', presetId: 'p1' })
    expect(table.get('g:c')?.presetId).toBe('p1')

    const reset = await flow.reset({ guildId: 'g', channelId: 'c' })
    expect(reset).toEqual({ outcome: 'reset' })
    expect(table.get('g:c')).toBeUndefined()
  })

  it('supplies the channel preset only to FUTURE session creations', async () => {
    const { flow } = setup([{ id: 'p1', name: 'Planner' }])
    await flow.select({ guildId: 'g', channelId: 'c', presetId: 'p1' })

    const presetFor = vi.fn()
    const request = flow.applyToSessionCreate({ guildId: 'g', channelId: 'c' }, { sessionId: 'new-1' })
    presetFor(request)
    expect(presetFor).toHaveBeenCalledWith(expect.objectContaining({ presetId: 'p1' }))

    // After reset, future creations carry NO preset field.
    await flow.reset({ guildId: 'g', channelId: 'c' })
    const after = flow.applyToSessionCreate({ guildId: 'g', channelId: 'c' }, { sessionId: 'new-2' })
    expect(after).toEqual({ sessionId: 'new-2' })
  })
})
