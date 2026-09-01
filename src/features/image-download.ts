/**
 * The safe image download boundary (design.md §12, task 12.1). Images enter
 * only from allowlisted Discord CDN hosts over HTTPS with supported media
 * types. Redirects are followed at most ONE hop and every hop revalidates
 * against the same host/protocol rules — an open redirect cannot leak the
 * bot's fetch authority to a foreign server. Every rejection is a value
 * decided BEFORE any network activity where possible.
 */

const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
])

const SUPPORTED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

const MAX_REDIRECTS = 1

export type ImageUrlValidation =
  | { ok: true; url: URL }
  | { ok: false }

/**
 * Validate an untrusted image URL: HTTPS, an exact allowlisted host, and a
 * parseable URL. Host matching is exact — suffix lookalikes
 * (`cdn.discordapp.com.evil.com`) refuse.
 */
export function validateImageUrl(rawUrl: string): ImageUrlValidation {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false }
  }
  if (url.protocol !== 'https:') return { ok: false }
  if (!ALLOWED_HOSTS.has(url.hostname)) return { ok: false }
  return { ok: true, url }
}

/** The fetch surface the downloader uses (no redirect following built in). */
export interface HttpFetchPort {
  fetch(url: string): Promise<{
    status: number
    contentType: string | undefined
    location?: string | undefined
    body?: Uint8Array | undefined
  }>
}

export type SafeImageResult =
  | { outcome: 'downloaded'; mediaType: string; body: Uint8Array }
  | { outcome: 'malformed-url' }
  | { outcome: 'rejected-host' }
  | { outcome: 'unsupported-media-type' }
  | { outcome: 'too-many-redirects' }
  | { outcome: 'http-error'; status: number }

async function fetchOnce(
  port: HttpFetchPort,
  hopsLeft: number,
  request: { url: string },
): Promise<SafeImageResult> {
  const validation = validateImageUrl(request.url)
  if (!validation.ok) {
    return isParseable(request.url) ? { outcome: 'rejected-host' } : { outcome: 'malformed-url' }
  }

  const response = await port.fetch(request.url)

  if (response.status >= 300 && response.status < 400) {
    if (hopsLeft === 0) return { outcome: 'too-many-redirects' }
    const location = response.location
    if (location === undefined) return { outcome: 'http-error', status: response.status }
    return fetchOnce(port, hopsLeft - 1, { url: location })
  }

  if (response.status !== 200) {
    return { outcome: 'http-error', status: response.status }
  }

  const contentType = (response.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!SUPPORTED_MEDIA_TYPES.has(contentType)) {
    return { outcome: 'unsupported-media-type' }
  }

  return {
    outcome: 'downloaded',
    mediaType: contentType,
    body: response.body ?? new Uint8Array(),
  }
}

function isParseable(rawUrl: string): boolean {
  try {
    void new URL(rawUrl)
    return true
  } catch {
    return false
  }
}

export function fetchSafeImage(port: HttpFetchPort, request: { url: string }): Promise<SafeImageResult> {
  return fetchOnce(port, MAX_REDIRECTS, request)
}

/**
 * The production fetch boundary over the platform `fetch` (16.50). Redirects
 * are NOT followed here — `fetchSafeImage` revalidates every hop itself —
 * and the body is only read for a terminal 200 response.
 */
export function createHttpFetchPort(): HttpFetchPort {
  return {
    async fetch(url: string) {
      const response = await fetch(url, { redirect: 'manual' })
      const location = response.headers.get('location')
      const contentType = response.headers.get('content-type')
      const body = response.status === 200 ? new Uint8Array(await response.arrayBuffer()) : undefined
      return {
        status: response.status,
        contentType: contentType ?? undefined,
        location: location ?? undefined,
        body,
      }
    },
  }
}
