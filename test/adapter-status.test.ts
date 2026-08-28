/**
 * Adapter status projection tests (2.3, plugin-foundation spec): the Host
 * distills credential presence and Gateway observations into one sanitized,
 * actionable view for the settings surface — never the token value, never a
 * raw provider response. Invalid tokens and blocked intents map to their own
 * conditions with stable hint keys the card resolves to copy.
 */

import { describe, expect, it } from 'vitest'

import {
  createAdapterStatusTracker,
  projectAdapterStatus,
  type GatewayObservation,
} from '../src/features/adapter-status.js'

describe('adapter status projection', () => {
  it('reports a configured token and a connected gateway', () => {
    expect(projectAdapterStatus({ token: 'configured', gateway: 'connected' })).toEqual({
      token: 'configured',
      connection: 'connected',
      hint: undefined,
    })
  })

  it('maps the authentication-failure close to an invalid-token condition', () => {
    const view = projectAdapterStatus({
      token: 'configured',
      gateway: { kind: 'terminal-close', code: 4004 },
    })
    expect(view).toEqual({ token: 'configured', connection: 'invalid-token', hint: 'token-rejected' })
  })

  it('maps intent-rejection closes to an intents-blocked condition', () => {
    for (const code of [4013, 4014]) {
      const view = projectAdapterStatus({
        token: 'configured',
        gateway: { kind: 'terminal-close', code },
      })
      expect(view).toEqual({ token: 'configured', connection: 'intents-blocked', hint: 'enable-intents' })
    }
  })

  it('maps other terminal closes to a plain disconnected state', () => {
    const view = projectAdapterStatus({
      token: 'configured',
      gateway: { kind: 'terminal-close', code: 4010 },
    })
    expect(view).toEqual({ token: 'configured', connection: 'disconnected', hint: 'gateway-closed' })
  })

  it('asks for a token when the credential reference is unconfigured', () => {
    const view = projectAdapterStatus({ token: 'unconfigured', gateway: 'disconnected' })
    expect(view).toEqual({ token: 'unconfigured', connection: 'disconnected', hint: 'configure-token' })
  })

  it('reports missing channel permissions while staying honest about a live connection', () => {
    const blocked = projectAdapterStatus({
      token: 'configured',
      gateway: 'disconnected',
      detail: 'missing-channel-permissions',
    })
    expect(blocked).toEqual({
      token: 'configured',
      connection: 'permissions-blocked',
      hint: 'channel-permissions',
    })

    const live = projectAdapterStatus({
      token: 'configured',
      gateway: 'connected',
      detail: 'missing-channel-permissions',
    })
    expect(live.connection).toBe('connected')
  })

  it('never carries the token value or raw responses in the projected view', () => {
    const view = projectAdapterStatus({
      token: 'configured',
      gateway: { kind: 'terminal-close', code: 4004 },
      detail: 'missing-channel-permissions',
    })
    expect(JSON.stringify(view)).not.toContain('super-secret-token')
    expect(Object.keys(view).sort()).toEqual(['connection', 'hint', 'token'])
  })

  it('tracks the latest credential and gateway observations', () => {
    const tracker = createAdapterStatusTracker()
    expect(tracker.project()).toEqual({
      token: 'unconfigured',
      connection: 'disconnected',
      hint: 'configure-token',
    })

    tracker.setCredential({ configured: true, writable: true })
    tracker.setGateway('connecting')
    expect(tracker.project()).toEqual({ token: 'configured', connection: 'connecting', hint: undefined })

    tracker.setGateway({ kind: 'terminal-close', code: 4014 })
    expect(tracker.project()).toEqual({ token: 'configured', connection: 'intents-blocked', hint: 'enable-intents' })

    tracker.setGateway('connected')
    expect(tracker.project().connection).toBe('connected')
  })

  it('accepts every declared observation shape without inventing states', () => {
    const tracker = createAdapterStatusTracker()
    const shapes: GatewayObservation[] = [
      'connected',
      'connecting',
      'disconnected',
      { kind: 'terminal-close', code: 4004 },
    ]
    for (const shape of shapes) {
      tracker.setGateway(shape)
      expect(tracker.project().connection).toBeDefined()
    }
  })
})
