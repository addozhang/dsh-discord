/**
 * Component transport correlation tests: custom_ids are opaque — they carry
 * no DSH identifiers on the Discord wire — and the registry resolves them
 * back to the exact pending context, idempotently until expiry.
 */

import { describe, expect, it } from 'vitest'

import { createComponentRegistry } from '../src/discord/components.js'

function deterministicIds(prefix = '0') {
  let counter = 0
  return () => `${prefix}-${String(counter += 1)}`
}

describe('component registry', () => {
  it('hands out opaque ids that leak no correlated fields', () => {
    const registry = createComponentRegistry({ idFactory: deterministicIds() })
    const customId = registry.register({
      expiresAtMs: 10_000,
      sessionId: 'sess-secret-123',
      approvalId: 'appr-9',
      rpcId: 'rpc-1',
    })

    expect(customId.startsWith('dc:')).toBe(true)
    expect(customId.length).toBeLessThanOrEqual(100)
    expect(customId).not.toContain('sess-secret-123')
    expect(customId).not.toContain('appr-9')
    expect(customId).not.toContain('rpc-1')
  })

  it('resolves a custom id back to the exact registered context', () => {
    const registry = createComponentRegistry({ idFactory: deterministicIds() })
    const context = {
      expiresAtMs: 10_000,
      kind: 'approval',
      threadId: '444',
      actorId: '555',
      payload: { choice: 'allow-once' },
    }
    const customId = registry.register(context)
    const resolved = registry.resolve(customId, 5_000)
    expect(resolved).toEqual({ found: true, context })
  })

  it('reports unknown ids as not found', () => {
    const registry = createComponentRegistry({ idFactory: deterministicIds() })
    expect(registry.resolve('dc:nope', 0)).toEqual({ found: false })
  })

  it('lazily expires entries past their expiry and purges them', () => {
    const registry = createComponentRegistry({ idFactory: deterministicIds() })
    const customId = registry.register({ expiresAtMs: 1_000, kind: 'question' })

    expect(registry.resolve(customId, 999).found).toBe(true)
    expect(registry.resolve(customId, 1_000).found).toBe(false)
    expect(registry.resolve(customId, 500)).toEqual({ found: false })

    const unswept = registry.register({ expiresAtMs: 1_500, kind: 'sweep' })
    expect(registry.purgeExpired(2_000)).toBe(1)
    expect(registry.resolve(unswept, 2_001)).toEqual({ found: false })
  })

  it('never issues the same opaque id twice', () => {
    const registry = createComponentRegistry({ idFactory: deterministicIds() })
    const a = registry.register({ expiresAtMs: 10, kind: 'a' })
    const b = registry.register({ expiresAtMs: 10, kind: 'b' })
    expect(a).not.toBe(b)
  })

  it('keeps modal correlation readable repeatedly until expiry', () => {
    const registry = createComponentRegistry({ idFactory: deterministicIds() })
    const context = { expiresAtMs: 10_000, kind: 'modal', nonce: 'n-1', fields: ['answer'] }
    const customId = registry.register(context)

    expect(registry.resolve(customId, 1)).toEqual({ found: true, context })
    expect(registry.resolve(customId, 2)).toEqual({ found: true, context })
    expect(registry.resolve(customId, 9_999)).toEqual({ found: true, context })
  })

  it('supports a custom prefix within the custom_id length cap', () => {
    const registry = createComponentRegistry({ idFactory: deterministicIds(), prefix: 'dsrd' })
    const customId = registry.register({ expiresAtMs: 1 })
    expect(customId.startsWith('dsrd:')).toBe(true)
  })
})
