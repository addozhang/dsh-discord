/**
 * Markdown-aware splitting (design.md §8, task 11.6). Fenced code blocks stay
 * balanced across chunk boundaries: a cut inside a fence closes it at the end
 * of the earlier chunk and reopens it — same language — at the top of the
 * next. Output ending inside a fence gets the fence closed. Table rows are
 * ordinary lines, so line-boundary breaking keeps them intact.
 */

import { splitMessage } from './splitter.js'

const FENCE_PATTERN = /^\s*(```[a-zA-Z0-9_-]*)\s*$/u

/** Append a closing fence when `text` ends inside an open block. */
export function closeOpenFences(text: string): string {
  const lines = text.split('\n')
  let open = false
  for (const line of lines) {
    if (FENCE_PATTERN.test(line)) open = !open
  }
  return open ? `${text}\n\`\`\`` : text
}

interface FenceState {
  /** The fence line (with language) currently open, or empty. */
  open: string
}

function rebalanceChunk(chunk: string, state: FenceState): string {
  const lines = chunk.split('\n')
  const out: string[] = []

  if (state.open !== '') {
    out.push(state.open)
  }
  for (const line of lines) {
    if (state.open !== '') {
      out.push(line)
      if (line.trim() === '```') {
        state.open = ''
      }
      continue
    }
    const match = FENCE_PATTERN.exec(line)
    if (match !== null) {
      state.open = match[1] ?? '```'
    }
    out.push(line)
  }
  if (state.open !== '') {
    out.push('```')
  }
  return out.join('\n')
}

/**
 * Split like the base splitter, then rebalance fences across chunks: each
 * chunk renders as well-formed Markdown on its own, and fence language
 * markers survive the boundary.
 */
export function splitMarkdownAware(text: string, limit: number): string[] {
  const base = splitMessage(text, limit)
  const state: FenceState = { open: '' }
  const rebalanced = base.map(chunk => rebalanceChunk(chunk, state))
  return rebalanced.filter(chunk => chunk.trim() !== '')
}
