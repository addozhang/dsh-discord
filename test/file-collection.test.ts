/**
 * Bounded text-file collection (16.114). A non-image attachment is model
 * input, so every boundary — CDN allowlist, declared and actual sizes,
 * aggregate cap, timeout, strict UTF-8 — must refuse as a VALUE without ever
 * letting the adapter talk to a foreign host.
 */

import { describe, expect, it } from 'vitest'

import {
  ATTACHED_FILE_BEGIN,
  ATTACHED_FILE_END,
  MAX_AGGREGATE_FILE_BYTES,
  MAX_FILE_BYTES,
  MAX_MESSAGE_FILES,
  collectFiles,
  formatFileTextPart,
  stripAttachedFileBlocks,
  type FileAttachment,
} from '../src/features/file-collection.js'
import type { HttpFetchPort } from '../src/features/image-download.js'

const URL_A = 'https://cdn.discordapp.com/attachments/1/2/notes.txt?ex=abc'
const encoder = new TextEncoder()

function file(overrides: Partial<FileAttachment> = {}): FileAttachment {
  return {
    url: URL_A,
    filename: 'notes.txt',
    declaredSize: 12,
    contentType: 'text/plain; charset=utf-8',
    ...overrides,
  }
}

type Script = Record<string, { status: number; contentType?: string; location?: string; body?: Uint8Array }>

function port(script: Script = {}): HttpFetchPort {
  return {
    fetch: (url) => {
      const entry = script[url] ?? { status: 200, contentType: 'text/plain', body: encoder.encode('hello world!') }
      return Promise.resolve({
        status: entry.status,
        contentType: entry.contentType,
        location: entry.location,
        body: entry.body,
      })
    },
  }
}

function request(attachments: ReadonlyArray<FileAttachment>, timeoutMs = 1_000) {
  return { nowMs: 1_000, timeoutMs, attachments }
}

describe('formatFileTextPart / stripAttachedFileBlocks', () => {
  it('labels the file with its declared metadata and content', () => {
    const part = formatFileTextPart({
      filename: 'notes.txt', contentType: 'text/plain; charset=utf-8', declaredSize: 12,
      index: 0, total: 2, content: 'hello world!',
    })
    expect(part).toContain(ATTACHED_FILE_BEGIN)
    expect(part).toContain('[Discord attachment 1/2: "notes.txt" (text/plain; charset=utf-8, 12 bytes)]')
    expect(part).toContain('hello world!')
    expect(part).toContain(ATTACHED_FILE_END)
  })

  it('removes whole file blocks from a user-message echo but keeps user prose', () => {
    const part = formatFileTextPart({
      filename: 'notes.txt', contentType: 'text/plain', declaredSize: 3,
      index: 0, total: 1, content: 'secret payload',
    })
    const echo = `please read the file\n${part}`
    expect(stripAttachedFileBlocks(echo)).toBe('please read the file')
    expect(stripAttachedFileBlocks(echo)).not.toContain('secret payload')
  })

  it('leaves ordinary text untouched', () => {
    expect(stripAttachedFileBlocks('just a normal prompt\nwith two lines')).toBe('just a normal prompt\nwith two lines')
  })
})

describe('collectFiles', () => {
  it('collects a text file into one labelled text part', async () => {
    const result = await collectFiles(port(), request([file()]))
    expect(result.outcome).toBe('collected')
    if (result.outcome !== 'collected') return
    expect(result.totalBytes).toBe(12)
    expect(result.texts).toHaveLength(1)
    expect(result.texts[0]).toContain('notes.txt')
    expect(result.texts[0]).toContain('hello world!')
  })

  it('keeps multiple files in attachment order', async () => {
    const result = await collectFiles(port({
      [URL_A]: { status: 200, body: encoder.encode('first') },
      'https://media.discordapp.net/attachments/1/2/second.txt': { status: 200, body: encoder.encode('second') },
    }), request([
      file(),
      file({ url: 'https://media.discordapp.net/attachments/1/2/second.txt', filename: 'second.txt' }),
    ]))
    expect(result.outcome).toBe('collected')
    if (result.outcome !== 'collected') return
    expect(result.texts).toHaveLength(2)
    expect(result.texts[0]).toContain('[Discord attachment 1/2: "notes.txt"')
    expect(result.texts[1]).toContain('[Discord attachment 2/2: "second.txt"')
  })

  it('refuses a declared size above the per-file cap before fetching', async () => {
    const fetch = port()
    const spy = { called: false }
    const guarded: HttpFetchPort = { fetch: async url => { spy.called = true; return fetch.fetch(url) } }
    const result = await collectFiles(guarded, request([file({ declaredSize: MAX_FILE_BYTES + 1 })]))
    expect(result).toEqual({ outcome: 'too-large', reason: 'declared' })
    expect(spy.called).toBe(false)
  })

  it('refuses an actual body larger than the per-file cap', async () => {
    const result = await collectFiles(
      port({ [URL_A]: { status: 200, body: new Uint8Array(MAX_FILE_BYTES + 1) } }),
      request([file()]),
    )
    expect(result).toEqual({ outcome: 'too-large', reason: 'actual' })
  })

  it('refuses when the aggregate size exceeds the message cap', async () => {
    // Three files each under MAX_FILE_BYTES but together over the aggregate
    // cap. Keeping the real bodies large makes the cap bite on actual bytes.
    const chunk = encoder.encode('a'.repeat(200 * 1024))
    const urls = [0, 1, 2].map(index => `https://cdn.discordapp.com/attachments/1/2/f-${String(index)}.txt`)
    const script: Script = {}
    for (const url of urls) script[url] = { status: 200, contentType: 'text/plain', body: chunk }
    expect(chunk.byteLength).toBeLessThan(MAX_FILE_BYTES)
    expect(chunk.byteLength * 3).toBeGreaterThan(MAX_AGGREGATE_FILE_BYTES)
    const result = await collectFiles(port(script), request(urls.map((url, index) => file({
      url,
      filename: `f-${String(index)}.txt`,
      declaredSize: chunk.byteLength,
    }))))
    expect(result).toEqual({ outcome: 'too-large', reason: 'aggregate' })
  })

  it('bounds a hung transfer with a timeout', async () => {
    const hung: HttpFetchPort = { fetch: () => new Promise(() => {}) }
    const result = await collectFiles(hung, request([file()], 10))
    expect(result).toEqual({ outcome: 'timeout' })
  })

  it('never fetches a URL outside the Discord CDN allowlist', async () => {
    const fetch = port()
    const spy = { called: false }
    const guarded: HttpFetchPort = { fetch: async url => { spy.called = true; return fetch.fetch(url) } }
    const result = await collectFiles(guarded, request([file({ url: 'https://evil.example/notes.txt' })]))
    expect(result).toEqual({ outcome: 'download-failed' })
    expect(spy.called).toBe(false)
  })

  it('refuses non-200 responses', async () => {
    const result = await collectFiles(port({ [URL_A]: { status: 403 } }), request([file()]))
    expect(result).toEqual({ outcome: 'download-failed' })
  })

  it('revalidates a redirect hop against the allowlist', async () => {
    const foreign = await collectFiles(port({
      [URL_A]: { status: 302, location: 'https://evil.example/notes.txt' },
    }), request([file()]))
    expect(foreign).toEqual({ outcome: 'download-failed' })

    const safe = await collectFiles(port({
      [URL_A]: { status: 302, location: 'https://media.discordapp.net/attachments/1/2/notes.txt' },
      'https://media.discordapp.net/attachments/1/2/notes.txt': { status: 200, body: encoder.encode('redirected') },
    }), request([file()]))
    expect(safe.outcome).toBe('collected')
    if (safe.outcome !== 'collected') return
    expect(safe.texts[0]).toContain('redirected')
  })

  it('refuses invalid UTF-8 and binary-looking payloads', async () => {
    const invalid = await collectFiles(port({ [URL_A]: { status: 200, body: new Uint8Array([0xff, 0xfe, 0xfd]) } }), request([file()]))
    expect(invalid).toEqual({ outcome: 'decode-failed' })
    const binary = await collectFiles(port({ [URL_A]: { status: 200, body: new Uint8Array([0, 1, 2, 3, 4, 5]) } }), request([file()]))
    expect(binary).toEqual({ outcome: 'decode-failed' })
  })

  it('caps the number of files carried from one message', async () => {
    const attachments = Array.from({ length: MAX_MESSAGE_FILES + 4 }, (_, index) => file({
      url: `https://cdn.discordapp.com/attachments/1/2/f-${String(index)}.txt`,
      filename: `f-${String(index)}.txt`,
    }))
    const result = await collectFiles(port(), request(attachments))
    expect(result.outcome).toBe('collected')
    if (result.outcome !== 'collected') return
    expect(result.texts).toHaveLength(MAX_MESSAGE_FILES)
  })

  it('collects an empty attachment list without touching the network', async () => {
    expect(await collectFiles(port(), request([]))).toEqual({ outcome: 'collected', texts: [], totalBytes: 0 })
  })
})
