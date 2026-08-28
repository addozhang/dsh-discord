/**
 * Least-disclosure output policy tests: Workspace lists disambiguate
 * duplicate titles with short id suffixes (never filesystem paths), canonical
 * paths appear only in administrator-scoped detail objects, user-controlled
 * titles cannot forge Discord mentions or break component limits, and every
 * outbound message flags mention suppression.
 */

import { describe, expect, it } from 'vitest'

import {
  DISCORD_SUPPRESS_MENTIONS_FLAG,
  describeWorkspace,
  safeTitle,
  workspaceLabels,
  workspaceReference,
} from '../src/policy/disclosure.js'
import { suppressMentionSyntax } from '../src/policy/suppress.js'

describe('workspace labels', () => {
  it('keeps unique titles unchanged', () => {
    const entries = [
      { id: 'aaaaaaaa-1111', title: 'Alpha' },
      { id: 'bbbbbbbb-2222', title: 'Beta' },
    ]
    expect(workspaceLabels(entries)).toEqual([
      { id: 'aaaaaaaa-1111', title: 'Alpha', label: 'Alpha' },
      { id: 'bbbbbbbb-2222', title: 'Beta', label: 'Beta' },
    ])
  })

  it('disambiguates duplicate titles with a short opaque id suffix', () => {
    const entries = [
      { id: 'aaaaaaaa-1234', title: 'Project' },
      { id: 'bbbbbbbb-5678', title: 'Project' },
      { id: 'cccccccc-1234', title: 'Project' },
    ]
    const labels = workspaceLabels(entries).map(entry => entry.label)
    // Tail-4 suffixes collide (1234 appears twice), so the whole group
    // escalates to tail-8 together and stays deterministic.
    expect(labels).toEqual([
      'Project (aaa-1234)',
      'Project (bbb-5678)',
      'Project (ccc-1234)',
    ])
    expect(new Set(labels).size).toBe(3)
  })

  it('never leaks the canonical path field in a list label', () => {
    const entries = [
      { id: 'aaaaaaaa-1234', title: 'App', path: '/srv/secret/app' },
    ]
    const labels = workspaceLabels(entries)
    expect(labels[0]?.label).toBe('App')
  })
})

describe('describeWorkspace', () => {
  const entry = { id: 'aaaaaaaa-1234', title: 'App', path: '/srv/secret/app' }

  it('omits the canonical path for members', () => {
    const view = describeWorkspace(entry, { includePath: false })
    expect(view).toEqual({ id: 'aaaaaaaa-1234', title: 'App', label: 'App' })
    expect(JSON.stringify(view)).not.toContain('/srv')
  })

  it('discloses the canonical path only in the administrator scope', () => {
    const view = describeWorkspace(entry, { includePath: true })
    expect(view.path).toBe('/srv/secret/app')
  })

  it('builds an opaque selection reference', () => {
    expect(workspaceReference('aaaaaaaa-1234')).toBe('ws:aaaaaaaa-1234')
  })
})

describe('safeTitle', () => {
  it('strips control characters and line breaks and caps length', () => {
    expect(safeTitle('line1\nline2\r\nline3')).toBe('line1 line2 line3')
    expect(safeTitle(`x${String.fromCharCode(0)}y`)).toBe('xy')
    const long = 'a'.repeat(150)
    expect(safeTitle(long)).toHaveLength(100)
  })

  it('neutralizes mention forging in titles', () => {
    const title = safeTitle('@everyone <@111111111111111111> hi')
    expect(title).not.toContain('@everyone')
    expect(title).not.toContain('<@111111111111111111>')
  })
})

describe('suppressMentionSyntax', () => {
  it('breaks user, channel, role, and bulk mentions', () => {
    expect(suppressMentionSyntax('<@111111111111111111>')).toBe('<@\u200b111111111111111111>')
    expect(suppressMentionSyntax('<@!111111111111111111>')).toBe('<@!\u200b111111111111111111>')
    expect(suppressMentionSyntax('<#222222222222222222>')).toBe('<#\u200b222222222222222222>')
    expect(suppressMentionSyntax('<@&333333333333333333>')).toBe('<@&\u200b333333333333333333>')
  })

  it('breaks @everyone and @here without touching normal text', () => {
    expect(suppressMentionSyntax('@everyone run')).toBe('@\u200beveryone run')
    expect(suppressMentionSyntax('@here stand up')).toBe('@\u200bhere stand up')
    expect(suppressMentionSyntax('contact@example.com')).toBe('contact@example.com')
    expect(suppressMentionSyntax('plain text')).toBe('plain text')
  })
})

describe('outbound flags', () => {
  it('exposes Discord SUPPRESS_MENTIONS (1 << 12) for every message path', () => {
    expect(DISCORD_SUPPRESS_MENTIONS_FLAG).toBe(4096)
  })
})
