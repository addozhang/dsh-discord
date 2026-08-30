import { describe, expect, it, vi } from 'vitest'

import {
  DISCORD_BOT_TOKEN_REF,
  describeDiscordCredential,
  resolveDiscordBotToken,
} from '../src/credential.js'

describe('Discord credential boundary', () => {
  it('uses one fixed plugin-owned reference and returns status without the value', async () => {
    const provider = {
      describe: vi.fn(() => Promise.resolve({ configured: true, source: 'file', writable: true })),
      resolve: vi.fn(() => Promise.resolve({ value: 'secret-token', source: 'file' })),
    }

    await expect(describeDiscordCredential(provider)).resolves.toEqual({
      configured: true,
      source: 'file',
      writable: true,
    })
    expect(provider.describe).toHaveBeenCalledWith(DISCORD_BOT_TOKEN_REF)
    expect(JSON.stringify(await describeDiscordCredential(provider))).not.toContain('secret-token')
  })

  it('falls back to resolve when describe misses an env-sourced token', async () => {
    // The Host's describe() does not see env-sourced values while its
    // resolve() accepts them; the probe must trust resolve, never report a
    // connected adapter as unconfigured — and must never leak the value.
    const provider = {
      describe: vi.fn(() => Promise.resolve({ configured: false, writable: false })),
      resolve: vi.fn(() => Promise.resolve({ value: 'env-token', source: 'env' })),
    }

    await expect(describeDiscordCredential(provider)).resolves.toEqual({
      configured: true,
      source: 'env',
      writable: false,
    })
    expect(JSON.stringify(await describeDiscordCredential(provider))).not.toContain('env-token')
  })

  it('reports the credential absent only when both describe and resolve miss', async () => {
    const provider = {
      describe: vi.fn(() => Promise.resolve({ configured: false, writable: true })),
      resolve: vi.fn(() => Promise.resolve(undefined)),
    }

    await expect(describeDiscordCredential(provider)).resolves.toEqual({
      configured: false,
      writable: true,
    })
  })

  it('resolves the token for each connection attempt without caching it', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ value: 'first', source: 'file' })
      .mockResolvedValueOnce({ value: 'second', source: 'file' })

    await expect(resolveDiscordBotToken({ resolve })).resolves.toBe('first')
    await expect(resolveDiscordBotToken({ resolve })).resolves.toBe('second')
    expect(resolve).toHaveBeenCalledTimes(2)
  })
})
