import { readFile, readdir, mkdir, writeFile, chmod, rename, access, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { powershell, run, type Runner } from './command.ts'
import { decodeOwner } from './ownership.ts'
import { hostService } from './automatic.ts'
import type { AutomaticServices } from './automatic.ts'

interface ShellSpec { env?: Record<string, string>; dshEnv?: Record<string, string>; sandboxPolicy?: { mode: string } }
interface Shell { execute(spec: ShellSpec): Promise<unknown> }
const quote = (text: string) => `'${text.replaceAll("'", "''")}'`

export async function prepareDockerShim(root: string, assets = new URL('./', import.meta.url)): Promise<{ shim: string; proxy: string }> {
  const proxy = fileURLToPath(new URL('docker-proxy.mjs', assets))
  const source = await readFile(new URL('docker-launcher.cs', assets), 'utf8')
  const version = createHash('sha256').update(source).update(proxy).digest('hex').slice(0, 12)
  const shim = join(root, 'docker-shim', version)
  await mkdir(shim, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') {
    const target = join(shim, 'docker.exe')
    try { await readFile(target) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const temporary = join(shim, `docker-${randomUUID()}.exe`)
      await powershell(`Add-Type -TypeDefinition ${quote(source)} -OutputAssembly ${quote(temporary)} -OutputType ConsoleApplication`)
      await rename(temporary, target).catch(async error => {
        // Another profile can finish this exact launcher build first.
        try { await access(target) } catch { throw error }
        await rm(temporary, { force: true })
      })
    }
  } else {
    const target = join(shim, 'docker')
    await writeFile(target, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(proxy)} "$@"\n`, { mode: 0o700 })
    await chmod(target, 0o700)
  }
  return { shim, proxy }
}

export function installDockerDiscovery(ctx: Context, automatic: AutomaticServices, runner: Runner = run): void {
  const root = dirname(automatic.store.file)
  const captures = join(root, 'docker-contexts')
  let ready: ReturnType<typeof prepareDockerShim> | undefined
  ctx.inject(['shell'], child => {
    const shell = hostService<Shell>(child, 'shell')!
    const previous = Object.getOwnPropertyDescriptor(shell, 'execute')
    const original = shell.execute
    const wrapped: Shell['execute'] = async function (this: Shell, spec) {
      if (!spec.dshEnv?.DSH_SERVICE_OWNER) return original.call(this, spec)
      // Never substitute local PATHs into remote executors or widen a confined run.
      const local = function (executor: object): boolean {
        for (let prototype: object | null = executor; prototype; prototype = Object.getPrototypeOf(prototype) as object | null) {
          if (['LocalBashExecutor', 'PwshLocalExecutor'].includes(prototype.constructor.name)) return true
        }
        return false
      }
      if (!local(this) || spec.sandboxPolicy && spec.sandboxPolicy.mode !== 'danger-full-access') return original.call(this, spec)
      const env = { ...spec.env }
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
      const originalPath = env[pathKey] ?? process.env.PATH ?? process.env.Path ?? ''
      const available = await Promise.all(originalPath.split(delimiter).map(async path => {
        try { await access(join(path, process.platform === 'win32' ? 'docker.exe' : 'docker')); return true } catch { return false }
      }))
      if (!available.some(Boolean)) return original.call(this, spec)
      ready ??= prepareDockerShim(root)
      let launcher: Awaited<ReturnType<typeof prepareDockerShim>>
      try { launcher = await ready }
      catch (error) {
        ctx.logger('service-manager').warn('Docker launcher preparation failed: %s', String(error))
        return original.call(this, spec)
      }
      const { shim, proxy } = launcher
      env[pathKey] = `${shim}${delimiter}${originalPath}`
      return original.call(this, { ...spec, env, dshEnv: { ...spec.dshEnv, DSH_SERVICE_SHIM: shim, DSH_SERVICE_DOCKER_PROXY: proxy, DSH_SERVICE_NODE: process.execPath, DSH_SERVICE_CAPTURE_DIR: captures, DSH_SERVICE_REGISTRY_KEY: automatic.key } } as ShellSpec)
    }
    child.effect(() => {
      // Cordis returns a fresh traced function on each read, so compare and restore
      // descriptors rather than the caller-scoped method proxies.
      Object.defineProperty(shell, 'execute', { configurable: true, writable: true, value: wrapped })
      return () => {
        if (Object.getOwnPropertyDescriptor(shell, 'execute')?.value !== wrapped) return
        if (previous) Object.defineProperty(shell, 'execute', previous)
        else Reflect.deleteProperty(shell, 'execute')
      }
    }, 'service-manager: Docker launch attribution')
  })
  automatic.captureContainers = async () => {
    let files: string[]
    try { files = await readdir(captures) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const file of files.filter(file => file.endsWith('.json'))) {
      const { context } = JSON.parse(await readFile(join(captures, file), 'utf8')) as { context: string }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(context)) continue
      const output = await runner('docker', ['--context', context, 'ps', '-a', '--no-trunc', '--filter', `label=io.dsh.service-manager.registry=${automatic.key}`, '--format', '{{.ID}}'], 2000)
      const ids = output.split(/\s+/).filter(id => /^[a-f0-9]{64}$/.test(id))
      if (!ids.length) continue
      const containers = JSON.parse(await runner('docker', ['--context', context, 'inspect', ...ids], 2000)) as { Id: string; Name: string; Config: { Labels?: Record<string, string> } }[]
      const discovered = containers.flatMap(container => {
        const owner = decodeOwner(automatic.key, container.Config.Labels?.['io.dsh.service-manager.owner'] ?? '')
        return owner && /^[a-f0-9]{64}$/.test(container.Id) ? [{ container, owner }] : []
      })
      const rows = await automatic.store.read()
      if (!discovered.some(({ container }) => !rows.some(row => row.kind === 'container' && row.context === context && row.containerId === container.Id))) continue
      await automatic.store.update(rows => {
        for (const { container, owner } of discovered) {
          if (rows.some(row => row.kind === 'container' && row.context === context && row.containerId === container.Id)) continue
          rows.push({ id: randomUUID(), name: container.Name.replace(/^\//, '').slice(0, 512), kind: 'container', context, containerId: container.Id, project: owner.project, session: owner.session, createdAt: new Date().toISOString(), url: '' })
        }
      })
    }
  }
}
