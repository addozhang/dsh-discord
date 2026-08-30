import { describe, expect, it } from 'vitest'

import type { DiscordSettings } from '../src/settings.js'
import {
  DEFAULT_DISCORD_SETTINGS,
  DiscordSettingsSchema,
  normalizeDiscordSettings,
  validateDiscordSettings,
} from '../src/settings.js'

describe('Discord settings', () => {
  it('defaults to a disabled deny-by-default configuration', () => {
    expect(DEFAULT_DISCORD_SETTINGS).toMatchObject({
      enabled: false,
      allowedGuildIds: [],
      memberUserIds: [],
      memberRoleIds: [],
      administratorUserIds: [],
      administratorRoleIds: [],
      deniedUserIds: [],
      deniedRoleIds: [],
      hostOperatorUserIds: [],
      defaultVerbosity: 'essential-tools',
    })
  })

  it('normalizes duplicate Discord snowflakes without changing order', () => {
    expect(normalizeDiscordSettings({
      ...DEFAULT_DISCORD_SETTINGS,
      allowedGuildIds: [' 123456789012345678 ', '123456789012345678'],
      memberRoleIds: ['223456789012345678', '223456789012345678'],
    })).toMatchObject({
      allowedGuildIds: ['123456789012345678'],
      memberRoleIds: ['223456789012345678'],
    })
  })

  it('rejects malformed snowflakes and unsafe timing limits', () => {
    expect(() => { validateDiscordSettings({
      ...DEFAULT_DISCORD_SETTINGS,
      allowedGuildIds: ['not-a-snowflake'],
    }); }).toThrow('allowedGuildIds')

    expect(() => { validateDiscordSettings({
      ...DEFAULT_DISCORD_SETTINGS,
      streamUpdateIntervalMs: 20,
    }); }).toThrow('streamUpdateIntervalMs')
  })

  it('defaults the copy language to Chinese and admits English only', () => {
    expect(DEFAULT_DISCORD_SETTINGS.language).toBe('zh')

    // Schemastery schema nodes resolve by direct call. The call signature's
    // static input type is the already-parsed DiscordSettings, so the test
    // goes through an untyped view — Host configs arrive as untyped YAML and
    // the runtime union/default is exactly what these assertions pin.
    const resolve = DiscordSettingsSchema as unknown as (input: unknown) => DiscordSettings
    expect(resolve({}).language).toBe('zh')
    expect(resolve({ language: 'en' }).language).toBe('en')
    expect(() => { resolve({ language: 'fr' }) }).toThrow()
  })
})
