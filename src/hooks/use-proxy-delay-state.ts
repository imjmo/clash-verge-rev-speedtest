import { useLockFn } from 'ahooks'
import { useCallback, useEffect, useReducer } from 'react'

import {
  useNodeSpeedtestResult,
  useSpeedtestProfile,
} from '@/hooks/use-speedtest-results'
import { useVerge } from '@/hooks/use-verge'
import delayManager, { type DelayUpdate } from '@/services/delay'
import { showNotice } from '@/services/notice-service'
import { saveSpeedtestResult } from '@/services/speedtest-results'
import type { SavedSpeedtestResult } from '@/services/speedtest-results'
import {
  isInteractableMember,
  memberDetails,
  type ResolvedProxyMember,
} from '@/types/proxy-view'

const PRESET_PROXY_NAMES = [
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS',
  'COMPATIBLE',
]

const identity = (_: DelayUpdate, next: DelayUpdate): DelayUpdate => next

const INITIAL_DELAY: DelayUpdate = { delay: -1, updatedAt: 0 }

export interface UseProxyDelayState {
  speedtestResult?: SavedSpeedtestResult
  delayState: DelayUpdate
  delayValue: number
  isPreset: boolean
  timeout: number
  onDelay: () => Promise<void>
}

export function useProxyDelayState(
  member: ResolvedProxyMember,
  groupName: string,
): UseProxyDelayState {
  const name = member.ref.name
  const profile = useSpeedtestProfile()
  const speedtestResult = useNodeSpeedtestResult(name, profile)
  const details = memberDetails(member)
  const unresolved = member.kind === 'unresolved'
  const isPreset = unresolved || PRESET_PROXY_NAMES.includes(name)
  const [delayState, setDelayState] = useReducer(identity, INITIAL_DELAY)
  const { verge } = useVerge()
  const timeout = verge?.default_latency_timeout || 10000

  useEffect(() => {
    if (isPreset) return
    delayManager.setListener(name, groupName, setDelayState)
    return () => {
      delayManager.removeListener(name, groupName)
    }
  }, [name, groupName, isPreset])

  const updateDelay = useCallback(() => {
    if (unresolved) {
      setDelayState(INITIAL_DELAY)
      return
    }
    const cachedUpdate = delayManager.getDelayUpdate(name, groupName)
    if (cachedUpdate) {
      setDelayState({ ...cachedUpdate })
      return
    }

    const fallbackDelay = delayManager.getDelayFix(member, groupName)
    if (fallbackDelay === -1) {
      setDelayState({ delay: -1, updatedAt: 0 })
      return
    }

    let updatedAt = 0
    const history = details?.history
    if (history && history.length > 0) {
      const lastRecord = history[history.length - 1]
      const parsed = Date.parse(lastRecord.time)
      if (!Number.isNaN(parsed)) {
        updatedAt = parsed
      }
    }

    setDelayState({ delay: fallbackDelay, updatedAt })
  }, [details?.history, groupName, member, name, unresolved])

  useEffect(() => {
    updateDelay()
  }, [updateDelay])

  const onDelay = useLockFn(async () => {
    if (!isInteractableMember(member)) return
    setDelayState({ delay: -2, updatedAt: Date.now() })
    const result = await delayManager.checkDelay(member, groupName, timeout)
    setDelayState(result)
    if (member.kind === 'node' && profile !== null) {
      const measured = result.delay > 0 && result.delay < timeout
      const saved = saveSpeedtestResult(
        profile,
        {
          node: name,
          delay: measured ? result.delay : null,
          delayError: measured ? null : 'Latency test failed or timed out',
          bytesPerSecond: null,
          bytes: 0,
          downloadError: null,
        },
        { latency: true, download: false },
        result.updatedAt,
      )
      if (!saved) showNotice.error('proxies.speedtest.saveFailed')
    }
  })

  return {
    speedtestResult,
    delayState,
    delayValue:
      delayState.delay !== -2 &&
      (speedtestResult?.delayTestedAt ?? 0) > delayState.updatedAt
        ? (speedtestResult?.delay ?? 100001)
        : delayState.delay,
    isPreset,
    timeout,
    onDelay,
  }
}
