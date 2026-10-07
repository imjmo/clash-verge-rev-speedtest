import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

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
  `refs/tags/${tag}`,
)
const upstream = git('rev-parse', 'FETCH_HEAD^{commit}')
const base = git('rev-parse', 'HEAD')
const branch = `speedtest-update/${tag}-${base.slice(0, 8)}`
const existing = git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`)
if (existing) {
  summary(
    `Candidate already exists: ${branch}. Inspect or rerun its Windows build.`,
  )
  process.exit(0)
}
git('switch', '-c', branch)
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
const merging = spawnSync('git', ['rev-parse', '--verify', 'MERGE_HEAD'])
if (conflicts || (merge.status !== 0 && merging.status !== 0)) {
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
  `Merged ${tag} into candidate branch ${branch}. The Windows build runs next. The stable speedtest branch remains unchanged until the candidate is verified and merged.`,
)
