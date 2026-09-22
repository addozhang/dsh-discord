import { describe, expect, it } from 'vitest'

import type { DiscordSettings } from '../src/settings.js'
import {
  DEFAULT_DISCORD_SETTINGS,
  DiscordSettingsSchema,
  normalizeDiscordSettings,
  validateDiscordSettings,
} from '../src/settings.js'

/** Resolve through the schema and unwrap volatile references to plain values. */
function resolveSchema(input: unknown): DiscordSettings {
  const parsed = (DiscordSettingsSchema as unknown as (value: unknown) => Record<string, unknown>)(input)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    out[key] = typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
      ? (value as { get(): unknown }).get()
      : value
  }
  return out as unknown as DiscordSettings
}

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
      modelSelectOperatorOnly: false,
      // Stricter than /model by design (16.60): danger-full-access disables
      // sandbox AND approval, so the permission switch gates operators only.
      permissionSelectOperatorOnly: true,
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

  it('follows the DSH language by default and admits only auto/zh/en', () => {
    expect(DEFAULT_DISCORD_SETTINGS.language).toBe('auto')

    // Schemastery schema nodes resolve by direct call. Volatile fields come
    // back as stable references (0.1.7 forms model), so the untyped view
    // unwraps `.get()` before asserting — exactly what bindDiscordSettings
    // does against the mounted config.
    const resolve = resolveSchema
    expect(resolve({}).language).toBe('auto')
    expect(resolve({ language: 'zh' }).language).toBe('zh')
    expect(resolve({ language: 'en' }).language).toBe('en')
    expect(() => { resolve({ language: 'fr' }) }).toThrow()
  })

  it('defaults the permission switch to Host operators and admits the loosened flip', () => {
    const resolve = resolveSchema
    expect(resolve({}).permissionSelectOperatorOnly).toBe(true)
    expect(resolve({ permissionSelectOperatorOnly: false }).permissionSelectOperatorOnly).toBe(false)
  })
})
