/**
 * Safe image download boundary tests (12.1): only supported media types from
 * allowlisted Discord CDN hosts over HTTPS; redirects revalidate against the
 * same rules with one hop maximum; malformed URLs and foreign hosts refuse
 * before any fetch.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHttpFetchPort, fetchSafeImage, validateImageUrl, type HttpFetchPort } from '../src/features/image-download.js'

interface StubResponse {
  status?: number
  contentType?: string
  location?: string
  body?: Uint8Array
}

function fetchPort(response: StubResponse): HttpFetchPort & { fetchMock: (url: string) => Promise<{ status: number; contentType: string | undefined; location?: string | undefined; body?: Uint8Array | undefined }> } {
  const fetchMock = vi.fn((_url: string): Promise<{ status: number; contentType: string | undefined; location?: string | undefined; body?: Uint8Array | undefined }> =>
    Promise.resolve({
      status: response.status ?? 200,
      contentType: response.contentType ?? 'image/png',
      ...(response.location === undefined ? {} : { location: response.location }),
      body: response.body ?? new Uint8Array([1, 2, 3]),
    }))
  return { fetch: fetchMock, fetchMock }
}

describe('validateImageUrl', () => {
  it('accepts https URLs on the Discord CDN allowlist', () => {
    expect(validateImageUrl('https://cdn.discordapp.com/attachments/1/2/file.png?ex=abc&is=def&hm=ghi').ok)
      .toBe(true)
    expect(validateImageUrl('https://media.discordapp.net/attachments/1/2/file.png').ok)
      .toBe(true)
  })

  it('rejects malformed URLs and non-HTTPS schemes', () => {
    expect(validateImageUrl('not a url').ok).toBe(false)
    expect(validateImageUrl('http://cdn.discordapp.com/a.png').ok).toBe(false)
    expect(validateImageUrl('ftp://cdn.discordapp.com/a.png').ok).toBe(false)
  })

  it('rejects foreign hosts before any fetch', () => {
    expect(validateImageUrl('https://evil.example.com/a.png').ok).toBe(false)
    expect(validateImageUrl('https://cdn.discordapp.com.evil.com/a.png').ok).toBe(false)
  })
})

describe('fetchSafeImage', () => {
  it('downloads a supported image from the allowlisted host', async () => {
    const port = fetchPort({ status: 200, contentType: 'image/png' })
    const result = await fetchSafeImage(port, { url: 'https://cdn.discordapp.com/a.png' })
    expect(result).toMatchObject({ outcome: 'downloaded', mediaType: 'image/png' })
    expect(port.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects unsupported media types after checking the content type', async () => {
    const port = fetchPort({ status: 200, contentType: 'application/pdf' })
    const result = await fetchSafeImage(port, { url: 'https://cdn.discordapp.com/a.pdf' })
    expect(result).toEqual({ outcome: 'unsupported-media-type' })
  })

  it('rejects malformed URLs and foreign hosts without fetching', async () => {
    const port = fetchPort({ status: 200 })
    expect(await fetchSafeImage(port, { url: 'https://evil.example.com/a.png' })).toEqual({ outcome: 'rejected-host' })
    expect(await fetchSafeImage(port, { url: '::garbage::' })).toEqual({ outcome: 'malformed-url' })
    expect(port.fetchMock).not.toHaveBeenCalled()
  })

  it('follows one redirect hop only after revalidating it against the allowlist', async () => {
    const fetchMock = vi.fn((url: string): Promise<{ status: number; contentType: string | undefined; location?: string | undefined; body?: Uint8Array | undefined }> =>
      Promise.resolve(url.endsWith('a.png')
        ? { status: 302, contentType: undefined, location: 'https://cdn.discordapp.com/real.png', body: new Uint8Array() }
        : { status: 200, contentType: 'image/png', body: new Uint8Array([9]) }))
    const port: HttpFetchPort = { fetch: fetchMock }

    const result = await fetchSafeImage(port, { url: 'https://cdn.discordapp.com/a.png' })
    expect(result).toMatchObject({ outcome: 'downloaded', mediaType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://cdn.discordapp.com/real.png')
  })

  it('refuses a redirect to a foreign host', async () => {
    const port = fetchPort({ status: 302, location: 'https://evil.example.com/a.png', contentType: '' })
    const result = await fetchSafeImage(port, { url: 'https://cdn.discordapp.com/a.png' })
    expect(result).toEqual({ outcome: 'rejected-host' })
    expect(port.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a redirect chain beyond one hop', async () => {
    const redirectingPort: HttpFetchPort = {
      fetch: (url: string) => {
        void url
        const response: { status: number; contentType: string | undefined; location: string; body: Uint8Array } = {
          status: 302,
          contentType: undefined,
          location: 'https://cdn.discordapp.com/more.png',
          body: new Uint8Array(),
        }
        return Promise.resolve(response)
      },
    }
    const result = await fetchSafeImage(redirectingPort, { url: 'https://cdn.discordapp.com/a.png' })
    expect(result).toEqual({ outcome: 'too-many-redirects' })
  })

  it('surfaces HTTP errors as values', async () => {
    const port = fetchPort({ status: 404 })
    expect(await fetchSafeImage(port, { url: 'https://cdn.discordapp.com/gone.png' }))
      .toEqual({ outcome: 'http-error', status: 404 })
  })
})

describe('createHttpFetchPort (production fetch boundary)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('maps a 200 image response onto the port shape with the body bytes', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request) =>
      Promise.resolve(new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }))))
    const result = await createHttpFetchPort().fetch('https://cdn.discordapp.com/a.png')
    expect(result.status).toBe(200)
    expect(result.contentType).toBe('image/png')
    expect(result.location).toBeUndefined()
    expect(result.body).toEqual(bytes)
  })

  it('exposes the redirect location without reading a body', async () => {
    const fetchMock = vi.fn((_url: string | URL | Request) =>
      Promise.resolve(new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.discordapp.com/real.png' },
      })))
    vi.stubGlobal('fetch', fetchMock)
    const result = await createHttpFetchPort().fetch('https://cdn.discordapp.com/a.png')
    expect(result.status).toBe(302)
    expect(result.location).toBe('https://cdn.discordapp.com/real.png')
    expect(result.body).toBeUndefined()
  })

  it('leaves content type and body undefined when the response omits them', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string | URL | Request) =>
      Promise.resolve(new Response(null, { status: 404 }))))
    const result = await createHttpFetchPort().fetch('https://cdn.discordapp.com/gone.png')
    expect(result.status).toBe(404)
    expect(result.contentType).toBeUndefined()
    expect(result.body).toBeUndefined()
  })
})
