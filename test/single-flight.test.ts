/**
 * Trailing-edge single flight: a trigger that lands mid-flight forces
 * exactly one re-run after the in-flight pass; concurrent triggers
 * coalesce. Failures surface through onThrew but still serve later
 * triggers.
 */

import { describe, expect, it, vi } from 'vitest'

import { createTrailingSingleFlight } from '../src/features/single-flight.js'

describe('createTrailingSingleFlight', () => {
  it('re-runs once after the in-flight pass when a trigger lands mid-flight', async () => {
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const flight = createTrailingSingleFlight(async () => {
      runs += 1
      if (runs === 1) await gate
    })

    flight()
    flight()
    flight()
    expect(runs).toBe(1)

    release()
    await vi.waitFor(() => { expect(runs).toBe(2) })
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(runs).toBe(2)
  })

  it('surfaces failures through onThrew and still serves a mid-flight trigger', async () => {
    let runs = 0
    const threw: unknown[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const flight = createTrailingSingleFlight(async () => {
      runs += 1
      if (runs === 1) {
        await gate
        throw new Error('first pass failed')
      }
    }, { onThrew: cause => { threw.push(cause) } })

    flight()
    flight()
    release()
    await vi.waitFor(() => { expect(runs).toBe(2) })
    expect(threw).toHaveLength(1)
  })

  it('runs immediately when idle', async () => {
    let runs = 0
    const flight = createTrailingSingleFlight(() => Promise.resolve().then(() => { runs += 1 }))
    flight()
    await vi.waitFor(() => { expect(runs).toBe(1) })
  })
})
