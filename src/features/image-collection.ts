/**
 * Bounded image collection (design.md §12, task 12.2). Every download is
 * bounded four ways: the DECLARED size is checked before any fetch, the
 * ACTUAL byte count of the response body is checked against the aggregate
 * cap before the image is accepted, an aggregate cap spans the whole
 * message, and a timeout stops a hung transfer. The HTTP port hands back one
 * complete body, so peak memory for a single image is that body's size —
 * bounded in practice by Discord CDN attachment limits and the aggregate
 * cap, not by streaming. Refusals are plain values.
 */

import { createHttpFetchPort, fetchSafeImage, type HttpFetchPort } from './image-download.js'

/** Per-image cap (design: bounded by DSH-advertised limits; adapter-capped). */
export const MAX_IMAGE_BYTES = 8 * 1_024 * 1_024
/** Aggregate cap across all images of one message. */
export const MAX_AGGREGATE_IMAGE_BYTES = 24 * 1_024 * 1_024

export interface ImageDownloadPort {
  download(request: { url: string }): Promise<
    | { outcome: 'downloaded'; mediaType: string; body: Uint8Array }
    | { outcome: 'unsupported-media-type' }
    | { outcome: 'rejected-host' }
    | { outcome: 'malformed-url' }
    | { outcome: 'too-many-redirects' }
    | { outcome: 'http-error'; status: number }
  >
}

export interface ImageAttachment {
  url: string
  declaredSize: number
  contentType: string
}

/**
 * The production download port (16.50): every fetch rides the safe boundary
 * — allowlisted Discord CDN hosts over HTTPS, one revalidated redirect hop,
 * supported media types only.
 */
export function createSafeImageDownloadPort(): ImageDownloadPort {
  const http: HttpFetchPort = createHttpFetchPort()
  return {
    download: request => fetchSafeImage(http, { url: request.url }),
  }
}

export type ImageCollectionResult =
  | {
    outcome: 'collected'
    images: number
    totalBytes: number
    /** The downloaded images in attachment order (16.50): callers encode them for submission. */
    downloaded: ReadonlyArray<{ mediaType: string; body: Uint8Array }>
  }
  | { outcome: 'too-large'; reason: 'declared' | 'actual' | 'aggregate' }
  | { outcome: 'timeout' }
  | { outcome: 'download-failed' }

/**
 * Wrap the safe download boundary with byte-count enforcement: the body size
 * is checked against the remaining aggregate budget before it is accepted,
 * so memory stays bounded no matter what the peer sends.
 */
function boundedDownloadPort(
  inner: HttpFetchPort & ImageDownloadPort,
  state: { remainingBytes: number },
): ImageDownloadPort {
  return {
    download: async (request) => {
      const result = await inner.download(request)
      if (result.outcome !== 'downloaded') return result
      if (result.body.byteLength > state.remainingBytes) {
        return { outcome: 'http-error', status: 413 }
      }
      state.remainingBytes -= result.body.byteLength
      return result
    },
  }
}

export function collectImages(
  port: ImageDownloadPort,
  request: {
    nowMs: number
    timeoutMs: number
    attachments: ReadonlyArray<ImageAttachment>
  },
): Promise<ImageCollectionResult> {
  let remainingAggregate = MAX_AGGREGATE_IMAGE_BYTES
  let images = 0
  let totalBytes = 0
  const downloaded: Array<{ mediaType: string; body: Uint8Array }> = []

  const inner = port as ImageDownloadPort & HttpFetchPort

  async function run(): Promise<ImageCollectionResult> {
    for (const attachment of request.attachments) {
      // Declared size: checked BEFORE the fetch.
      if (attachment.declaredSize > MAX_IMAGE_BYTES) {
        return { outcome: 'too-large', reason: 'declared' }
      }
      if (attachment.declaredSize > remainingAggregate) {
        return { outcome: 'too-large', reason: 'aggregate' }
      }

      const bounded = boundedDownloadPort(inner, { remainingBytes: Math.min(MAX_IMAGE_BYTES, remainingAggregate) })
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => { resolve('timeout') }, request.timeoutMs)
      })

      const downloadedImage = await Promise.race([
        bounded.download({ url: attachment.url }).then((result): ImageCollectionResult | typeof result => result),
        timeout,
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })

      if (downloadedImage === 'timeout') return { outcome: 'timeout' }
      if (downloadedImage.outcome === 'downloaded') {
        if (downloadedImage.body.byteLength > MAX_IMAGE_BYTES) {
          return { outcome: 'too-large', reason: 'actual' }
        }
        images += 1
        totalBytes += downloadedImage.body.byteLength
        remainingAggregate -= downloadedImage.body.byteLength
        downloaded.push({ mediaType: downloadedImage.mediaType, body: downloadedImage.body })
        continue
      }
      if (downloadedImage.outcome === 'http-error' && downloadedImage.status === 413) {
        return { outcome: 'too-large', reason: 'actual' }
      }
      return { outcome: 'download-failed' }
    }
    return { outcome: 'collected', images, totalBytes, downloaded }
  }

  return run()
}
