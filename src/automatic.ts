import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { NativeProcesses } from './processes.ts'
import { discoverProcesses } from './discover-processes.ts'
import { decodeOwner, encodeOwner, OWNER_ENV, registryKey } from './ownership.ts'
import type { Ownership } from './ownership.ts'
import type { RegistryStore } from './store.ts'
import type { ActionResult, ServiceDiscovery, ServiceRecord, ServiceView } from './types.ts'

export interface HostJob { id: string; kind: string; owner?: string; label: string; status: string; startedAt: number }
export interface Jobs {
  list(owner?: string): HostJob[]
  get(id: string, owner?: string): HostJob
  kill(id: string, owner?: string, reason?: string): string
  wait(id: string, timeout: number, owner?: string): Promise<HostJob>
  events: { subscribe(filter: { owners: 'all' }, listener: (event: { type: string; job?: HostJob }) => void): () => void }
}
interface JobBinding { job: HostJob; id: string; call: string }
export interface SessionHost { list(): { header: { id: string; cwd?: string } }[] }
export interface ShellEnvironment { register(contribution: { name: string; variables: Record<string, { description: string }>; resolve(exec: ToolExecution): Record<string, string> }): () => void }

/** Structural lookup keeps optional host services out of the plugin's runtime dependencies. */
export function hostService<T>(ctx: Context, name: string): T | undefined { return ctx.get(name) as T | undefined }

export class AutomaticServices implements ServiceDiscovery {
  readonly key: string
  readonly call = new AsyncLocalStorage<string>()
  private readonly bindings = new Map<string, JobBinding>()
  private hidden = new Set<string>()
  private processCalls = new Map<string, string>()
  private flight: Promise<void> | undefined
  jobs: Jobs | undefined
  warnings: string[] = []
  captureContainers?: () => Promise<void>
  constructor(readonly store: RegistryStore, private readonly sessions: () => SessionHost | undefined, private readonly scan = discoverProcesses) { this.key = registryKey(store.file) }

  owner(exec: ToolExecution): Record<string, string> {
    if (!exec.agent) return {}
    return { [OWNER_ENV]: encodeOwner(this.key, { session: String(exec.agent.id), project: exec.agent.session.header.cwd ?? '', call: String(exec.callId) }) }
  }

  attachJobs(jobs: Jobs): () => void {
    this.jobs = jobs
    const observe = (job: HostJob, call = '') => {
      if (!['bash', 'pwsh'].includes(job.kind)) return
      const existing = this.bindings.get(job.id)
      if (!existing || existing.job.startedAt !== job.startedAt) this.bindings.set(job.id, { job: { ...job }, id: randomUUID(), call })
      else existing.job = { ...job }
    }
    const unsubscribe = jobs.events.subscribe({ owners: 'all' }, event => {
      if (!event.job) return
      if (event.type === 'removed') this.bindings.delete(event.job.id)
      else observe(event.job, this.call.getStore())
    })
    for (const owner of [undefined, ...this.sessions()?.list().map(session => session.header.id) ?? []]) {
      for (const job of jobs.list(owner)) observe(job)
    }
    return () => { unsubscribe(); this.jobs = undefined; this.bindings.clear() }
  }

  refresh(): Promise<void> {
    if (!this.flight) this.flight = this.collect().finally(() => { this.flight = undefined })
    return this.flight
  }

  private async collect(): Promise<void> {
    this.warnings = []
    const [scanned] = await Promise.all([
      this.scan().catch(error => { this.warnings.push(String(error)); return [] }),
      this.captureContainers?.().catch(error => { this.warnings.push(String(error)) }),
    ])
    const owned = scanned.flatMap(info => {
      const owner = decodeOwner(this.key, info.marker)
      return owner && info.alive && info.startedAt ? [{ info, owner }] : []
    })
    const byPid = new Map(owned.map(row => [row.info.pid, row]))
    const roots = owned.filter(({ info, owner }) => {
      const parent = byPid.get(info.parentPid)
      return !parent || parent.owner.call !== owner.call || parent.owner.session !== owner.session || identityOlder(info.startedAt!, parent.info.startedAt!)
    })
    this.hidden = new Set(owned.filter(row => !roots.includes(row)).map(row => identity(row.info.pid, row.info.startedAt!)))
    this.processCalls = new Map(roots.map(row => [identity(row.info.pid, row.info.startedAt!), row.owner.call]))
    // Live jobs already have a controller and a human-readable command label.
    // Persist only work that survives outside that job, avoiding one file row per build.
    const independent = roots.filter(row => !this.runningJob(row.owner.call))
    if (!independent.length) return
    const host = new NativeProcesses().host
    const present = await this.store.read()
    const missing = independent.filter(({ info }) => !present.some(row => row.kind === 'process' && row.host === host && row.pid === info.pid && row.startedAt === info.startedAt))
    if (!missing.length) return
    await this.store.update(rows => {
      for (const { info, owner } of missing) {
        if (rows.some(row => row.kind === 'process' && row.host === host && row.pid === info.pid && row.startedAt === info.startedAt)) continue
        rows.push({ id: randomUUID(), name: info.name.slice(0, 512), ...metadata(owner), kind: 'process', pid: info.pid, startedAt: info.startedAt!, host, tree: true, pendingStop: [] })
      }
    })
  }

  private runningJob(call: string): boolean {
    if (!call || !this.jobs) return false
    return [...this.bindings.values()].some(binding => {
      if (binding.call !== call) return false
      try {
        const current = this.jobs!.get(binding.job.id, binding.job.owner)
        return current.startedAt === binding.job.startedAt && current.status === 'running'
      } catch { return false }
    })
  }

  visible(record: ServiceRecord): boolean {
    if (record.kind !== 'process') return true
    const key = identity(record.pid, record.startedAt)
    return !this.hidden.has(key) && !this.runningJob(this.processCalls.get(key) ?? '')
  }

  async list(): Promise<ServiceView[]> {
    if (!this.jobs) return []
    const services: ServiceView[] = []
    for (const binding of this.bindings.values()) {
      let job: HostJob
      try { job = this.jobs.get(binding.job.id, binding.job.owner) } catch { continue }
      if (job.startedAt !== binding.job.startedAt || job.status !== 'running') continue
      const project = this.sessions()?.list().find(session => session.header.id === job.owner)?.header.cwd ?? ''
      services.push({ record: { id: binding.id, name: job.label.slice(0, 512), kind: 'job', jobId: job.id, project, session: job.owner ?? '', url: '', createdAt: new Date(job.startedAt).toISOString() }, status: 'running', detail: '', remaining: 1 })
    }
    return services
  }

  async stop(id: string): Promise<ActionResult | undefined> {
    const binding = [...this.bindings.values()].find(binding => binding.id === id)
    if (!binding) return
    if (!this.jobs) throw new Error('The background task host is unavailable')
    const { job: previous } = binding
    const job = this.jobs.get(previous.id, previous.owner)
    if (job.startedAt !== previous.startedAt || job.owner !== previous.owner) throw new Error('Background task identity changed; stop refused')
    if (job.status === 'running' || job.status === 'stopping') {
      this.jobs.kill(job.id, job.owner, 'cancelled by the user')
      const settled = await this.jobs.wait(job.id, 1500, job.owner)
      if (settled.status === 'running' || settled.status === 'stopping') throw new Error('Background task is still stopping; refresh to check its status')
    }
    return { id, ok: true, message: 'Stopped' }
  }
}

function identity(pid: number, started: string): string { return `${pid}:${started}` }
function identityOlder(child: string, parent: string): boolean {
  const last = (value: string) => value.split(':').at(-1)!
  return /^\d+$/.test(last(child)) && /^\d+$/.test(last(parent)) && BigInt(last(child)) < BigInt(last(parent))
}
function metadata(owner: Ownership) { return { project: owner.project, session: owner.session, url: '', createdAt: new Date().toISOString() } }

export function installAutomatic(ctx: Context, store: RegistryStore): AutomaticServices {
  const automatic = new AutomaticServices(store, () => hostService<SessionHost>(ctx, 'sessions'))
  ctx.inject(['jobs'], child => {
    child.effect(() => automatic.attachJobs(hostService<Jobs>(child, 'jobs')!), 'service-manager: observe background tasks')
  })
  ctx.inject(['shellEnv'], child => {
    child.effect(() => hostService<ShellEnvironment>(child, 'shellEnv')!.register({ name: 'service-manager', variables: { [OWNER_ENV]: { description: 'Host-owned service attribution inherited by child processes.' } }, resolve: exec => automatic.owner(exec) }), 'service-manager: process attribution')
  })
  ctx.on('tools/execute', (exec, next) => automatic.call.run(String(exec.callId), next))
  // Observation only: disposing the plugin never stops jobs or discovered resources.
  return automatic
}
