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

export const runSpeedtest = (
  options: SpeedtestOptions,
  onResult: (result: SpeedtestResult) => void,
) => {
  const onResultChannel = new Channel<SpeedtestResult>()
  onResultChannel.onmessage = onResult
  return invoke<void>('run_speedtest', { options, onResult: onResultChannel })
}

export const cancelSpeedtest = (id: string) =>
  invoke<void>('cancel_speedtest', { id })

export type SpeedtestSort = 'node' | 'delay' | 'bytesPerSecond'

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
