/**
 * The Milestone 1 command contract is fixed by design.md §13: nine top-level
 * commands with their subcommands, arguments, guild-only contexts, and
 * ephemeral response visibility. Registration payloads are built from that
 * one declaration so the wire shape can never drift from the contract table.
 */

import { describe, expect, it } from 'vitest'

import { MILESTONE_ONE_COMMANDS, buildCommandRegistrations } from '../src/discord/commands.js'

describe('milestone one command set', () => {
  it('declares exactly the nine fixed commands', () => {
    expect(MILESTONE_ONE_COMMANDS.map(command => command.name)).toEqual([
      'project', 'session', 'queue', 'steer', 'stop', 'model', 'preset', 'skill', 'host',
    ])
  })

  it('declares the fixed subcommands and arguments', () => {
    const subcommands = new Map(
      MILESTONE_ONE_COMMANDS.map(command => [
        command.name,
        (command.subcommands ?? []).map(sub => [
          sub.name,
          sub.options?.map(option => [option.name, option.required]) ?? [],
        ]),
      ]),
    )
    expect(subcommands.get('project')).toEqual([
      ['list', [['query', false]]],
      ['bind', [['workspace', true]]],
      ['info', []],
    ])
    expect(subcommands.get('session')).toEqual([
      ['new', [['prompt', true]]],
      ['resume', [['session', true]]],
    ])
    expect(subcommands.get('queue')).toEqual([
      ['list', []],
      ['remove', [['item', true]]],
    ])
    expect(subcommands.get('model')).toEqual([
      ['show', []],
      ['select', [['model', true], ['reasoning', false]]],
    ])
    expect(subcommands.get('preset')).toEqual([
      ['show', []],
      ['select', [['preset', true]]],
      ['reset', []],
    ])
    expect(subcommands.get('skill')).toEqual([
      ['run', [['skill', true], ['input', false]]],
    ])
    expect(subcommands.get('host')).toEqual([['status', []]])

    // Direct options on leaf commands.
    expect(MILESTONE_ONE_COMMANDS.find(command => command.name === 'steer')?.options).toEqual([
      { name: 'prompt', required: true },
    ])
    expect(MILESTONE_ONE_COMMANDS.find(command => command.name === 'stop')?.options).toBeUndefined()
  })

  it('marks every response surface ephemeral and guild-only', () => {
    for (const command of MILESTONE_ONE_COMMANDS) {
      expect(command.guildOnly, command.name).toBe(true)
      expect(command.responseVisibility, command.name).toBe('ephemeral')
    }
  })

  it('builds wire registration payloads from the single declaration', () => {
    const payloads = buildCommandRegistrations()
    expect(payloads).toHaveLength(MILESTONE_ONE_COMMANDS.length)
    for (const payload of payloads) {
      expect(payload['type']).toBe(1)
      expect(payload['contexts']).toEqual([0])
      expect(payload['default_member_permissions']).toBe('0')
      expect(typeof payload['name']).toBe('string')
      expect(typeof payload['description']).toBe('string')
    }

    const project = payloads.find(payload => payload['name'] === 'project') as Record<string, unknown>
    const options = project['options'] as Array<Record<string, unknown>>
    expect(options.map(option => option['type'])).toEqual([1, 1, 1])
    const bind = options.find(option => option['name'] === 'bind') as Record<string, unknown>
    const bindOptions = bind['options'] as Array<Record<string, unknown>>
    // The workspace option autocompletes (type-4 interactions): live
    // candidates while typing, so no id is ever copy-pasted.
    expect(bindOptions).toEqual([{
      type: 3,
      name: 'workspace',
      description: expect.any(String) as unknown,
      required: true,
      autocomplete: true,
    }])
  })
})
