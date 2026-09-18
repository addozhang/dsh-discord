/**
 * The bounded tool activity surface (design.md §8, task 11.8). Parallel tool
 * calls each own one status row keyed by `callId`. Labels come from a safe
 * allowlist (generic fallback otherwise — an unknown tool name never reaches
 * Discord). Raw arguments and output are accepted for correlation and are
 * structurally excluded from every render, with one curated exception: the
 * shell command title (see {@link shellCommandTitle}) — the field the rc.2
 * host view itself disclosed, now derived locally because the 0.1.6 wire
 * carries no host-curated views. Verbosity gates visibility:
 * `text-only` renders nothing; `essential-tools` and `full-tools` render the
 * same bounded rows in Milestone 1.
 */

import { safeTitle } from '../policy/disclosure.js'
import type { DiscordVerbosity } from '../settings.js'

export type ToolState = 'running' | 'succeeded' | 'failed' | 'interrupted'

export interface ToolRow {
  callId: string
  label: string
  state: ToolState
  /** Host-presented title (command / call title); falls back to the label. */
  title: string | undefined
}

/** Safe, category-level labels for allowlisted tools. */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  bash: 'Shell',
  read: 'Read file',
  write: 'Write file',
  edit: 'Edit file',
  grep: 'Search',
  glob: 'Find files',
  web: 'Web',
}

/** The safe label for a tool name: allowlisted categories, generic fallback. */
export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? 'Tool'
}

/**
 * The shell command for one tool call, curated from its JSON arguments the
 * way the rc.2 host view titled terminal cards: only the `command` string of
 * shell-family tools, first line only, sanitized + truncated through the
 * disclosure policy — every other argument field stays unrendered.
 */
export function shellCommandTitle(toolName: string, rawArguments: string | undefined): string | undefined {
  if (rawArguments === undefined || rawArguments === '') return undefined
  if (toolName !== 'bash' && toolName !== 'pwsh') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const command = (parsed as { command?: unknown }).command
  if (typeof command !== 'string' || command.trim() === '') return undefined
  const firstLine = command.split('\n')[0]?.trim() ?? ''
  return firstLine === '' ? undefined : safeTitle(firstLine)
}

export interface ToolRecordInput {
  callId: string
  toolName: string
  state: ToolState
  /** Accepted for correlation only; never rendered. */
  rawArguments?: string | undefined
  rawOutput?: string | undefined
  /**
   * The Host presentation view's title (a terminal call's command, or the
   * call title) — Host-curated disclosure, rendered sanitized + truncated.
   */
  title?: string | undefined
}

export interface ToolActivitySurface {
  record(input: ToolRecordInput): void
  render(): ToolRow[]
}

export function createToolActivitySurface(options: { verbosity: DiscordVerbosity }): ToolActivitySurface {
  const rows = new Map<string, ToolRow>()

  return {
    record(input) {
      if (options.verbosity === 'text-only') return
      rows.set(input.callId, {
        callId: input.callId,
        label: toolLabel(input.toolName),
        state: input.state,
        title: input.title,
      })
    },
    render: () => [...rows.values()],
  }
}
