import { invoke } from '@tauri-apps/api/core'
import type { Channel } from '@tauri-apps/api/core'

import type {
  SpeedtestOptions,
  SpeedtestProgress,
  SpeedtestResult,
} from './speedtest'

// The fork's commands are separate from upstream's generated bindings.
export function invokeSpeedtest(args: {
  options: SpeedtestOptions
  onResult: Channel<SpeedtestResult>
  onProgress: Channel<SpeedtestProgress>
}) {
  return invoke<void>('run_speedtest', args)
}

export function cancelSpeedtestCommand(id: string) {
  return invoke<void>('cancel_speedtest', { id })
}
