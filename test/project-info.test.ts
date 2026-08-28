/**
 * `/project info` disclosure tests (7.6): members receive the workspace title
 * and opaque id only; the canonical path appears exclusively in a
 * Workspace-administrator's ephemeral response. Every response is ephemeral.
 */

import { describe, expect, it } from 'vitest'

import { projectInfo } from '../src/features/project-info.js'

const WORKSPACE = { id: 'aaaaaaaa-1234', title: 'App', path: '/srv/secret/app' }
const ADMIN = { allowed: true, level: 'workspace-administrator' } as const
const OPERATOR = { allowed: true, level: 'host-operator' } as const
const MEMBER = { allowed: true, level: 'member' } as const

describe('/project info', () => {
  it('shows title and opaque id to members without the path', () => {
    const view = projectInfo({ decision: MEMBER, workspace: WORKSPACE })
    expect(view.outcome).toBe('info')
    if (view.outcome !== 'info') return
    expect(view.workspace.title).toBe('App')
    expect(view.workspace.id).toBe('aaaaaaaa-1234')
    expect(JSON.stringify(view)).not.toContain('/srv')
    expect(view.response).toBe('ephemeral')
  })

  it('discloses the canonical path in the administrator response', () => {
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
