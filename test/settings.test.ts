import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DISCORD_SETTINGS,
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
})
