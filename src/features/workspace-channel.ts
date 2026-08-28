/**
 * Per-workspace Discord channel naming and placement (design.md §4). A
 * successful bind may provision the workspace's home channel under the
 * adapter's category. The name is a Discord-safe slug of the Workspace
 * display title (never a path); placement reuses a same-name channel only
 * when it is unbound or already serves this Workspace — a channel bound to
 * another Workspace is never stolen, a suffixed sibling is created instead.
 */

/** Discord text-channel name: lowercase letters, digits, hyphen, underscore. */
export function workspaceChannelName(title: string): string {
  const trimmed = title.trim()
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 90)
    .replace(/[-_]+$/g, '')
  // Non-ASCII titles slugify to nothing; the raw title is Discord-legal and
  // preserves the name a user actually chose.
  return slug === '' ? trimmed.slice(0, 90) : slug
}

/** How the existing binding relates to the Workspace being bound. */
export type ChannelBindingState = 'unbound' | 'this-workspace' | 'other-workspace'

export type WorkspaceChannelPlacement =
  | { outcome: 'reuse'; channelId: string; needsBind: boolean }
  | { outcome: 'create'; name: string }

export interface WorkspaceChannelCandidate {
  id: string
  name: string
  parentId: string | undefined
}

/**
 * Decide create-vs-reuse for the workspace channel, Kimaki-add-project
 * style. The Workspace's existing home channel (any channel of this guild
 * already bound to this Workspace) wins outright: reuse without rebinding —
 * one Workspace, one channel. Otherwise a same-name channel under the
 * category is reused only when unbound; a channel serving another Workspace
 * is never stolen, and a `-2` sibling is created instead.
 */
export function planWorkspaceChannel(options: {
  channels: ReadonlyArray<WorkspaceChannelCandidate>
  categoryId: string
  desiredName: string
  bindingOf: (channelId: string) => ChannelBindingState
  /** A channel of this guild already bound to this Workspace, when known. */
  existingForWorkspace?: string | undefined
}): WorkspaceChannelPlacement {
  if (options.existingForWorkspace !== undefined) {
    return { outcome: 'reuse', channelId: options.existingForWorkspace, needsBind: false }
  }
  const sameName = options.channels.filter(
    channel => channel.parentId === options.categoryId && channel.name === options.desiredName,
  )
  const reusable = sameName.find(channel => options.bindingOf(channel.id) !== 'other-workspace')
  if (reusable !== undefined) {
    return {
      outcome: 'reuse',
      channelId: reusable.id,
      needsBind: options.bindingOf(reusable.id) === 'unbound',
    }
  }
  if (sameName.length === 0) return { outcome: 'create', name: options.desiredName }
  return { outcome: 'create', name: `${options.desiredName}-2` }
}
