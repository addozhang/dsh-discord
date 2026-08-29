/**
 * The adapter's fixed iconography table (stream-renderer "Fixed
 * adapter-owned iconography"). This module is the ONLY source of icons:
 * tool rows carry one category icon each (never a run-state mark — state
 * flips would cost one message edit per tool transition), and notices use
 * kind-fixed prefixes. Icons are never derived from model output, tool
 * output, or Host presentation views; sanitized text labels stay unchanged
 * beside them, and assistant answer text carries no icon prefix.
 */

/** Category icon by the sanitized label's first word (the label allowlist). */
const TOOL_CATEGORY_ICONS: Readonly<Record<string, string>> = {
  Shell: '💻',
  Read: '📖',
  Write: '✍️',
  Edit: '✏️',
  Search: '🔍',
  Find: '🗂️',
  Web: '🌐',
}

const GENERIC_CATEGORY_ICON = '🧩'

/** The category icon for a sanitized tool label (generic fallback included). */
export function toolCategoryIcon(label: string): string {
  const firstWord = label.split(' ')[0] ?? ''
  return TOOL_CATEGORY_ICONS[firstWord] ?? GENERIC_CATEGORY_ICON
}

/** The notice kinds the adapter renders, with their fixed prefixes. */
export type NoticeKind = 'failure' | 'guidance' | 'stop' | 'steer' | 'queued'

const NOTICE_ICONS: Readonly<Record<NoticeKind, string>> = {
  failure: '⚠️',
  guidance: '💡',
  stop: '🛑',
  steer: '↪️',
  queued: '⏳',
}

/** The fixed prefix for a notice kind. */
export function noticeIcon(kind: NoticeKind): string {
  return NOTICE_ICONS[kind]
}
