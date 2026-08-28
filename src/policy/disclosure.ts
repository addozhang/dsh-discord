/**
 * Least-disclosure labels and output policy. Workspace lists show titles
 * disambiguated by short opaque id suffixes — never filesystem paths; the
 * canonical path is disclosed only inside an administrator-scoped detail
 * object. User-controlled text is sanitized before it can forge Discord
 * mentions or overflow component limits, and every outbound message carries
 * the SUPPRESS_MENTIONS flag so assistant, tool, title, and error content can
 * never ping anyone.
 */

import { suppressMentionSyntax } from './suppress.js'

/** A workspace as the adapter's listing surfaces see it. */
export interface WorkspaceEntry {
  id: string
  title: string
  /** Canonical path; disclosed only to administrators, never in lists. */
  path?: string | undefined
}

/** One rendered row of a Workspace list. */
export interface WorkspaceLabel {
  id: string
  title: string
  /** Discord-renderable label carrying no path. */
  label: string
}

/** Discord's SUPPRESS_MENTIONS message flag (1 << 12). */
export const DISCORD_SUPPRESS_MENTIONS_FLAG = 1 << 12

/** Component label ceiling imposed by Discord. */
const DISCORD_LABEL_MAX = 100
/** Length of the id tail used to disambiguate duplicate titles. */
const DISAMBIGUATOR_TAIL = 4

function stripControlCharacters(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (code < 9 || (code > 13 && code < 32) || code === 127) continue
    out += char
  }
  return out
}

function sanitizePart(text: string): string {
  return suppressMentionSyntax(
    stripControlCharacters(text)
      .replace(/[\r\n]+/gu, ' ')
      .replace(/ {2,}/gu, ' ')
      .trim(),
  )
}

/**
 * Sanitize user-controlled text for safe rendering as a label or title:
 * control characters and line breaks collapse, mention syntax breaks, and
 * Discord's component length ceiling applies.
 */
export function safeTitle(text: string, maxLength: number = DISCORD_LABEL_MAX): string {
  const cleaned = sanitizePart(text)
  return cleaned.length <= maxLength ? cleaned : cleaned.slice(0, maxLength)
}

/**
 * Label a Workspace list: unique titles stay bare; duplicate titles gain a
 * short id suffix so every label stays unambiguous without exposing paths.
 * Escalating suffix groups grow together (4 → 8 → … chars, then the full id)
 * and stay deterministic.
 */
export function workspaceLabels(entries: readonly WorkspaceEntry[]): WorkspaceLabel[] {
  const groups = new Map<string, number[]>()
  entries.forEach((entry, index) => {
    const title = safeTitle(entry.title)
    const group = groups.get(title) ?? []
    group.push(index)
    groups.set(title, group)
  })

  const labels = new Array<string>(entries.length)
  for (const [title, indices] of groups) {
    const single = indices[0]
    if (indices.length === 1 && single !== undefined) {
      labels[single] = title
      continue
    }
    for (let tailLength = DISAMBIGUATOR_TAIL; ; tailLength += DISAMBIGUATOR_TAIL) {
      const tails = indices.map((index) => {
        const id = entries[index]?.id ?? ''
        return id.slice(-Math.min(tailLength, id.length))
      })
      const unique = new Set(tails).size === indices.length
      const atFullLength = indices.every(index => (entries[index]?.id.length ?? 0) <= tailLength)
      if (unique || atFullLength) {
        indices.forEach((index, position) => {
          const tail = tails[position] ?? ''
          labels[index] = `${title} (${tail})`
        })
        break
      }
    }
  }

  return entries.map((entry, index) => ({
    id: entry.id,
    title: safeTitle(entry.title),
    label: labels[index] ?? safeTitle(entry.title),
  }))
}

/** The opaque value a select option encodes for choosing this workspace. */
export function workspaceReference(id: string): string {
  return `ws:${id}`
}

export interface WorkspaceDetail {
  id: string
  title: string
  label: string
  /** Canonical path; present only when the caller proved administrator scope. */
  path?: string | undefined
}

/**
 * Project one workspace for display. `includePath` is reserved for the
 * administrator-only ephemeral detail response; list surfaces always pass
 * false, so a path never reaches channel metadata or public messages.
 */
export function describeWorkspace(entry: WorkspaceEntry, options: { includePath: boolean }): WorkspaceDetail {
  const [labeled] = workspaceLabels([entry])
  const label = labeled?.label ?? safeTitle(entry.title)
  return {
    id: entry.id,
    title: safeTitle(entry.title),
    label,
    ...(options.includePath && entry.path !== undefined ? { path: entry.path } : {}),
  }
}
