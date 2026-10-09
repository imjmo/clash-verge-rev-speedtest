import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Each anchor must occur exactly once. Never replace a whole upstream file with an older copy.
export const integrations = {
  'src/components/proxy/proxy-head.tsx': [
    [
      "import type { ProxySortType } from './use-filter-sort'",
      "import { SpeedTestButton } from './speedtest-dialog'\nimport type { ProxySortType } from './use-filter-sort'",
    ],
    [
      "    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ...sx }}>\n",
      "    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ...sx }}>\n      <SpeedTestButton groupName={groupName} />\n",
    ],
  ],
  'src/components/proxy/proxy-group-tools.tsx': [
    [
      "import type { ProxySortType } from './use-filter-sort'",
      "import { SpeedTestButton } from './speedtest-dialog'\nimport type { ProxySortType } from './use-filter-sort'",
    ],
    [
      "      {side === 'right' && textInput}\n",
      "      {side === 'right' && textInput}\n      <SpeedTestButton groupName={groupName} />\n",
    ],
  ],
  'src/pages/unlock.tsx': [
    [
      "import { BaseEmpty, BasePage } from '@/components/base'\n",
      "import { BaseEmpty, BasePage } from '@/components/base'\nimport { SpeedTestButton } from '@/components/proxy/speedtest-dialog'\n",
    ],
    [
      "        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>\n",
      "        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>\n          <SpeedTestButton full />\n",
    ],
  ],
  'src-tauri/src/core/updater.rs': [
    [
      '    pub async fn try_install_on_startup(&self, app_handle: &tauri::AppHandle) -> bool {\n',
      '    pub async fn try_install_on_startup(&self, app_handle: &tauri::AppHandle) -> bool {\n        if option_env!("CVR_SPEEDTEST_BUILD") == Some("1") {\n            return false;\n        }\n',
    ],
    [
      '    async fn check_and_download(&self, app_handle: &tauri::AppHandle) -> Result<()> {\n',
      '    async fn check_and_download(&self, app_handle: &tauri::AppHandle) -> Result<()> {\n        if option_env!("CVR_SPEEDTEST_BUILD") == Some("1") {\n            return Ok(());\n        }\n',
    ],
    [
      '    async fn check(app_handle: &tauri::AppHandle) -> Result<Option<Update>> {\n',
      '    async fn check(app_handle: &tauri::AppHandle) -> Result<Option<Update>> {\n        if option_env!("CVR_SPEEDTEST_BUILD") == Some("1") {\n            return Ok(None);\n        }\n',
    ],
  ],
  'src/services/update.ts': [
    [
      '): Promise<Update | null> => {\n',
      "): Promise<Update | null> => {\n  if (import.meta.env.VITE_SPEEDTEST_BUILD === 'true') return null\n",
    ],
  ],
  'src-tauri/src/cmd/mod.rs': [
    ['pub mod service;\n', 'pub mod service;\npub mod speedtest;\n'],
  ],
  'src-tauri/src/lib.rs': [
    [
      '            cmd::change_clash_core,\n',
      '            cmd::change_clash_core,\n            cmd::speedtest::run_speedtest,\n            cmd::speedtest::cancel_speedtest,\n',
    ],
  ],
}

const overlayFiles = Object.keys(integrations)
const normalize = (text) => text.replaceAll('\r\n', '\n')
const source = (ref, file) =>
  normalize(
    execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8' }),
  )

export function applyIntegration(file, text) {
  let result = normalize(text)
  for (const [anchor, replacement] of integrations[file]) {
    if (result.split(anchor).length !== 2 || result.includes(replacement))
      throw new Error(`Speedtest integration point changed: ${file}\n${anchor}`)
    result = result.replace(anchor, replacement)
  }
  return result
}

export function prepareOverlay(previousUpstream, current, nextUpstream) {
  return overlayFiles.map((file) => {
    if (
      source(current, file) !==
      applyIntegration(file, source(previousUpstream, file))
    )
      throw new Error(`Unmanaged changes in speedtest integration: ${file}`)
    return [file, applyIntegration(file, source(nextUpstream, file))]
  })
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [mode, upstream] = process.argv.slice(2)
  if (!['--check', '--apply'].includes(mode) || !upstream)
    throw new Error(
      'Usage: node scripts/speedtest-overlay.mjs --check|--apply <upstream-ref>',
    )
  const files = overlayFiles.map((file) => [
    file,
    applyIntegration(file, source(upstream, file)),
  ])
  for (const [file, text] of files) {
    if (mode === '--apply') writeFileSync(file, text)
    else if (normalize(readFileSync(file, 'utf8')) !== text)
      throw new Error(`Integration differs from the speedtest overlay: ${file}`)
  }
  console.log(
    `Speedtest overlay ${mode.slice(2)}: ${files.length} integration files.`,
  )
}
