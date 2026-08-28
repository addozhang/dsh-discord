import { describe, expect, it } from 'vitest'

import { apply, name } from '../src/index.js'

describe('package scaffold', () => {
  it('exports the stable Cordis plugin identity', () => {
    expect(name).toBe('dsh-discord')
    apply()
  })
})
