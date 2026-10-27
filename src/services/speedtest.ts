import { Channel, invoke } from '@tauri-apps/api/core'

export interface SpeedtestResult {
  node: string
  delay: number | null
  bytesPerSecond: number | null
  bytes: number
  delayError: string | null
  downloadError: string | null
}

export interface SpeedtestOptions {
  id: string
  nodes: string[]
  latency: boolean
  download: boolean
  latencyUrl: string
  downloadUrl: string
  seconds: number
  megabytes: number
}

export const DEFAULT_SPEEDTEST_DOWNLOAD =
  'https://cachefly.cachefly.net/100mb.test'

export interface SpeedtestProgress {
  node: string
  stage: 'preparing' | 'latency' | 'connecting' | 'download'
}

export function speedtestErrorKey(error: string) {
  if (/web page instead of test data/i.test(error))
    return 'proxies.speedtest.invalidPayload' as const
  if (/\b429\b/.test(error)) return 'proxies.speedtest.rateLimited' as const
  if (/\b403\b/.test(error)) return 'proxies.speedtest.accessDenied' as const
  if (/timed? ?out/i.test(error)) return 'proxies.speedtest.timedOut' as const
  if (/No download data/i.test(error))
    return 'proxies.speedtest.noData' as const
  return 'proxies.speedtest.failed' as const
}

interface ActiveSpeedtest {
  id: string
  profile: string
  node?: string
  current?: SpeedtestProgress
}
let activeSpeedtest: ActiveSpeedtest | null = null
const runListeners = new Set<() => void>()
export const getActiveSpeedtest = () => activeSpeedtest
export function subscribeActiveSpeedtest(listener: () => void) {
  runListeners.add(listener)
  return () => {
    runListeners.delete(listener)
  }
}

export const runSpeedtest = async (
  options: SpeedtestOptions,
  onResult: (result: SpeedtestResult) => void,
  context: { profile: string; node?: string },
) => {
  if (activeSpeedtest) throw new Error('Another speedtest is already running')
  activeSpeedtest = { id: options.id, ...context }
  runListeners.forEach((listener) => listener())
  const onResultChannel = new Channel<SpeedtestResult>()
  onResultChannel.onmessage = onResult
  const onProgressChannel = new Channel<SpeedtestProgress>()
  onProgressChannel.onmessage = (current) => {
    if (activeSpeedtest?.id !== options.id) return
    activeSpeedtest = { ...activeSpeedtest, current }
    runListeners.forEach((listener) => listener())
  }
  try {
    await invoke<void>('run_speedtest', {
      options,
      onResult: onResultChannel,
      onProgress: onProgressChannel,
    })
  } finally {
    activeSpeedtest = null
    runListeners.forEach((listener) => listener())
  }
}

export const cancelSpeedtest = (id: string) =>
  invoke<void>('cancel_speedtest', { id })

export type SpeedtestSort = 'node' | 'delay' | 'bytesPerSecond'

export interface SpeedtestProxy {
  type: unknown
  all?: string[]
  now?: string
  fixed?: string
}

export const isSpeedtestSelectable = (proxy?: SpeedtestProxy) =>
  !!proxy?.all &&
  ['Selector', 'URLTest', 'Fallback'].includes(String(proxy.type))

export function speedtestSelectionPath(
  proxies: Record<string, SpeedtestProxy>,
  group: string,
  node: string,
  seen = new Set<string>(),
): { group: string; node: string }[] | null {
  const proxy = proxies[group]
  if (seen.has(group) || !isSpeedtestSelectable(proxy)) return null
  if (proxy.all!.includes(node)) return [{ group, node }]
  const next = new Set(seen).add(group)
  const members = [...proxy.all!].sort(
    (a, b) => Number(b === proxy.now) - Number(a === proxy.now),
  )
  for (const member of members) {
    const path = speedtestSelectionPath(proxies, member, node, next)
    if (path) return [...path, { group, node: member }]
  }
  return null
}

export function speedtestCurrentNode(
  proxies: Record<string, SpeedtestProxy>,
  group: string,
) {
  const seen = new Set<string>()
  let name = group
  while (proxies[name]?.all) {
    if (seen.has(name)) return undefined
    seen.add(name)
    const next = proxies[name].now || proxies[name].fixed
    if (!next) return undefined
    name = next
  }
  return name || undefined
}

export function sortSpeedtestRows(
  nodes: string[],
  results: Record<string, SpeedtestResult>,
  field: SpeedtestSort,
  direction: 'asc' | 'desc',
) {
  const sign = direction === 'asc' ? 1 : -1
  return [...nodes].sort((a, b) => {
    if (field === 'node') return sign * a.localeCompare(b)
    const left = results[a]?.[field]
    const right = results[b]?.[field]
    if (left == null && right == null) return a.localeCompare(b)
    if (left == null) return 1
    if (right == null) return -1
    return sign * (left - right) || a.localeCompare(b)
  })
}
