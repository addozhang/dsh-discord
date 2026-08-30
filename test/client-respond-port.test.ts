/**
 * The ClientResponse envelope contract (the exact bug class that shipped):
 * apiProxy.respond takes {type, rpcId, result} — posting the bare payload
 * is silently dropped by the Host. The port builds the envelope and maps
 * the RpcReceipt onto port outcomes.
 */

import { describe, expect, it, vi } from 'vitest'

import { createClientRespondPort } from '../src/dsh/api-proxy-face.js'

function createFakeDsh(receipt: unknown) {
  const sent: Array<Record<string, unknown>> = []
  return {
    sent,
    respond: (message: unknown) => {
      sent.push(message as Record<string, unknown>)
      return Promise.resolve(receipt)
    },
  }
}

describe('createClientRespondPort', () => {
  it('sends the full ClientResponse envelope with the payload in result.value', async () => {
    const fake = createFakeDsh({ accepted: true })
    const port = createClientRespondPort(fake)
    const payload = { sessionId: 's-1', approvalId: 'a-1', outcome: 'allowed-once' }

    const outcome = await port.respond('rpc-1', payload)

    expect(outcome).toEqual({ outcome: 'confirmed' })
    expect(fake.sent[0]).toEqual({
      type: 'client-response',
      rpcId: 'rpc-1',
      result: { ok: true, value: payload },
    })
  })

  it('maps a refused receipt onto rejected', async () => {
    const fake = createFakeDsh({ accepted: false, reason: 'not-pending' })
    const port = createClientRespondPort(fake)

    await expect(port.respond('rpc-1', {})).resolves.toEqual({
      outcome: 'rejected',
      reason: 'not-pending',
    })
  })

  it('maps an unshaped receipt onto unknown', async () => {
    const port = createClientRespondPort(createFakeDsh(undefined))
    await expect(port.respond('rpc-1', {})).resolves.toEqual({ outcome: 'unknown' })
  })

  it('maps a rejecting respond onto unknown instead of throwing', async () => {
    const log = vi.fn()
    const port = createClientRespondPort(
      { respond: () => Promise.reject(new Error('host rejected the envelope')) },
      { log },
    )

    await expect(port.respond('rpc-1', {})).resolves.toEqual({ outcome: 'unknown' })
    expect(log).toHaveBeenCalledWith('discord_client_respond_threw', expect.objectContaining({ rpcId: 'rpc-1' }))
  })

  it('maps a never-answering respond onto unknown via the bounded window', async () => {
    vi.useFakeTimers()
    try {
      const log = vi.fn()
      const port = createClientRespondPort(
        { respond: () => new Promise(() => {}) },
        { log, timeoutMs: 5 },
      )
      const pending = port.respond('rpc-1', {})
      const outcome = await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(10)
        return pending
      })
      expect(outcome).toEqual({ outcome: 'unknown' })
      expect(log).toHaveBeenCalledWith('discord_client_respond_timeout', expect.objectContaining({ rpcId: 'rpc-1' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('echoes the question answer batch through the same envelope', async () => {
    const fake = createFakeDsh({ accepted: true })
    const port = createClientRespondPort(fake)
    const answer = { answers: [{ id: 'q1', selected: ['Retry with approval'] }] }

    await port.respond('rpc-2', { sessionId: 's-1', answer })

    expect(fake.sent[0]?.result).toEqual({ ok: true, value: { sessionId: 's-1', answer } })
  })
})
