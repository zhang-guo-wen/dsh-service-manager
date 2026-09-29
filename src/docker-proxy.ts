import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, renameSync, chmodSync, rmSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { delimiter, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { OWNER_ENV } from './ownership.ts'

// A per-invocation local Docker socket annotates container-create requests,
// including Compose. It never changes Compose files/config hashes or stops resources.
const args = process.argv.slice(2)
const directory = process.env.DSH_SERVICE_CAPTURE_DIR
const marker = process.env[OWNER_ENV]
const key = process.env.DSH_SERVICE_REGISTRY_KEY
const shim = process.env.DSH_SERVICE_SHIM
const candidates = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(path => resolve(path).toLowerCase() !== shim?.toLowerCase())
const docker = candidates.map(path => join(path, process.platform === 'win32' ? 'docker.exe' : 'docker')).find(existsSync)
if (!docker) { console.error('Docker executable not found on the original PATH'); process.exit(127) }
const valued = new Set(['--config', '--context', '-c', '--host', '-H', '--log-level', '-l', '--tlscacert', '--tlscert', '--tlskey'])
let index = 0
while (index < args.length && args[index]!.startsWith('-')) { const option = args[index++]!; if (valued.has(option)) index++ }
const globals = args.slice(0, index)
let verb = index
if (args[verb] === 'container') verb++
let creationCommand = args[verb] === 'run' || args[verb] === 'create'
if (args[index] === 'compose') {
  verb = index + 1
  const optionsWithValue = new Set(['-f', '--file', '-p', '--project-name', '--profile', '--project-directory', '--env-file', '--parallel', '--progress', '--ansi'])
  while (args[verb]?.startsWith('-')) { const option = args[verb++]!; if (optionsWithValue.has(option)) verb++ }
  creationCommand = ['up', 'run', 'create'].includes(args[verb] ?? '')
}
const explicitHost = globals.some(value => value === '-H' || value.startsWith('--host') || value.startsWith('-H=')) || Boolean(process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT && !globals.some(value => value === '-c' || value.startsWith('--context')))
let cleanup = () => {}
let env = process.env
let forwarded = args

const customConfig = globals.some(value => value === '--config' || value.startsWith('--config='))
if (creationCommand && directory && marker && key && !explicitHost && !customConfig) {
  try {
    const invoke = (tail: string[]) => execFileSync(docker, [...globals, ...tail], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).trim()
    const context = invoke(['context', 'show'])
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(context)) throw new Error('Invalid Docker context')
    const endpoint = JSON.parse(invoke(['context', 'inspect', context, '--format', '{{json .Endpoints.docker}}'])) as { Host: string }
    let socketPath: string
    if (endpoint.Host.startsWith('npipe://')) socketPath = endpoint.Host.slice('npipe://'.length).replaceAll('/', '\\')
    else if (endpoint.Host.startsWith('unix://')) socketPath = endpoint.Host.slice('unix://'.length)
    else throw new Error('Automatic Docker attribution requires a local named pipe or Unix socket')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const target = join(directory, `${Buffer.from(context).toString('base64url')}.json`)
    const temporary = `${target}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ context }), { mode: 0o600 })
    renameSync(temporary, target)
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\dsh-services-${randomUUID()}` : join(directory, `docker-${randomUUID()}.sock`)
    const server = createServer((incoming, outgoing) => {
      const creation = incoming.method === 'POST' && /^\/(?:v[\d.]+\/)?containers\/create(?:\?|$)/.test(incoming.url ?? '')
      const forward = (body?: Buffer) => {
        const headers = { ...incoming.headers }
        if (body) { headers['content-length'] = String(body.length); delete headers['transfer-encoding'] }
        const upstream = request({ socketPath, method: incoming.method, path: incoming.url, headers }, response => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers)
          response.pipe(outgoing)
        })
        upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end('Docker connection failed') })
        outgoing.on('close', () => upstream.destroy())
        if (body) upstream.end(body)
        else incoming.pipe(upstream)
      }
      if (!creation) { forward(); return }
      const chunks: Buffer[] = []
      let bytes = 0
      incoming.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 8 * 1024 * 1024) { outgoing.writeHead(413); outgoing.end(); incoming.destroy(); return }
        chunks.push(chunk)
      })
      incoming.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { Labels?: Record<string, string> }
          body.Labels = { ...body.Labels, 'io.dsh.service-manager.registry': key, 'io.dsh.service-manager.owner': marker }
          forward(Buffer.from(JSON.stringify(body)))
        } catch { outgoing.writeHead(400); outgoing.end('Invalid container creation payload') }
      })
    })
    const sockets = new Set<Socket>()
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    // Preserve Docker attach/exec hijacked connections without interpreting their bytes.
    server.on('upgrade', (incoming, downstream, head) => {
      const upstream = connect(socketPath, () => {
        const lines = [`${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}`]
        for (let n = 0; n < incoming.rawHeaders.length; n += 2) lines.push(`${incoming.rawHeaders[n]}: ${incoming.rawHeaders[n + 1]}`)
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (head.length) upstream.write(head)
        downstream.pipe(upstream).pipe(downstream)
      })
      sockets.add(upstream)
      upstream.on('close', () => sockets.delete(upstream))
      upstream.on('error', () => downstream.destroy())
      downstream.on('error', () => upstream.destroy())
      downstream.on('close', () => upstream.destroy())
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve) })
    if (process.platform !== 'win32') chmodSync(pipe, 0o600)
    cleanup = () => { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); server.close(); if (process.platform !== 'win32') rmSync(pipe, { force: true }) }
    // Context flags override DOCKER_HOST, so remove only that routing choice.
    const options: string[] = []
    for (let n = 0; n < globals.length; n++) {
      if (globals[n] === '--context' || globals[n] === '-c') { n++; continue }
      if (globals[n]!.startsWith('--context=') || /^-c.+/.test(globals[n]!)) continue
      options.push(globals[n]!)
    }
    forwarded = [...options, ...args.slice(index)]
    env = { ...process.env, DOCKER_CONTEXT: '', DOCKER_HOST: process.platform === 'win32' ? `npipe://${pipe.replaceAll('\\', '/')}` : `unix://${pipe}`, DOCKER_TLS_VERIFY: '', DOCKER_CERT_PATH: '' }
  } catch (error) { console.error(`Service tracking unavailable: ${(error as Error).message}`) }
}
const child = spawn(docker, forwarded, { env, stdio: 'inherit', windowsHide: true, shell: false })
child.on('error', error => { console.error(error.message); process.exitCode = 127; cleanup() })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1); cleanup() })
