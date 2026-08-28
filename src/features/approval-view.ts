/**
 * Approval control rendering (design.md §8, task 13.1). A pending DSH
 * approval renders as Allow once / Reject buttons whose custom_ids are
 * opaque registry keys minted per control — session, rpc, approval, tool,
 * and reason data never ride the Discord wire. Visible text reuses the
 * activity surface's safe allowlisted labels (generic fallback) and the
 * outbound mention posture: the host-supplied reason is mention-neutralized
 * and bounded before display.
 */

import type { ComponentRegistry } from '../discord/components.js'
import { DISCORD_SUPPRESS_MENTIONS_FLAG } from '../policy/disclosure.js'
import { suppressMentionSyntax } from '../policy/suppress.js'
import { toolLabel } from '../stream/tool-view.js'

/** The reason text cap; the host decides content, the adapter decides size. */
const REASON_MAX = 300

/** Discord interactive-component ids (action row = 1, button = 2). */
const ACTION_ROW = 1
const BUTTON = 2
const BUTTON_STYLE_SUCCESS = 3
const BUTTON_STYLE_DANGER = 4

export interface ApprovalViewInput {
  registry: ComponentRegistry
  sessionId: string
  rpcId: string
  approvalId: string
  toolName: string
  reason?: string | undefined
  /** The approval deadline; the controls expire with it (13.4). */
  expiresAtMs: number
}

export interface ApprovalButton {
  type: typeof BUTTON
  style: typeof BUTTON_STYLE_SUCCESS | typeof BUTTON_STYLE_DANGER
  label: string
  custom_id: string
}

export interface ApprovalViewPayload {
  content: string
  flags: typeof DISCORD_SUPPRESS_MENTIONS_FLAG
  components: Array<{ type: typeof ACTION_ROW; components: ApprovalButton[] }>
}

function boundedReason(reason: string): string {
  const neutralized = suppressMentionSyntax(reason)
  return neutralized.length <= REASON_MAX ? neutralized : `${neutralized.slice(0, REASON_MAX)}…`
}

/**
 * Render one pending approval. Both controls resolve through the registry to
 * `{ approvalId, action, expiresAtMs }`, so routing (13.2/13.3) recovers the
 * pending record from durable state, never from the wire.
 */
export function renderApprovalControls(input: ApprovalViewInput): ApprovalViewPayload {
  const { registry } = input
  const allowId = registry.register({ approvalId: input.approvalId, action: 'allow', expiresAtMs: input.expiresAtMs })
  const rejectId = registry.register({ approvalId: input.approvalId, action: 'reject', expiresAtMs: input.expiresAtMs })

  const reason = input.reason === undefined ? '' : `\n${boundedReason(input.reason)}`
  const content = `Approval required — ${toolLabel(input.toolName)}${reason}`

  return {
    content,
    flags: DISCORD_SUPPRESS_MENTIONS_FLAG,
    components: [
      {
        type: ACTION_ROW,
        components: [
          { type: BUTTON, style: BUTTON_STYLE_SUCCESS, label: 'Allow once', custom_id: allowId },
          { type: BUTTON, style: BUTTON_STYLE_DANGER, label: 'Reject', custom_id: rejectId },
        ],
      },
    ],
  }
}
