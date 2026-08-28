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
  provider: Pick<DiscordCredentialProvider, 'describe'>,
): Promise<{ configured: boolean; source?: string; writable: boolean }> {
  const result = await provider.describe(DISCORD_BOT_TOKEN_REF)
  return {
    configured: result.configured,
    ...(result.source === undefined ? {} : { source: result.source }),
    writable: result.writable,
  }
}

export async function resolveDiscordBotToken(
  provider: Pick<DiscordCredentialProvider, 'resolve'>,
): Promise<string | undefined> {
  return (await provider.resolve(DISCORD_BOT_TOKEN_REF))?.value
}
