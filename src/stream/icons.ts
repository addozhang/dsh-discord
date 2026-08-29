/**
 * The adapter's fixed iconography table (stream-renderer "Fixed
 * adapter-owned iconography"). This module is the ONLY source of icons:
 * tool-state marks are exception-only (running 🟡, failed ❌, succeeded
 * quiet — the disappearing amber marker is the completion signal), category
 * icons ride the tool-label allowlist's first word, and notices use
 * kind-fixed prefixes. Icons are never derived from model output, tool
 * output, or Host presentation views; sanitized text labels stay unchanged
 * beside them, and assistant answer text carries no icon prefix.
 */

import type { ToolState } from './tool-view.js'

/** Exception-only state marks: only outcomes that need attention are marked. */
const TOOL_STATE_ICONS: Readonly<Record<ToolState, string>> = {
  running: '🟡',
  failed: '❌',
  interrupted: '❌',
  succeeded: '',
}

/** The tool state mark for a row ('' when the row stays quiet). */
export function toolStateIcon(state: ToolState): string {
  return TOOL_STATE_ICONS[state]
}

/** Category icon by the sanitized label's first word (the label allowlist). */
const TOOL_CATEGORY_ICONS: Readonly<Record<string, string>> = {
  Shell: '⌨️',
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
