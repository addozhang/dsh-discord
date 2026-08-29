/**
 * Per-workspace channel naming and placement (design.md §4, 15.10 followup).
 * Names slugify without ever carrying a filesystem path; placement never
 * steals a channel another Workspace already owns.
 */

import { describe, expect, it } from 'vitest'

import { planWorkspaceChannel, workspaceChannelName } from '../src/features/workspace-channel.js'

describe('workspaceChannelName', () => {
  it('slugifies spaces and case', () => {
    expect(workspaceChannelName('My Project')).toBe('my-project')
  })

  it('strips characters Discord does not allow', () => {
    expect(workspaceChannelName('feed/pulse: v2?')).toBe('feed-pulse-v2')
  })

  it('collapses separators and trims edges', () => {
    expect(workspaceChannelName('  --a   b__  ')).toBe('a-b')
  })

  it('falls back to the raw title when it has no ascii slug', () => {
    expect(workspaceChannelName('中文工作区')).toBe('中文工作区')
  })

  it('never returns an empty name', () => {
    expect(workspaceChannelName('///')).toBe('///')
    expect(workspaceChannelName('---')).toBe('---')
  })
})

describe('planWorkspaceChannel', () => {
  const channels = [
    { id: 'cat', name: 'DeepSeek Harness', parentId: undefined },
    { id: 'ch-free', name: 'tmp', parentId: 'cat' },
    { id: 'ch-other', name: 'tmp', parentId: 'cat' },
    { id: 'ch-ours', name: 'tmp', parentId: 'cat' },
    { id: 'ch-loose', name: 'tmp', parentId: undefined },
  ]
  const bindings = new Map([
    ['ch-other', 'other-workspace' as const],
    ['ch-ours', 'this-workspace' as const],
  ])
  const bindingOf = (channelId: string): 'unbound' | 'this-workspace' | 'other-workspace' =>
    bindings.get(channelId) ?? 'unbound'

  it('creates the channel when none exists under the category', () => {
    expect(planWorkspaceChannel({ channels: [], categoryId: 'cat', desiredName: 'tmp', bindingOf }))
      .toEqual({ outcome: 'create', name: 'tmp' })
  })

  it('reuses an unbound same-name channel and marks it for binding', () => {
    const plan = planWorkspaceChannel({ channels, categoryId: 'cat', desiredName: 'tmp', bindingOf })
    expect(plan).toEqual({ outcome: 'reuse', channelId: 'ch-free', needsBind: true })
  })

  it('reuses our own channel without rebinding', () => {
    const bound = new Map([['ch-ours', 'this-workspace' as const]])
    const plan = planWorkspaceChannel({
      channels: [{ id: 'ch-ours', name: 'tmp', parentId: 'cat' }],
      categoryId: 'cat',
      desiredName: 'tmp',
      bindingOf: id => bound.get(id) ?? 'unbound',
    })
    expect(plan).toEqual({ outcome: 'reuse', channelId: 'ch-ours', needsBind: false })
  })

  it('never steals another workspace\u2019s channel \u2014 it creates a sibling instead', () => {
    const onlyOther = [
      { id: 'ch-other', name: 'tmp', parentId: 'cat' },
    ]
    const plan = planWorkspaceChannel({
      channels: onlyOther,
      categoryId: 'cat',
      desiredName: 'tmp',
      bindingOf,
    })
    expect(plan).toEqual({ outcome: 'create', name: 'tmp-2' })
  })

  it('ignores same-name channels outside the category', () => {
    const plan = planWorkspaceChannel({
      channels: [{ id: 'ch-loose', name: 'tmp', parentId: undefined }],
      categoryId: 'cat',
      desiredName: 'tmp',
      bindingOf,
    })
    expect(plan).toEqual({ outcome: 'create', name: 'tmp' })
  })

  it('the existing home channel wins outright \u2014 one workspace, one channel', () => {
    // Even when another same-name channel is free and would match by name,
    // the channel already serving this workspace is reused without rebinding
    // ("a channel already exists for this directory").
    const plan = planWorkspaceChannel({
      channels,
      categoryId: 'cat',
      desiredName: 'tmp',
      bindingOf,
      existingForWorkspace: 'ch-ours',
    })
    expect(plan).toEqual({ outcome: 'reuse', channelId: 'ch-ours', needsBind: false })
  })

  it('the existing home channel wins even when it sits outside the category', () => {
    const plan = planWorkspaceChannel({
      channels: [],
      categoryId: 'cat',
      desiredName: 'tmp',
      bindingOf,
      existingForWorkspace: 'ch-anywhere',
    })
    expect(plan).toEqual({ outcome: 'reuse', channelId: 'ch-anywhere', needsBind: false })
  })
})
