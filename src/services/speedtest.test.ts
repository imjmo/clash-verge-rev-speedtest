import { describe, expect, it } from 'vitest'

import { sortSpeedtestRows, type SpeedtestResult } from './speedtest'

describe('speedtest result ordering', () => {
  const sample = (
    node: string,
    delay: number | null,
    bytesPerSecond: number | null,
  ): SpeedtestResult => ({
    node,
    delay,
    bytesPerSecond,
    bytes: 0,
    delayError: null,
    downloadError: null,
  })
  const nodes = ['slow', 'failed', 'fast', 'pending']
  const results = {
    slow: sample('slow', 150, 100),
    fast: sample('fast', 0, 500),
    failed: sample('failed', null, null),
  }
  it('keeps failed and untested nodes last in either direction and accepts zero latency', () => {
    expect(sortSpeedtestRows(nodes, results, 'delay', 'asc')).toEqual([
      'fast',
      'slow',
      'failed',
      'pending',
    ])
    expect(sortSpeedtestRows(nodes, results, 'delay', 'desc')).toEqual([
      'slow',
      'fast',
      'failed',
      'pending',
    ])
    expect(sortSpeedtestRows(nodes, results, 'bytesPerSecond', 'desc')).toEqual(
      ['fast', 'slow', 'failed', 'pending'],
    )
    expect(sortSpeedtestRows(nodes, results, 'bytesPerSecond', 'asc')).toEqual([
      'slow',
      'fast',
      'failed',
      'pending',
    ])
    expect(nodes).toEqual(['slow', 'failed', 'fast', 'pending'])
  })
})
