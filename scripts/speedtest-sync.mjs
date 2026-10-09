import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

import { prepareOverlay } from './speedtest-overlay.mjs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const output = (key, value) =>
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
const summary = (text) =>
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
const metadata = JSON.parse(readFileSync('.github/speedtest-base.json', 'utf8'))
const response = await fetch(
  `https://api.github.com/repos/${metadata.upstream}/releases/latest`,
  {
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  },
)
if (!response.ok) throw new Error(`Release lookup failed: ${response.status}`)
const release = await response.json()
const tag = release.tag_name
if (!/^v\d+\.\d+\.\d+$/.test(tag) || release.prerelease || release.draft)
  throw new Error('Expected a stable release')
output('changed', 'false')
if (tag === metadata.tag) {
  summary(`Already based on ${tag}.`)
  process.exit(0)
}
const compare = (a, b) => {
  const left = a.slice(1).split('.').map(Number)
  const right = b.slice(1).split('.').map(Number)
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}
if (compare(tag, metadata.tag) <= 0)
  throw new Error('Refusing an upstream downgrade')
git(
  'fetch',
  '--no-tags',
  `https://github.com/${metadata.upstream}.git`,
  `refs/tags/${metadata.tag}`,
)
const previousUpstream = git('rev-parse', 'FETCH_HEAD^{commit}')
git(
  'fetch',
  '--no-tags',
  `https://github.com/${metadata.upstream}.git`,
  `refs/tags/${tag}`,
)
const upstream = git('rev-parse', 'FETCH_HEAD^{commit}')
const base = git('rev-parse', 'HEAD')
const branch = `speedtest-update/${tag}-${base.slice(0, 8)}`
output('base', base)
output('branch', branch)
const existing = git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`)
if (existing) {
  git('fetch', 'origin', `refs/heads/${branch}`)
  const candidate = git('rev-parse', 'FETCH_HEAD^{commit}')
  git('merge-base', '--is-ancestor', base, candidate)
  git('merge-base', '--is-ancestor', upstream, candidate)
  if (git('diff', '--name-only', base, candidate, '--', '.github/workflows'))
    throw new Error('Candidate workflow files differ from the stable branch')
  const candidateMetadata = JSON.parse(
    git('show', `${candidate}:.github/speedtest-base.json`),
  )
  if (candidateMetadata.tag !== tag)
    throw new Error('Candidate upstream version does not match the release')
  output('changed', 'true')
  output('ref', candidate)
  summary(
    `Reusing candidate ${branch}. Its checks and Windows build will run again before promotion.`,
  )
  process.exit(0)
}
git('switch', '-c', branch)
let overlay
try {
  overlay = prepareOverlay(previousUpstream, base, upstream)
} catch (error) {
  summary(
    `Upgrade to ${tag} needs an integration adjustment. The speedtest branch was not changed.\n\n${error.message}`,
  )
  throw error
}
git('config', 'user.name', 'github-actions[bot]')
git(
  'config',
  'user.email',
  '41898282+github-actions[bot]@users.noreply.github.com',
)
const merge = spawnSync('git', ['merge', '--no-commit', '--no-ff', upstream], {
  encoding: 'utf8',
})
const workflowChanges = git(
  'diff',
  '--name-only',
  base,
  upstream,
  '--',
  '.github/workflows',
)
const merging = spawnSync('git', ['rev-parse', '--verify', 'MERGE_HEAD'])
if (merge.status !== 0 && merging.status !== 0)
  throw new Error(`Upstream merge could not start: ${merge.stderr}`)
for (const [file, text] of overlay) writeFileSync(file, text)
git('add', '--', ...overlay.map(([file]) => file))
// GITHUB_TOKEN cannot push changed workflow files. Keep this fork's CI intact.
git(
  'restore',
  '--source',
  base,
  '--staged',
  '--worktree',
  '--',
  '.github/workflows',
)
if (workflowChanges)
  summary(
    `Retained this fork's workflows. Review upstream CI changes separately:\n\n\`\`\`\n${workflowChanges}\n\`\`\``,
  )
const conflicts = git('diff', '--name-only', '--diff-filter=U')
if (conflicts) {
  summary(
    `Upgrade to ${tag} needs attention. The speedtest branch was not changed.\n\nConflicting files:\n\n\`\`\`\n${conflicts}\n\`\`\``,
  )
  if (merging.status === 0) git('merge', '--abort')
  throw new Error(`Upstream merge failed: ${conflicts || merge.stderr}`)
}
writeFileSync(
  '.github/speedtest-base.json',
  `${JSON.stringify({ ...metadata, tag }, null, 2)}\n`,
)
git('add', '.github/speedtest-base.json')
git('commit', '-m', `chore(speedtest): merge upstream ${tag}`)
git('push', 'origin', `HEAD:refs/heads/${branch}`)
output('changed', 'true')
output('ref', git('rev-parse', 'HEAD'))
output('branch', branch)
summary(
  `Merged ${tag} and reapplied the speedtest integration to candidate ${branch}. The stable branch advances only after its checks and Windows build succeed.`,
)
