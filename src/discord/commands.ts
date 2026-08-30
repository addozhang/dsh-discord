/**
 * The Milestone 1 Discord command contract (design.md §13). One declarative
 * table feeds both the adapter's own routing metadata and the Discord
 * registration payload, so the wire shape cannot drift from the contract:
 * nine fixed commands, guild-only, ephemeral responses, no Discord-level
 * permission gates (adapter RBAC decides at interaction time, deny-first).
 */

/** A command argument as the contract table declares it. */
export interface CommandArgument {
  name: string
  required: boolean
  /**
   * Discord sends a type-4 autocomplete interaction while the user types;
   * the adapter answers with live choices (live-candidates pattern).
   */
  autocomplete?: boolean
}

/** A subcommand of a top-level command. */
export interface CommandSubcommand {
  name: string
  options?: CommandArgument[]
}

/** One fixed top-level command. */
export interface AdapterCommand {
  name: string
  description: string
  subcommands?: CommandSubcommand[]
  /** Direct options for leaf commands (no subcommands). */
  options?: CommandArgument[]
  /** Milestone 1: guild-only; DMs are unsupported. */
  guildOnly: true
  /** Milestone 1: every response is ephemeral. */
  responseVisibility: 'ephemeral'
}

function leaf(name: string, description: string, options?: CommandArgument[]): AdapterCommand {
  return { name, description, ...(options === undefined ? {} : { options }), guildOnly: true, responseVisibility: 'ephemeral' }
}

function grouped(name: string, description: string, subcommands: CommandSubcommand[]): AdapterCommand {
  return { name, description, subcommands, guildOnly: true, responseVisibility: 'ephemeral' }
}

/** The complete Milestone 1 command set, in registration order. */
export const MILESTONE_ONE_COMMANDS: readonly AdapterCommand[] = [
  grouped('project', 'Bind this channel to a DSH workspace', [
    { name: 'list', options: [{ name: 'query', required: false, autocomplete: true }] },
    { name: 'bind', options: [{ name: 'workspace', required: true, autocomplete: true }] },
    { name: 'info' },
  ]),
  grouped('queue', 'Inspect the session inbox queue', [
    { name: 'list' },
    { name: 'remove', options: [{ name: 'item', required: true }] },
  ]),
  leaf('steer', 'Steer the running turn of this thread', [{ name: 'prompt', required: true }]),
  leaf('stop', 'Cancel the running turn of this thread'),
  grouped('model', 'Show or select the session model', [
    { name: 'show' },
    { name: 'select', options: [{ name: 'model', required: true }, { name: 'reasoning', required: false }] },
  ]),
  grouped('preset', 'Show, select, or reset this channel\'s agent preset', [
    { name: 'show' },
    { name: 'select', options: [{ name: 'preset', required: true }] },
    { name: 'reset' },
  ]),
  grouped('skill', 'Run a DSH skill through the session queue', [
    { name: 'run', options: [{ name: 'skill', required: true }, { name: 'input', required: false }] },
  ]),
  grouped('host', 'Show the connected DSH host status', [
    { name: 'status' },
  ]),
  grouped('guild', 'Guild-scoped adapter operations', [
    { name: 'forget' },
  ]),
]

const DISCORD_APPLICATION_COMMAND = 1
const DISCORD_SUBCOMMAND = 1
const DISCORD_STRING_OPTION = 3
/** 0 = interaction context "guild" (Telegram-style contexts list; no DMs). */
const DISCORD_GUILD_CONTEXT = 0

function argumentToWire(option: CommandArgument): Record<string, unknown> {
  return {
    type: DISCORD_STRING_OPTION,
    name: option.name,
    description: option.name,
    required: option.required,
    ...(option.autocomplete === true ? { autocomplete: true } : {}),
  }
}

/**
 * Build the bulk-overwrite registration payload for
 * `PUT /applications/{application.id}/commands`.
 * `default_member_permissions: '0'` keeps every command visible: the
 * adapter's own deny-first RBAC authorizes at interaction time, because
 * Discord roles cannot express Workspace-administrator or Host-operator
 * authority.
 */
export function buildCommandRegistrations(): Array<Record<string, unknown>> {
  return MILESTONE_ONE_COMMANDS.map((command) => {
    const options = command.subcommands !== undefined
      ? command.subcommands.map(sub => ({
          type: DISCORD_SUBCOMMAND,
          name: sub.name,
          description: `${command.name} ${sub.name}`,
          ...(sub.options === undefined ? {} : { options: sub.options.map(argumentToWire) }),
        }))
      : command.options?.map(argumentToWire)
    return {
      type: DISCORD_APPLICATION_COMMAND,
      name: command.name,
      description: command.description,
      contexts: [DISCORD_GUILD_CONTEXT],
      default_member_permissions: '0',
      ...(options === undefined || options.length === 0 ? {} : { options }),
    }
  })
}
