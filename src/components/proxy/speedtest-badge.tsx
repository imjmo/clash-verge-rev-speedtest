import { DownloadRounded } from '@mui/icons-material'
import { ButtonBase, CircularProgress, Tooltip } from '@mui/material'
import { useTranslation } from 'react-i18next'

import {
  useActiveSpeedtest,
  useSpeedtestProfile,
} from '@/hooks/use-speedtest-results'
import { showNotice } from '@/services/notice-service'
import {
  cancelSpeedtest,
  DEFAULT_SPEEDTEST_DOWNLOAD,
  runSpeedtest,
} from '@/services/speedtest'
import { saveSpeedtestResult } from '@/services/speedtest-results'
import type { SavedSpeedtestResult } from '@/services/speedtest-results'

export function SpeedtestBadge({
  result,
  node,
}: {
  result?: SavedSpeedtestResult
  node: string
}) {
  const { t } = useTranslation()
  const profile = useSpeedtestProfile()
  const active = useActiveSpeedtest()
  const running = active?.node === node && active.profile === profile
  const speed = result?.bytesPerSecond
  const test = async () => {
    if (profile === null) return
    try {
      if (running && active) {
        await cancelSpeedtest(active.id)
        return
      }
      await runSpeedtest(
        {
          id: crypto.randomUUID(),
          nodes: [node],
          latency: false,
          download: true,
          latencyUrl: 'https://www.gstatic.com/generate_204',
          downloadUrl: DEFAULT_SPEEDTEST_DOWNLOAD,
          seconds: 5,
          megabytes: 20,
        },
        (next) => {
          if (
            !saveSpeedtestResult(profile, next, {
              latency: false,
              download: true,
            })
          )
            showNotice.error('proxies.speedtest.saveFailed')
        },
        { profile, node },
      )
    } catch (error) {
      showNotice.error('proxies.speedtest.downloadFailed', error)
    }
  }
  return (
    <Tooltip
      title={`${t(running ? 'proxies.speedtest.stopDownload' : 'proxies.speedtest.downloadOneHint')}${result?.downloadTestedAt ? ` · ${new Date(result.downloadTestedAt).toLocaleString()}` : ''}${result?.downloadError ? ` · ${result.downloadError}` : ''}`}
    >
      <ButtonBase
        aria-label={t(
          running
            ? 'proxies.speedtest.stopDownload'
            : 'proxies.speedtest.downloadOne',
          { node },
        )}
        disabled={profile === null || (!!active && !running)}
        onClick={(event) => {
          event.stopPropagation()
          void test()
        }}
        sx={{
          px: 0.5,
          fontSize: 12,
          borderRadius: 1,
          gap: 0.25,
          minHeight: 28,
          color: speed != null ? 'success.main' : 'text.secondary',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {running ? (
          <CircularProgress size={12} color="inherit" />
        ) : (
          <DownloadRounded sx={{ fontSize: 15 }} />
        )}
        {result?.downloadTestedAt &&
          (speed != null
            ? `${(speed / 1024 / 1024).toFixed(1)} MiB/s`
            : t('proxies.speedtest.failed'))}
      </ButtonBase>
    </Tooltip>
  )
}
