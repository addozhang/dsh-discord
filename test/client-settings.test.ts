import { describe, expect, it } from 'vitest'

import {
  createSettingsDraft,
  presentAdapterStatus,
  presentCredentialStatus,
  serializeIdList,
} from '../src/client/settings-model.js'
import type { AdapterStatusView } from '../src/features/adapter-status.js'

describe('settings card model', () => {
  it('never includes a stored credential value in its public status', () => {
    expect(presentCredentialStatus({ configured: true, writable: true, source: 'file' }))
      .toEqual({ label: 'Configured', writable: true, source: 'file' })
  })

  it('parses newline-delimited Discord IDs into a detached draft', () => {
    expect(createSettingsDraft({
      enabled: true,
      allowedGuildIds: ['123456789012345678'],
    })).toMatchObject({
      enabled: true,
      allowedGuildIds: '123456789012345678',
    })
    expect(serializeIdList('123456789012345678\n 223456789012345678 '))
      .toEqual(['123456789012345678', '223456789012345678'])
  })
})

describe('adapter status presentation (2.3)', () => {
  it('presents a healthy connection without an action affordance', () => {
    const view: AdapterStatusView = { token: 'configured', connection: 'connected' }
    expect(presentAdapterStatus(view)).toEqual({
      connectionKey: 'discordStatusConnected',
      hintKey: undefined,
      actionable: false,
    })
  })

  it('presents an invalid token with its actionable hint key', () => {
    const view: AdapterStatusView = { token: 'configured', connection: 'invalid-token', hint: 'token-rejected' }
    expect(presentAdapterStatus(view)).toEqual({
      connectionKey: 'discordStatusInvalidToken',
      hintKey: 'discordHintTokenRejected',
      actionable: true,
    })
  })

  it('presents blocked intents and blocked channel permissions with their hints', () => {
    expect(presentAdapterStatus({ token: 'configured', connection: 'intents-blocked', hint: 'enable-intents' }))
      .toMatchObject({ hintKey: 'discordHintEnableIntents', actionable: true })
    expect(presentAdapterStatus({
      token: 'configured',
      connection: 'permissions-blocked',
      hint: 'channel-permissions',
    }))
      .toMatchObject({ hintKey: 'discordHintChannelPermissions', actionable: true })
  })

  it('asks for a token when the reference is unconfigured', () => {
    expect(presentAdapterStatus({ token: 'unconfigured', connection: 'disconnected', hint: 'configure-token' }))
      .toEqual({
        connectionKey: 'discordStatusDisconnected',
        hintKey: 'discordHintConfigureToken',
        actionable: true,
      })
  })

  it('maps every connection condition to a locale key the card can render', () => {
    const connections = [
      'connected',
      'connecting',
      'disconnected',
      'invalid-token',
      'intents-blocked',
      'permissions-blocked',
    ] as const
    for (const connection of connections) {
      const view: AdapterStatusView = { token: 'configured', connection }
      expect(presentAdapterStatus(view).connectionKey.startsWith('discordStatus')).toBe(true)
    }
  })
})
