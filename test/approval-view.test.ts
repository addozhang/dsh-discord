/**
 * Approval control rendering tests (13.1): a pending DSH approval renders as
 * Allow once / Reject buttons whose custom_ids are opaque registry keys —
 * no session, rpc, approval, tool, or reason data may ride the Discord wire.
 * Visible text stays bounded and mention-neutralized, with the same safe
 * allowlisted tool labels as the activity surface.
 */

import { describe, expect, it } from 'vitest'

import { createComponentRegistry, type ComponentRegistry } from '../src/discord/components.js'
import { renderApprovalControls } from '../src/features/approval-view.js'

const SECRET_SESSION = 'sess-MARKER-session'
const SECRET_RPC = 'rpc-MARKER-rpc'
const SECRET_APPROVAL = 'appr-MARKER-approval'

function setup(): { registry: ComponentRegistry } {
  let n = 0
  return { registry: createComponentRegistry({ idFactory: () => {
    n += 1
    return `opaque-${String(n)}`
  } }) }
}

function render(registry: ComponentRegistry, overrides: Partial<Parameters<typeof renderApprovalControls>[0]> = {}) {
  return renderApprovalControls({
    registry,
    sessionId: SECRET_SESSION,
    rpcId: SECRET_RPC,
    approvalId: SECRET_APPROVAL,
    toolName: 'bash',
    reason: 'needs to run rm -rf build',
    expiresAtMs: 1_000,
    ...overrides,
  })
}

describe('approval controls rendering', () => {
  it('renders Allow once and Reject buttons that resolve through the registry', () => {
    const { registry } = setup()
    const view = render(registry)

    const row = view.components[0]
    expect(row).toBeDefined()
    const buttons = row?.components ?? []
    expect(buttons).toHaveLength(2)

    const [allow, reject] = buttons
    expect(allow?.label).toBe('Allow once')
    expect(allow?.style).toBe(3)
    expect(reject?.label).toBe('Reject')
    expect(reject?.style).toBe(4)

    const allowResolution = registry.resolve(allow?.custom_id ?? '', 0)
    expect(allowResolution).toEqual({ found: true, context: { approvalId: SECRET_APPROVAL, action: 'allow', expiresAtMs: 1_000 } })
    const rejectResolution = registry.resolve(reject?.custom_id ?? '', 0)
    expect(rejectResolution).toEqual({ found: true, context: { approvalId: SECRET_APPROVAL, action: 'reject', expiresAtMs: 1_000 } })
  })

  it('keeps session, rpc, approval, tool, and reason data out of the custom_ids', () => {
    const { registry } = setup()
    const view = render(registry)

    for (const button of view.components[0]?.components ?? []) {
      expect(button.custom_id).toMatch(/^dc:[A-Za-z0-9-]+$/u)
      expect(button.custom_id).not.toContain('MARKER')
      expect(button.custom_id).not.toContain('bash')
      expect(button.custom_id).not.toContain('rm -rf')
    }
  })

  it('renders a safe allowlisted label and never the raw tool name', () => {
    const { registry } = setup()
    const view = render(registry)
    expect(view.content).toContain('Shell')

    const unknown = render(registry, { toolName: 'exotic_unknown_tool', reason: undefined })
    expect(unknown.content).toContain('Tool')
    expect(unknown.content).not.toContain('exotic_unknown_tool')
  })

  it('bounds and mention-neutralizes the reason text', () => {
    const { registry } = setup()
    const longReason = 'x'.repeat(1_000)
    const view = render(registry, { reason: `ping <@987654321> then ${longReason}` })

    expect(view.content).not.toContain('<@987654321>')
    expect(view.content.length).toBeLessThan(500)
    expect(view.content).toContain('…')
  })

  it('omits the reason line entirely when the host sent none', () => {
    const { registry } = setup()
    const view = render(registry, { reason: undefined })
    expect(view.content).toContain('Shell')
    expect(view.content).not.toContain('rm -rf')
  })

  it('registers the controls with the approval expiry so stale clicks miss', () => {
    const { registry } = setup()
    const view = render(registry)

    for (const button of view.components[0]?.components ?? []) {
      expect(registry.resolve(button.custom_id, 999)).toMatchObject({
        found: true,
        context: { approvalId: SECRET_APPROVAL },
      })
      expect(registry.resolve(button.custom_id, 1_000)).toEqual({ found: false })
    }
  })
})
