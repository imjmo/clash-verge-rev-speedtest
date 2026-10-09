import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const {
  SPEEDTEST_BASE: base,
  SPEEDTEST_REF: candidate,
  SPEEDTEST_BRANCH: branch,
} = process.env
if (
  !/^[a-f0-9]{40}$/.test(base ?? '') ||
  !/^[a-f0-9]{40}$/.test(candidate ?? '') ||
  !/^speedtest-update\/v\d+\.\d+\.\d+-[a-f0-9]{8}$/.test(branch ?? '')
)
  throw new Error('Missing or invalid tested candidate identity')

git('fetch', 'origin', 'refs/heads/speedtest')
const stable = git('rev-parse', 'FETCH_HEAD^{commit}')
if (stable !== base)
  throw new Error(
    'The stable branch changed during the build; run upstream update again',
  )
git('fetch', 'origin', `refs/heads/${branch}`)
if (git('rev-parse', 'FETCH_HEAD^{commit}') !== candidate)
  throw new Error(
    'The candidate changed during the build; run upstream update again',
  )
git('merge-base', '--is-ancestor', base, candidate)
if (git('diff', '--name-only', base, candidate, '--', '.github/workflows'))
  throw new Error('Refusing to promote changed workflow files')
git('push', 'origin', `${candidate}:refs/heads/speedtest`)
appendFileSync(
  process.env.GITHUB_STEP_SUMMARY,
  `Promoted tested candidate ${candidate} to speedtest. Download the Windows installer from this run. No software was installed on your computer.\n`,
)
