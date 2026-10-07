import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  sortSpeedtestRows,
  speedtestSelectionPath,
  speedtestCurrentNode,
  type SpeedtestResult,
} from './speedtest'

afterEach(() => vi.unstubAllGlobals())

it('keeps saved metrics across reloads and separates subscriptions with identical node names', async () => {
  const disk = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => disk.get(key) ?? null,
    setItem: (key: string, value: string) => disk.set(key, value),
  })
  vi.resetModules()
  const store = await import('./speedtest-results')
  const result = {
    node: 'Hong Kong',
    delay: 30,
    bytesPerSecond: 1024,
    bytes: 2048,
    delayError: null,
    downloadError: null,
  }
  store.saveSpeedtestResult(
    'subscription-a',
    result,
    { latency: true, download: true },
    10,
  )
  store.saveSpeedtestResult(
    'subscription-a',
    { ...result, delay: 45, bytesPerSecond: null, bytes: 0 },
    { latency: true, download: false },
    20,
  )
  expect(
    store.getSpeedtestResults('subscription-a')['Hong Kong'],
  ).toMatchObject({
    delay: 45,
    bytesPerSecond: 1024,
    bytes: 2048,
    delayTestedAt: 20,
    downloadTestedAt: 10,
  })
  expect(store.getSpeedtestResults('subscription-b')).toEqual({})
  vi.resetModules()
  const reloaded = await import('./speedtest-results')
  expect(
    reloaded.getSpeedtestResults('subscription-a')['Hong Kong'],
  ).toMatchObject({ delay: 45, bytesPerSecond: 1024 })
  reloaded.saveSpeedtestResult(
    'subscription-a',
    { ...result, delay: null, bytesPerSecond: null, downloadError: 'timeout' },
    { latency: false, download: true },
    30,
  )
  expect(
    reloaded.getSpeedtestResults('subscription-a')['Hong Kong'],
  ).toMatchObject({
    delay: 45,
    bytesPerSecond: null,
    downloadError: 'timeout',
    downloadTestedAt: 30,
  })
})

it('selects nested groups from the leaf upward and rejects unsupported or cyclic paths', () => {
  const proxies = {
    main: { type: 'Selector', all: ['auto', 'cycle'], now: 'auto' },
    auto: { type: 'URLTest', all: ['first', 'second'], now: 'first' },
    cycle: { type: 'Selector', all: ['main'] },
    balanced: { type: 'LoadBalance', all: ['first'] },
    first: { type: 'Shadowsocks' },
    second: { type: 'Shadowsocks' },
  }
  expect(speedtestSelectionPath(proxies, 'main', 'second')).toEqual([
    { group: 'auto', node: 'second' },
    { group: 'main', node: 'auto' },
  ])
  expect(speedtestCurrentNode(proxies, 'main')).toBe('first')
  expect(speedtestSelectionPath(proxies, 'main', 'missing')).toBeNull()
  expect(speedtestSelectionPath(proxies, 'balanced', 'first')).toBeNull()
})

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
