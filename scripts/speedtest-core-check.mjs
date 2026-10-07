import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const binary = process.argv[2]
if (!binary) throw new Error('Pass the mihomo executable path')
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  )
const close = (server) => new Promise((resolve) => server.close(resolve))
const freePort = async () => {
  const server = net.createServer()
  const port = await listen(server)
  await close(server)
  return port
}
const directory = await mkdtemp(path.join(tmpdir(), 'cvr-speedtest-check-'))
const alpha = http.createServer((_, response) => response.end('node-alpha'))
const beta = http.createServer((_, response) => response.end('node-beta'))
for (const server of [alpha, beta]) {
  server.on('connect', (_, socket, head) => {
    const target = net.connect(server.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) target.write(head)
      socket.pipe(target).pipe(socket)
    })
    target.on('error', () => socket.destroy())
    socket.on('error', () => target.destroy())
    socket.on('close', () => target.destroy())
  })
}
let child
try {
  const alphaPort = await listen(alpha)
  const betaPort = await listen(beta)
  const port = await freePort()
  let controller = await freePort()
  while (controller === port) controller = await freePort()
  const secret = 'local-verification-only'
  const group = '__CVR_SPEEDTEST__'
  await writeFile(
    path.join(directory, 'provider.yaml'),
    JSON.stringify({
      proxies: [
        { name: 'beta', type: 'http', server: '127.0.0.1', port: betaPort },
      ],
    }),
  )
  await writeFile(
    path.join(directory, 'config.yaml'),
    JSON.stringify({
      mode: 'rule',
      'log-level': 'silent',
      'external-controller': `127.0.0.1:${controller}`,
      secret,
      proxies: [
        { name: 'alpha', type: 'http', server: '127.0.0.1', port: alphaPort },
      ],
      'proxy-providers': {
        fixture: {
          type: 'file',
          path: 'provider.yaml',
          'health-check': { enable: false },
        },
      },
      'proxy-groups': [{ name: group, type: 'select', 'include-all': true }],
      listeners: [
        {
          name: 'speedtest',
          type: 'mixed',
          listen: '127.0.0.1',
          port,
          proxy: group,
          users: [{ username: 'speedtest', password: secret }],
        },
      ],
      rules: ['MATCH,REJECT'],
      profile: { 'store-selected': false },
    }),
  )
  child = spawn(
    path.resolve(binary),
    ['-d', directory, '-f', path.join(directory, 'config.yaml')],
    { windowsHide: true, stdio: 'ignore' },
  )
  const api = (route, method = 'GET', body) =>
    new Promise((resolve, reject) => {
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port: controller,
          path: route,
          method,
          headers: {
            Authorization: `Bearer ${secret}`,
            'Content-Type': 'application/json',
          },
        },
        (response) => {
          let data = ''
          response.on('data', (chunk) => {
            data += chunk
          })
          response.on('end', () =>
            resolve({ status: response.statusCode, data }),
          )
        },
      )
      request.on('error', reject)
      request.end(body && JSON.stringify(body))
    })
  for (let i = 0; ; i++) {
    try {
      const reply = await api(`/proxies/${group}`)
      if (reply.status === 200 && JSON.parse(reply.data).all.includes('beta'))
        break
    } catch {}
    if (i === 100 || child.exitCode !== null)
      throw new Error('Isolated core did not become ready')
    await sleep(100)
  }
  const throughProxy = () =>
    new Promise((resolve, reject) => {
      const request = http.get(
        {
          hostname: '127.0.0.1',
          port,
          path: 'http://127.0.0.1:1/speedtest',
          headers: {
            'Proxy-Authorization': `Basic ${Buffer.from(`speedtest:${secret}`).toString('base64')}`,
          },
        },
        (response) => {
          let data = ''
          response.on('data', (chunk) => {
            data += chunk
          })
          response.on('end', () => resolve(data))
        },
      )
      request.setTimeout(3000, () =>
        request.destroy(new Error('Proxy request timed out')),
      )
      request.on('error', reject)
    })
  assert.equal(
    (await api(`/proxies/${group}`, 'PUT', { name: 'alpha' })).status,
    204,
  )
  assert.equal(await throughProxy(), 'node-alpha')
  assert.equal(
    (await api(`/proxies/${group}`, 'PUT', { name: 'beta' })).status,
    204,
  )
  assert.equal(await throughProxy(), 'node-beta')
  assert.notEqual(
    (await api(`/proxies/${group}`, 'PUT', { name: 'missing' })).status,
    204,
  )
  console.log(
    'Verified explicit node routing, provider nodes, and rejection of missing nodes against the real core.',
  )
} finally {
  if (child && child.exitCode === null) {
    await new Promise((resolve) => {
      child.once('exit', resolve)
      child.kill()
    })
  }
  await close(alpha)
  await close(beta)
  await rm(directory, { recursive: true, force: true })
}
