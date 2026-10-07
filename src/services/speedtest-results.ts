import type { SpeedtestResult } from './speedtest'

export interface SavedSpeedtestResult extends SpeedtestResult {
  delayTestedAt?: number
  downloadTestedAt?: number
}

type Results = Record<string, SavedSpeedtestResult>
const snapshots = new Map<string, Results>()
const listeners = new Set<() => void>()
const empty: Results = {}
const storageKey = (profile: string) =>
  `clash-verge-speedtest-results-v1:${encodeURIComponent(profile)}`

export function getSpeedtestResults(profile: string | null): Results {
  if (profile === null) return empty
  const cached = snapshots.get(profile)
  if (cached) return cached
  let results: Results = {}
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(profile)) ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      results = Object.fromEntries(
        Object.entries(parsed).filter(([name, value]) => {
          const result = value as SavedSpeedtestResult | null
          return (
            result?.node === name &&
            (result.delay === null || Number.isFinite(result.delay)) &&
            (result.bytesPerSecond === null ||
              Number.isFinite(result.bytesPerSecond))
          )
        }),
      ) as Results
    }
  } catch {
    // A damaged local record must not prevent opening the proxy page.
  }
  snapshots.set(profile, results)
  return results
}

export function saveSpeedtestResult(
  profile: string,
  result: SpeedtestResult,
  metrics: { latency: boolean; download: boolean },
  testedAt = Date.now(),
) {
  const previous = getSpeedtestResults(profile)
  const old = previous[result.node]
  const next: Results = {
    ...previous,
    [result.node]: {
      ...result,
      delay: metrics.latency ? result.delay : (old?.delay ?? null),
      delayError: metrics.latency
        ? result.delayError
        : (old?.delayError ?? null),
      delayTestedAt: metrics.latency ? testedAt : old?.delayTestedAt,
      bytesPerSecond: metrics.download
        ? result.bytesPerSecond
        : (old?.bytesPerSecond ?? null),
      bytes: metrics.download ? result.bytes : (old?.bytes ?? 0),
      downloadError: metrics.download
        ? result.downloadError
        : (old?.downloadError ?? null),
      downloadTestedAt: metrics.download ? testedAt : old?.downloadTestedAt,
    },
  }
  snapshots.set(profile, next)
  let saved = true
  try {
    localStorage.setItem(storageKey(profile), JSON.stringify(next))
  } catch {
    saved = false
  }
  listeners.forEach((listener) => listener())
  return saved
}

export function subscribeSpeedtestResults(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
