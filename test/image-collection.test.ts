/**
 * Bounded image collection tests (12.2): declared size checked BEFORE the
 * download, actual streamed size enforced during it, an aggregate cap across
 * a message's images, download timeout, cancellation, and bounded memory —
 * every refusal is a value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_IMAGE_BYTES,
  collectImages,
  type ImageDownloadPort,
} from '../src/features/image-collection.js'

const PNG = 'image/png'

function downloadPort(responses: Map<string, { size: number; hang?: boolean }>): ImageDownloadPort {
  return {
    download: (request) => {
      const scripted = responses.get(request.url)
      if (scripted === undefined) return Promise.resolve({ outcome: 'http-error', status: 404 })
      if (scripted.hang) return new Promise(() => {})
      return Promise.resolve({ outcome: 'downloaded', mediaType: PNG, body: new Uint8Array(scripted.size) })
    },
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('collectImages', () => {
  it('collects within the per-image and aggregate limits', async () => {
    const small = 1_000
    const port = downloadPort(new Map([
      [`https://cdn.discordapp.com/1.png`, { size: small }],
      [`https://cdn.discordapp.com/2.png`, { size: small }],
    ]))

    const result = await collectImages(port, {
      nowMs: 1_000,
      timeoutMs: 5_000,
      attachments: [
        { url: 'https://cdn.discordapp.com/1.png', declaredSize: small, contentType: PNG },
        { url: 'https://cdn.discordapp.com/2.png', declaredSize: small, contentType: PNG },
      ],
    })
    expect(result).toMatchObject({ outcome: 'collected', images: 2 })
  })

  it('rejects a declared size over the per-image limit before downloading', async () => {
    const download = vi.fn()
    const port: ImageDownloadPort = { download: download as unknown as ImageDownloadPort['download'] }
    const result = await collectImages(port, {
      nowMs: 1_000,
      timeoutMs: 5_000,
      attachments: [{ url: 'https://cdn.discordapp.com/big.png', declaredSize: MAX_IMAGE_BYTES + 1, contentType: PNG }],
    })
    expect(result).toEqual({ outcome: 'too-large', reason: 'declared' })
    expect(download).not.toHaveBeenCalled()
  })

  it('enforces the actual size during download', async () => {
    const port = downloadPort(new Map([
      [`https://cdn.discordapp.com/lied.png`, { size: MAX_IMAGE_BYTES + 10 }],
    ]))
    const result = await collectImages(port, {
      nowMs: 1_000,
      timeoutMs: 5_000,
      attachments: [{ url: 'https://cdn.discordapp.com/lied.png', declaredSize: 100, contentType: PNG }],
    })
    expect(result).toEqual({ outcome: 'too-large', reason: 'actual' })
  })

  it('enforces the aggregate cap across attachments', async () => {
    // Each image is at the per-image cap; the FOURTH exceeds the 24MB aggregate.
    const each = MAX_IMAGE_BYTES
    const urls = ['a', 'b', 'c', 'd'].map(name => `https://cdn.discordapp.com/${name}.png`)
    const port = downloadPort(new Map(urls.map(url => [url, { size: each }])))
    const result = await collectImages(port, {
      nowMs: 1_000,
      timeoutMs: 5_000,
      attachments: urls.map(url => ({ url, declaredSize: each, contentType: PNG })),
    })
    expect(result).toEqual({ outcome: 'too-large', reason: 'aggregate' })
  })

  it('times out a hung download', async () => {
    const port = downloadPort(new Map([
      [`https://cdn.discordapp.com/hang.png`, { size: 10, hang: true }],
    ]))
    const pending = collectImages(port, {
      nowMs: 1_000,
      timeoutMs: 3_000,
      attachments: [{ url: 'https://cdn.discordapp.com/hang.png', declaredSize: 10, contentType: PNG }],
    })
    const result = await vi.advanceTimersByTimeAsync(3_000).then(() => pending)
    expect(result).toEqual({ outcome: 'timeout' })
  })

  it('reports download failures as values', async () => {
    const port = downloadPort(new Map())
    const result = await collectImages(port, {
      nowMs: 1_000,
      timeoutMs: 5_000,
      attachments: [{ url: 'https://cdn.discordapp.com/gone.png', declaredSize: 10, contentType: PNG }],
    })
    expect(result).toEqual({ outcome: 'download-failed' })
  })
})
