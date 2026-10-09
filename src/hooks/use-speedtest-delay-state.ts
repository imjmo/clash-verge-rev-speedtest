import { useLockFn } from 'ahooks'

import { useProxyDelayState } from '@/hooks/use-proxy-delay-state'
import {
  useNodeSpeedtestResult,
  useSpeedtestProfile,
} from '@/hooks/use-speedtest-results'
import delayManager from '@/services/delay'
import { showNotice } from '@/services/notice-service'
import { saveSpeedtestResult } from '@/services/speedtest-results'
import type { ResolvedProxyMember } from '@/types/proxy-view'

export function useSpeedtestDelayState(
  member: ResolvedProxyMember,
  groupName: string,
) {
  const state = useProxyDelayState(member, groupName)
  const profile = useSpeedtestProfile()
  const speedtestResult = useNodeSpeedtestResult(member.ref.name, profile)
  const onDelay = useLockFn(async () => {
    await state.onDelay()
    if (member.kind !== 'node' || state.isPreset || profile === null) return
    const result = delayManager.getDelayUpdate(member, groupName)
    if (!result || result.delay === -2) return
    const measured = result.delay > 0 && result.delay < state.timeout
    const saved = saveSpeedtestResult(
      profile,
      {
        node: member.ref.name,
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
  })

  return {
    ...state,
    speedtestResult,
    delayValue:
      state.delayValue !== -2 &&
      (speedtestResult?.delayTestedAt ?? 0) > state.delayState.updatedAt
        ? (speedtestResult?.delay ?? 100001)
        : state.delayValue,
    onDelay,
  }
}
