import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { applyIntegration, integrations } from './speedtest-overlay.mjs'

const syncScript = resolve('scripts/speedtest-sync.mjs')
const promoteScript = resolve('scripts/speedtest-promote.mjs')
const headFile = 'src/components/proxy/proxy-head.tsx'
const originals = Object.fromEntries(
  Object.entries(integrations).map(([file, edits]) => {
    let text = readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
    for (const [anchor, replacement] of [...edits].reverse()) {
      assert.equal(text.split(replacement).length, 2, file)
      text = text.replace(replacement, anchor)
    }
    return [file, text]
  }),
)

test('overlay rejects missing or ambiguous insertion points', () => {
  assert.throws(
    () => applyIntegration(headFile, ''),
    /integration point changed/,
  )
  assert.throws(
    () => applyIntegration(headFile, originals[headFile].repeat(2)),
    /integration point changed/,
  )
})

for (const scenario of [
  'compatible',
  'conflict',
  'unmanaged',
  'moved-anchor',
  'stable-moved',
  'candidate-moved',
]) {
  test(`upstream update: ${scenario}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'cvr-speedtest-sync-'))
    t.after(() => {
      assert.equal(dirname(root), resolve(tmpdir()))
      assert.ok(root.startsWith(join(resolve(tmpdir()), 'cvr-speedtest-sync-')))
      rmSync(root, { recursive: true, force: true })
    })
    const dir = join(root, 'checkout')
    mkdirSync(dir)
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HUSKY: '0' },
      }).trim()
    const put = (file, text) => {
      const path = join(dir, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    const commit = (message) => {
      git('add', '.')
      git('commit', '-m', message)
    }
    git('init', '-b', 'speedtest')
    git('config', 'user.name', 'Speedtest fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'core.autocrlf', 'false')
    for (const [file, text] of Object.entries(originals)) put(file, text)
    put('app.txt', 'original\n')
    put('.github/workflows/build.yml', 'upstream original\n')
    commit('original upstream')
    git('tag', 'v9.0.0')
    git('switch', '-c', 'upstream')
    put(
      headFile,
      originals[headFile]
        .replace(
          'import type { ProxySortType }',
          "import { NewUpstreamControl } from './new-upstream-control'\nimport type { ProxySortType }",
        )
        .replace(
          'gap: 0.5',
          scenario === 'moved-anchor' ? 'gap: 1' : 'gap: 0.5',
        ),
    )
    put('.github/workflows/build.yml', 'upstream new\n')
    put('.github/workflows/new.yml', 'upstream new workflow\n')
    put('app.txt', 'new upstream\n')
    commit('next upstream')
    git('tag', 'v9.0.1')
    git('switch', 'speedtest')
    for (const [file, text] of Object.entries(originals))
      put(file, applyIntegration(file, text))
    if (scenario === 'unmanaged')
      put(
        headFile,
        `${applyIntegration(headFile, originals[headFile])}\n// Another fork edit\n`,
      )
    if (scenario === 'conflict') put('app.txt', 'fork edit\n')
    put('.github/workflows/build.yml', 'fork workflow\n')
    put(
      '.github/speedtest-base.json',
      JSON.stringify({ upstream: 'fixture/upstream', tag: 'v9.0.0' }),
    )
    commit('speedtest integration')
    const base = git('rev-parse', 'HEAD')
    const remote = join(root, 'origin.git')
    git('clone', '--bare', dir, remote)
    git('remote', 'add', 'origin', remote)
    git(
      'config',
      `url.${remote.replaceAll('\\', '/')}.insteadOf`,
      'https://github.com/fixture/upstream.git',
    )
    const mock = join(root, 'release.mjs')
    writeFileSync(
      mock,
      "globalThis.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v9.0.1' }) })",
    )
    const output = join(root, 'output.txt')
    const env = {
      ...process.env,
      HUSKY: '0',
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(root, 'summary.txt'),
    }
    const run = (script, args = [], extra = {}) =>
      spawnSync(process.execPath, [...args, script], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...env, ...extra },
      })
    const result = run(syncScript, ['--import', pathToFileURL(mock).href])
    const stable = () =>
      git('ls-remote', 'origin', 'refs/heads/speedtest').split(/\s/)[0]
    assert.equal(stable(), base)
    if (['conflict', 'unmanaged', 'moved-anchor'].includes(scenario)) {
      assert.notEqual(result.status, 0)
      assert.match(
        result.stderr,
        scenario === 'conflict' ? /app.txt/ : /integration/,
      )
      assert.equal(
        git('ls-remote', 'origin', 'refs/heads/speedtest-update/*'),
        '',
      )
      return
    }
    assert.equal(result.status, 0, result.stderr)
    const outputs = () =>
      Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split('=')),
      )
    const candidate = outputs()
    assert.equal(candidate.changed, 'true')
    assert.equal(git('diff', base, 'HEAD', '--', '.github/workflows'), '')
    assert.match(git('show', `HEAD:${headFile}`), /NewUpstreamControl/)
    assert.match(git('show', `HEAD:${headFile}`), /<SpeedTestButton/)
    git('switch', 'speedtest')
    writeFileSync(output, '')
    const retry = run(syncScript, ['--import', pathToFileURL(mock).href])
    assert.equal(retry.status, 0, retry.stderr)
    assert.deepEqual(outputs(), candidate)
    if (scenario !== 'compatible') {
      if (scenario === 'candidate-moved') git('switch', candidate.branch)
      put('unrelated.txt', 'concurrent edit\n')
      commit('concurrent edit')
      git(
        'push',
        'origin',
        scenario === 'stable-moved' ? 'speedtest' : candidate.branch,
      )
    }
    const beforePromotion = stable()
    const promoted = run(promoteScript, [], {
      SPEEDTEST_BASE: base,
      SPEEDTEST_REF: candidate.ref,
      SPEEDTEST_BRANCH: candidate.branch,
    })
    if (scenario === 'compatible') {
      assert.equal(promoted.status, 0, promoted.stderr)
      assert.equal(stable(), candidate.ref)
    } else {
      assert.notEqual(promoted.status, 0)
      assert.match(promoted.stderr, /changed during the build/)
      assert.equal(stable(), beforePromotion)
    }
  })
}
