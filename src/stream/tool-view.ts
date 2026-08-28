/**
 * The bounded tool activity surface (design.md §8, task 11.8). Parallel tool
 * calls each own one status row keyed by `callId`. Labels come from a safe
 * allowlist (generic fallback otherwise — an unknown tool name never reaches
 * Discord). Raw arguments and output are accepted for correlation but are
 * structurally excluded from every render. Verbosity gates visibility:
 * `text-only` renders nothing; `essential-tools` and `full-tools` render the
 * same bounded rows in Milestone 1.
 */

import type { DiscordVerbosity } from '../settings.js'

export type ToolState = 'running' | 'succeeded' | 'failed' | 'interrupted'

export interface ToolRow {
  callId: string
  label: string
  state: ToolState
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

export interface ToolRecordInput {
  callId: string
  toolName: string
  state: ToolState
  /** Accepted for correlation only; never rendered. */
  rawArguments?: string | undefined
  rawOutput?: string | undefined
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
      rows.set(input.callId, { callId: input.callId, label: toolLabel(input.toolName), state: input.state })
    },
    render: () => [...rows.values()],
  }
}
