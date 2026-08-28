import { describe, expect, it } from 'vitest'

import {
  createSettingsDraft,
  presentCredentialStatus,
  serializeIdList,
} from '../src/client/settings-model.js'

describe('settings card model', () => {
  it('never includes a stored credential value in its public status', () => {
    expect(presentCredentialStatus({ configured: true, writable: true, source: 'file' }))
      .toEqual({ label: 'Configured', writable: true, source: 'file' })
  })

  it('parses newline-delimited Discord IDs into a detached draft', () => {
    expect(createSettingsDraft({
      enabled: true,
      allowedGuildIds: ['123456789012345678'],
    })).toMatchObject({
      enabled: true,
      allowedGuildIds: '123456789012345678',
    })
    expect(serializeIdList('123456789012345678\n 223456789012345678 '))
      .toEqual(['123456789012345678', '223456789012345678'])
  })
})
