/**
 * `/project info` disclosure tests (7.6, amended by design §3): every
 * authorized member sees the Workspace identity and its canonical path —
 * paths are not sensitive for this trusted-Guild product — and every
 * response is ephemeral. Denied actors are refused outright.
 */

import { describe, expect, it } from 'vitest'

import { projectInfo } from '../src/features/project-info.js'

const WORKSPACE = { id: 'aaaaaaaa-1234', title: 'App', path: '/srv/secret/app' }
const ADMIN = { allowed: true, level: 'workspace-administrator' } as const
const OPERATOR = { allowed: true, level: 'host-operator' } as const
const MEMBER = { allowed: true, level: 'member' } as const

describe('/project info', () => {
  it('shows the title and canonical path to an authorized member', () => {
    const view = projectInfo({ decision: MEMBER, workspace: WORKSPACE })
    expect(view.outcome).toBe('info')
    if (view.outcome !== 'info') return
    expect(view.workspace.title).toBe('App')
    expect(view.workspace.id).toBe('aaaaaaaa-1234')
    expect(view.workspace.path).toBe('/srv/secret/app')
    expect(view.response).toBe('ephemeral')
  })

  it('shows the path at administrator authority', () => {
    const view = projectInfo({ decision: ADMIN, workspace: WORKSPACE })
    expect(view.outcome).toBe('info')
    if (view.outcome !== 'info') return
    expect(view.workspace.path).toBe('/srv/secret/app')
    expect(view.response).toBe('ephemeral')
  })

  it('treats the host operator at administrator authority', () => {
    const view = projectInfo({ decision: OPERATOR, workspace: WORKSPACE })
    if (view.outcome !== 'info') return
    expect(view.workspace.path).toBe('/srv/secret/app')
  })

  it('refuses a denied actor outright', () => {
    const view = projectInfo({ decision: { allowed: false, reason: 'denied' }, workspace: WORKSPACE })
    expect(view).toEqual({ outcome: 'refused', reason: 'not-authorized' })
  })
})
