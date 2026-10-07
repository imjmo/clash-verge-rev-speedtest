import { useCallback, useSyncExternalStore } from 'react'

import { useProfiles } from '@/hooks/use-profiles'
import {
  getActiveSpeedtest,
  subscribeActiveSpeedtest,
} from '@/services/speedtest'
import {
  getSpeedtestResults,
  subscribeSpeedtestResults,
} from '@/services/speedtest-results'

export function useSpeedtestProfile() {
  const { profiles } = useProfiles()
  return profiles ? (profiles.current ?? '__default__') : null
}

export function useActiveSpeedtest() {
  return useSyncExternalStore(subscribeActiveSpeedtest, getActiveSpeedtest)
}

export function useSpeedtestResults(profile: string | null) {
  return useSyncExternalStore(
    subscribeSpeedtestResults,
    useCallback(() => getSpeedtestResults(profile), [profile]),
  )
}

export function useNodeSpeedtestResult(name: string, profile: string | null) {
  return useSyncExternalStore(
    subscribeSpeedtestResults,
    useCallback(() => getSpeedtestResults(profile)[name], [profile, name]),
  )
}
