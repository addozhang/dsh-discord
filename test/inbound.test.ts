/**
 * Pure ingress tests: untrusted Gateway dispatch payloads are validated and
 * normalized before any business logic runs. Rejection is a value, never a
 * throw — a malformed payload must not break the dispatch loop.
 */

import { describe, expect, it } from 'vitest'

import {
  extractBotMention,
  isDiscordSnowflake,
  parseGatewayDispatch,
  type GatewayDispatch,
} from '../src/gateway/inbound.js'

const SELF_USER_ID = '111111111111111111'

function messagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '222222222222222222',
    guild_id: '333333333333333333',
    channel_id: '444444444444444444',
    author: { id: '555555555555555555', bot: false },
    content: 'hello world',
    ...overrides,
  }
}

function messageDispatch(payload: Record<string, unknown>): GatewayDispatch {
  return { t: 'MESSAGE_CREATE', d: payload }
}

describe('isDiscordSnowflake', () => {
  it('accepts 17-20 digit numeric strings only', () => {
    expect(isDiscordSnowflake('12345678901234567')).toBe(true)
    expect(isDiscordSnowflake('12345678901234567890')).toBe(true)
    expect(isDiscordSnowflake('1234567890123456')).toBe(false)
    expect(isDiscordSnowflake('123456789012345678901')).toBe(false)
    expect(isDiscordSnowflake('12345678901234567a')).toBe(false)
    expect(isDiscordSnowflake('')).toBe(false)
  })
})

describe('extractBotMention', () => {
  it('detects and strips plain and nickname bot mentions', () => {
    expect(extractBotMention(`<@${SELF_USER_ID}> run tests`, SELF_USER_ID)).toEqual({
      mentioned: true,
      text: 'run tests',
    })
    expect(extractBotMention(`<@!${SELF_USER_ID}> run tests`, SELF_USER_ID)).toEqual({
      mentioned: true,
      text: 'run tests',
    })
  })

  it('leaves messages without a bot mention untouched', () => {
    expect(extractBotMention('plain text', SELF_USER_ID)).toEqual({ mentioned: false, text: 'plain text' })
    expect(extractBotMention(`<@999999999999999999> other bot`, SELF_USER_ID)).toEqual({
      mentioned: false,
      text: '<@999999999999999999> other bot',
    })
  })

  it('reports a mention-only message as mentioned with empty text', () => {
    expect(extractBotMention(`<@${SELF_USER_ID}>`, SELF_USER_ID)).toEqual({ mentioned: true, text: '' })
  })
})

describe('parseGatewayDispatch', () => {
  it('normalizes a well-formed guild message', () => {
    const result = parseGatewayDispatch(
      messageDispatch(messagePayload({ content: `<@${SELF_USER_ID}> ship it` })),
      SELF_USER_ID,
    )
    expect(result).toEqual({
      accepted: true,
      event: {
        kind: 'message',
        messageId: '222222222222222222',
        guildId: '333333333333333333',
        channelId: '444444444444444444',
        authorId: '555555555555555555',
        roleIds: [],
        content: 'ship it',
        mentionedBot: true,
        repliedToId: undefined,
      },
    })
  })

  it('normalizes a reply reference when present and valid', () => {
    const result = parseGatewayDispatch(
      messageDispatch(messagePayload({
        message_reference: { message_id: '666666666666666666' },
      })),
      SELF_USER_ID,
    )
    if (!result.accepted) throw new Error('expected acceptance')
    expect(result.event.kind === 'message' && result.event.repliedToId).toBe('666666666666666666')
  })

  it('rejects unsupported dispatch event names as a value, not a throw', () => {
    for (const dispatch of [
      { t: 'TYPING_START', d: {} } as unknown as GatewayDispatch,
      { t: 'GUILD_CREATE', d: {} } as unknown as GatewayDispatch,
    ]) {
      const result = parseGatewayDispatch(dispatch, SELF_USER_ID)
      expect(result.accepted).toBe(false)
      if (!result.accepted) expect(result.reason).toBe('unsupported-event')
    }
  })

  it('rejects malformed payloads without throwing', () => {
    for (const dispatch of [
      { t: 'MESSAGE_CREATE' } as unknown as GatewayDispatch,
      { t: 'MESSAGE_CREATE', d: 'not-an-object' } as unknown as GatewayDispatch,
      messageDispatch(messagePayload({ id: undefined })),
      messageDispatch(messagePayload({ channel_id: undefined })),
      messageDispatch(messagePayload({ author: undefined })),
      messageDispatch(messagePayload({ author: { bot: false } })),
      messageDispatch(messagePayload({ id: 'not-a-snowflake' })),
      messageDispatch(messagePayload({ content: 42 })),
    ]) {
      const result = parseGatewayDispatch(dispatch, SELF_USER_ID)
      expect(result.accepted).toBe(false)
      if (!result.accepted) expect(result.reason).toBe('malformed-payload')
    }
  })

  it('rejects messages authored by any bot or by the adapter itself', () => {
    for (const author of [
      { id: '555555555555555555', bot: true },
      { id: SELF_USER_ID, bot: false },
      { id: SELF_USER_ID, bot: true },
    ]) {
      const result = parseGatewayDispatch(messageDispatch(messagePayload({ author })), SELF_USER_ID)
      expect(result.accepted).toBe(false)
      if (!result.accepted) expect(result.reason).toBe('bot-authored')
    }
  })

  it('normalizes a guild interaction with member or user identity', () => {
    const base = {
      id: '777777777777777777',
      guild_id: '333333333333333333',
      channel_id: '444444444444444444',
      type: 2,
      data: { name: 'project' },
    }
    const viaMember = parseGatewayDispatch(
      { t: 'INTERACTION_CREATE', d: { ...base, member: { user: { id: '555555555555555555' } } } },
      SELF_USER_ID,
    )
    expect(viaMember).toEqual({
      accepted: true,
      event: {
        kind: 'interaction',
        interactionId: '777777777777777777',
        interactionType: 2,
        guildId: '333333333333333333',
        channelId: '444444444444444444',
        actorId: '555555555555555555',
        roleIds: [],
        memberPermissions: undefined,
        isBot: false,
        commandName: 'project',
        data: { name: 'project' },
        componentMessageId: undefined,
        selectValues: [],
        modalFields: [],
      },
    })

    const viaUser = parseGatewayDispatch(
      { t: 'INTERACTION_CREATE', d: { ...base, user: { id: '888888888888888888' } } } as never,
      SELF_USER_ID,
    )
    if (!viaUser.accepted) throw new Error('expected acceptance')
    expect(viaUser.event.kind === 'interaction' && viaUser.event.actorId).toBe('888888888888888888')
  })

  it('rejects interactions with unsupported types or malformed identity', () => {
    const base = {
      id: '777777777777777777',
      guild_id: '333333333333333333',
      channel_id: '444444444444444444',
      data: { name: 'project' },
    }
    for (const payload of [
      { ...base, type: 1, member: { user: { id: '555555555555555555' } } },
      { ...base, type: 99, member: { user: { id: '555555555555555555' } } },
      { ...base, type: 2 },
      { ...base, type: 2, member: { user: {} } },
      { ...base, type: 2, member: { user: { id: '555555555555555555' } }, data: {} },
    ]) {
      const result = parseGatewayDispatch(
        { t: 'INTERACTION_CREATE', d: payload as Record<string, unknown> },
        SELF_USER_ID,
      )
      expect(result.accepted).toBe(false)
    }
  })

  it('rejects a non-guild message (DM) at the normalization boundary', () => {
    const payload = messagePayload({ guild_id: undefined })
    const result = parseGatewayDispatch(messageDispatch(payload), SELF_USER_ID)
    expect(result.accepted).toBe(false)
    if (!result.accepted) expect(result.reason).toBe('non-guild-event')
  })
})
