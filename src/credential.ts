import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const DISCORD_BOT_TOKEN_REF = credentialRef('DSH_DISCORD_BOT_TOKEN')

export interface DiscordCredentialProvider {
  describe(ref: typeof DISCORD_BOT_TOKEN_REF): Promise<{
    configured: boolean
    source?: string
    writable: boolean
  }>
  resolve(ref: typeof DISCORD_BOT_TOKEN_REF): Promise<{
    value: string
    source: string
  } | undefined>
}

export async function describeDiscordCredential(
  provider: Pick<DiscordCredentialProvider, 'describe' | 'resolve'>,
): Promise<{ configured: boolean; source?: string; writable: boolean }> {
  const result = await provider.describe(DISCORD_BOT_TOKEN_REF)
  if (result.configured) {
    return {
      configured: true,
      ...(result.source === undefined ? {} : { source: result.source }),
      writable: result.writable,
    }
  }
  // The Host's describe() does not report env-sourced values, while the
  // gateway's resolve() accepts them. Resolve is what connectivity actually
  // uses, so probe it before claiming the credential is absent — otherwise
  // the card shows "not configured" on a connected adapter.
  const resolved = await provider.resolve(DISCORD_BOT_TOKEN_REF).catch(() => undefined)
  if (resolved !== undefined) {
    return { configured: true, source: resolved.source, writable: false }
  }
  return { configured: false, writable: result.writable }
}

export async function resolveDiscordBotToken(
  provider: Pick<DiscordCredentialProvider, 'resolve'>,
): Promise<string | undefined> {
  return (await provider.resolve(DISCORD_BOT_TOKEN_REF))?.value
}
