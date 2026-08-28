/**
 * The base message splitter (design.md §8, task 11.5). Breaks prefer line
 * boundaries, then word boundaries, then a hard cut — iterating by code
 * points so surrogate pairs (emoji) never split mid-pair. Every chunk is
 * non-empty and within Discord's message limit.
 */

export const DISCORD_MESSAGE_LIMIT = 2_000

/** Code-point-safe slice: never splits a surrogate pair. */
function safeSlice(text: string, start: number, end: number): string {
  let end2 = Math.min(end, text.length)
  if (end2 < text.length) {
    const code = text.charCodeAt(end2 - 1)
    const next = text.charCodeAt(end2)
    // High surrogate at the last position followed by a low surrogate: pull back.
    if (code >= 0xD800 && code <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
      end2 -= 1
    }
  }
  return text.slice(start, end2)
}

export function splitMessage(text: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []

  if (trimmed.length <= limit) return [trimmed]

  const chunks: string[] = []
  let rest = trimmed
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1)

    // Prefer the last line break inside the window.
    let cut = window.lastIndexOf('\n')
    if (cut <= 0) {
      // Then the last word boundary.
      cut = window.lastIndexOf(' ')
    }
    if (cut <= 0) {
      // Hard cut at a code-point boundary.
      cut = limit
    }

    const chunk = safeSlice(rest, 0, cut).trim()
    if (chunk !== '') chunks.push(chunk)
    rest = rest.slice(cut === limit ? limit : cut + 1)
  }
  const tail = rest.trim()
  if (tail !== '') chunks.push(tail)
  return chunks
}
