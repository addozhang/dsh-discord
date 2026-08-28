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
