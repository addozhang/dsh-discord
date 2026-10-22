/**
 * Markdown-aware splitting (design.md §8, task 11.6). Fenced code blocks stay
 * balanced across chunk boundaries: a cut inside a fence closes it at the end
 * of the earlier chunk and reopens it — same language — at the top of the
 * next. Output ending inside a fence gets the fence closed. GFM tables are
 * wrapped into fences (wrapGfmTables) before splitting, so they ride the
 * same balance guarantee.
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
 * markers survive the boundary. Rebalancing ADDS text (a reopened fence
 * line, a closing fence), so a piece that would grow past `limit` is
 * re-split at the reduced budget first — every returned chunk respects
 * `limit` by construction, not by accident.
 */
export function splitMarkdownAware(text: string, limit: number): string[] {
  const state: FenceState = { open: '' }
  const out: string[] = []

  // Worst-case rebalance growth for one piece: the carried-in fence line
  // plus its separator when a fence is open, and a trailing "\n```" when
  // the piece ends inside a fence (which it may open itself).
  function emit(base: string): void {
    const reserved = (state.open !== '' ? state.open.length + 1 : 0) + 4
    const canFit = base.length + reserved <= limit
    // Degenerate guard: a fence line longer than the limit can never fit;
    // emit it rebalanced like before rather than recursing forever.
    // Budget floor 2: a 1-char budget cannot make progress past a
    // surrogate pair (PR review) — emit degenerate instead of looping.
    const canShrink = base.length > 1 && limit - reserved >= 2 && limit - reserved < base.length
    if (canFit || !canShrink) {
      const rebalanced = rebalanceChunk(base, state)
      if (rebalanced.trim() !== '') out.push(rebalanced)
      return
    }
    for (const piece of splitMessage(base, Math.max(1, limit - reserved))) emit(piece)
  }

  for (const chunk of splitMessage(text, limit)) emit(chunk)
  return out
}

const TABLE_DELIMITER_ROW = /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/u

function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|')
}

/**
 * Discord does not render GFM tables: raw pipe rows collapse into ragged
 * text. A table region outside any fence — a header row, a delimiter row,
 * then body rows — is wrapped in a fence so Discord renders it as aligned
 * monospace. Regions inside fences are left untouched, and the resulting
 * fences are ordinary balanced fences to the splitter.
 */
export function wrapGfmTables(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence
      out.push(line)
      index += 1
      continue
    }
    if (!inFence && isTableRow(line)
        && TABLE_DELIMITER_ROW.test(lines[index + 1] ?? '')) {
      let end = index
      while (end < lines.length && isTableRow(lines[end] ?? '')) end += 1
      out.push('```', ...lines.slice(index, end), '```')
      index = end
      continue
    }
    out.push(line)
    index += 1
  }
  return out.join('\n')
}
