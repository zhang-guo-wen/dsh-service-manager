import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import { prepareDockerShim, installDockerDiscovery } from '../src/docker-discovery.ts'
import { AutomaticServices } from '../src/automatic.ts'
import { RegistryStore } from '../src/store.ts'
import { encodeOwner } from '../src/ownership.ts'
import { powershell } from '../src/command.ts'

const exec = promisify(execFile)
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

describe('Docker attribution bridge', () => {
  it('recovers only marked container IDs from persisted contexts after a launcher exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docker-recover-'))
    dirs.push(dir)
    await mkdir(join(dir, 'docker-contexts'))
    await writeFile(join(dir, 'docker-contexts', 'context.json'), JSON.stringify({ context: 'desktop-test' }))
    const store = new RegistryStore(join(dir, 'services.json'))
    const automatic = new AutomaticServices(store, () => undefined, async () => [])
    const marker = encodeOwner(automatic.key, { project: 'demo', session: 'session-a', call: 'command' })
    const id = 'a'.repeat(64)
    const ctx = new Context()
    try {
      installDockerDiscovery(ctx, automatic, async (_file, args) => args.includes('ps') ? id : JSON.stringify([
        { Id: id, Name: '/redis', Config: { Labels: { 'io.dsh.service-manager.owner': marker } } },
        { Id: 'b'.repeat(64), Name: '/unrelated', Config: { Labels: {} } },
      ]))
      await automatic.refresh()
      await automatic.refresh()
      expect(await store.read()).toMatchObject([{ kind: 'container', containerId: id, context: 'desktop-test', project: 'demo', session: 'session-a' }])
    } finally { await ctx.fiber.dispose() }
  })
  it.runIf(process.platform === 'win32')('preserves argv and Compose labels while annotating only container creation over a local pipe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docker-capture-'))
    dirs.push(dir)
    const launcher = await prepareDockerShim(dir, new URL('../lib/', import.meta.url))
    const fakeDir = join(dir, 'real')
    await mkdir(fakeDir)
    const source = (await readFile(new URL('../src/docker-launcher.cs', import.meta.url), 'utf8')).replace('DSH_SERVICE_DOCKER_PROXY', 'FAKE_DOCKER_SCRIPT')
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
    await powershell(`Add-Type -TypeDefinition ${quote(source)} -OutputAssembly ${quote(join(fakeDir, 'docker.exe'))} -OutputType ConsoleApplication`)
    const fakeScript = join(dir, 'fake-docker.mjs')
    await writeFile(fakeScript, `
import {writeFileSync} from 'node:fs'
import {request} from 'node:http'
const args=process.argv.slice(2)
if(args.includes('context')) {
 if(args.includes('show')) console.log('desktop-test')
 else console.log(JSON.stringify({Host:process.env.FAKE_ENDPOINT}))
} else {
 writeFileSync(process.env.FAKE_ARGS, JSON.stringify(args))
 const pipe=process.env.DOCKER_HOST.slice('npipe://'.length).replaceAll('/', String.fromCharCode(92))
 const body=JSON.stringify({Image:'test',Labels:{'com.docker.compose.config-hash':'unchanged'}})
 const req=request({socketPath:pipe,path:'/v1.47/containers/create?name=test',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{res.pipe(process.stdout);res.on('end',()=>{process.exitCode=17})})
 req.on('error',error=>{console.error(error);process.exitCode=2})
 req.end(body)
}
`)
    const pipe = `\\\\.\\pipe\\fake-docker-${randomUUID()}`
    const requests: { url: string; body: any }[] = []
    const server = createServer((req, res) => {
      let text = ''
      req.on('data', chunk => { text += chunk })
      req.on('end', () => { requests.push({ url: req.url!, body: JSON.parse(text) }); res.end('container-created') })
    })
    await new Promise<void>(resolve => server.listen(pipe, resolve))
    const args = ['--context', 'desktop-test', 'compose', 'up', '-d', 'a & b', 'quote" slash\\', '%PATH%', '']
    const owner = encodeOwner('registry-key', { project: 'workspace', session: 'session', call: 'call' })
    try {
      const result = await exec(join(launcher.shim, 'docker.exe'), args, { windowsHide: true, timeout: 15_000, env: { ...process.env, PATH: [launcher.shim, fakeDir, process.env.PATH].join(delimiter), DSH_SERVICE_NODE: process.execPath, DSH_SERVICE_DOCKER_PROXY: launcher.proxy, DSH_SERVICE_SHIM: launcher.shim, DSH_SERVICE_CAPTURE_DIR: join(dir, 'contexts'), DSH_SERVICE_REGISTRY_KEY: 'registry-key', DSH_SERVICE_OWNER: owner, FAKE_DOCKER_SCRIPT: fakeScript, FAKE_ARGS: join(dir, 'args.json'), FAKE_ENDPOINT: `npipe://${pipe.replaceAll('\\', '/')}`, DOCKER_HOST: '', DOCKER_CONTEXT: '' } }).catch(error => error)
      expect(result.code).toBe(17)
      expect(result.stderr).toBe('')
      expect(result.stdout).toBe('container-created')
      expect(result.stderr).toBe('')
      expect(JSON.parse(await readFile(join(dir, 'args.json'), 'utf8'))).toEqual(args.slice(2))
      expect(requests).toEqual([{ url: '/v1.47/containers/create?name=test', body: { Image: 'test', Labels: { 'com.docker.compose.config-hash': 'unchanged', 'io.dsh.service-manager.registry': 'registry-key', 'io.dsh.service-manager.owner': owner } } }])
      expect(JSON.parse(await readFile(join(dir, 'contexts', `${Buffer.from('desktop-test').toString('base64url')}.json`), 'utf8'))).toEqual({ context: 'desktop-test' })
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }, 25_000)

  it('restores the host executor when the plugin unloads and leaves ordinary commands untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docker-hooks-'))
    dirs.push(dir)
    const ctx = new Context()
    const calls: unknown[] = []
    class LocalBashExecutor extends Service {
      constructor(ctx: Context) { super(ctx, 'shell') }
      async execute(spec: unknown) { calls.push(spec); return { status: 'running' } }
    }
    const shell = new LocalBashExecutor(ctx)
    try {
      const fiber = ctx.plugin((child: Context) => { installDockerDiscovery(child, new AutomaticServices(new RegistryStore(join(dir, 'services.json')), () => undefined, async () => [])) })
      await fiber
      await new Promise(resolve => setTimeout(resolve, 0))
      const spec = { command: 'echo hello' }
      await ctx.get('shell').execute(spec)
      expect(calls).toEqual([spec])
      await fiber.dispose()
      expect(Object.hasOwn(shell, 'execute')).toBe(false)
      expect(shell.execute).toBe(LocalBashExecutor.prototype.execute)
    } finally { await ctx.fiber.dispose() }
  })
})
