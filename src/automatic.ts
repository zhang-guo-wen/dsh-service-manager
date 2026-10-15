import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { inspectProcesses } from './discover-processes.ts'
import { NativeProcesses, startedBefore } from './processes.ts'
import { decodeOwner, encodeOwner, OWNER_ENV, registryKey } from './ownership.ts'
import type { Ownership } from './ownership.ts'
import type { RegistryStore } from './store.ts'
import type { ActionResult, ProcessRow, ServiceDiscovery, ServiceRecord, ServiceView } from './types.ts'

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

/** Observation timing and the unmarked-process channel; every field has a documented default in the plugin Config. */
export interface AutomaticOptions {
  hostOwned?: boolean
  reconcileDelayMs?: number
  reconcileMinIntervalMs?: number
  reconcileIntervalMs?: number
}

/** Structural lookup keeps optional host services out of the plugin's runtime dependencies. */
export function hostService<T>(ctx: Context, name: string): T | undefined { return ctx.get(name) as T | undefined }

/** A process is host-owned when its whole ancestor chain reaches the Harness process. */
function reachesHarness(rows: ReadonlyMap<number, ProcessRow>, row: ProcessRow, harnessPid: number, cache: Map<number, boolean>, depth = 0): boolean {
  if (row.pid === harnessPid) return true
  if (depth > 64 || !row.startedAt) return false
  const known = cache.get(row.pid)
  if (known !== undefined) return known
  const parent = rows.get(row.parentPid)
  // Windows keeps a creator PID after its exit: a parent that started after its
  // child is a reused PID, not an ancestor.
  const ordered = parent?.startedAt ? startedBefore(row.startedAt, parent.startedAt) === false : false
  const result = Boolean(parent) && ordered && reachesHarness(rows, parent!, harnessPid, cache, depth + 1)
  cache.set(row.pid, result)
  return result
}

/** Every live row whose ancestor chain reaches the Harness process. */
export function hostDescendants(rows: readonly ProcessRow[], harnessPid: number): ProcessRow[] {
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const cache = new Map<number, boolean>()
  return rows.filter(row => reachesHarness(byPid, row, harnessPid, cache))
}

/** Ancestors of attributed processes, such as the private spawn runners that wrap them. */
function ancestorsOf(rows: ReadonlyMap<number, ProcessRow>, pids: Iterable<number>): Set<number> {
  const ancestors = new Set<number>()
  for (const pid of pids) {
    let parent = rows.get(pid)?.parentPid
    for (let depth = 0; parent && depth < 64; depth++) {
      if (ancestors.has(parent)) break
      ancestors.add(parent)
      parent = rows.get(parent)?.parentPid
    }
  }
  return ancestors
}

export class AutomaticServices implements ServiceDiscovery {
  readonly key: string
  readonly call = new AsyncLocalStorage<string>()
  private readonly bindings = new Map<string, JobBinding>()
  private hidden = new Set<string>()
  private processCalls = new Map<string, string>()
  private flight: Promise<void> | undefined
  private flightContainers = false
  private hostSeen = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private sweep: NodeJS.Timeout | undefined
  private lastScan = 0
  private readonly options: Required<AutomaticOptions>
  jobs: Jobs | undefined
  warnings: string[] = []
  captureContainers?: () => Promise<void>
  constructor(readonly store: RegistryStore, private readonly sessions: () => SessionHost | undefined, private readonly scan = inspectProcesses, options: AutomaticOptions = {}) {
    this.key = registryKey(store.file)
    this.options = { hostOwned: true, reconcileDelayMs: 1500, reconcileMinIntervalMs: 10_000, reconcileIntervalMs: 30_000, ...options }
  }

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
      this.schedule()
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

  /**
   * Coalesce one delayed scan after activity that can create processes, never
   * more often than the configured minimum interval. Timers never hold the
   * process open, and every one is cleared by {@link startScheduler}'s disposer.
   */
  schedule(): void {
    if (this.options.reconcileDelayMs <= 0 || this.timer) return
    const wait = Math.max(this.options.reconcileDelayMs, this.lastScan + this.options.reconcileMinIntervalMs - Date.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.reconcile().catch(() => { /* The next trigger or page refresh retries. */ })
    }, wait)
    this.timer.unref()
  }

  /** Start the periodic sweep; the returned disposer clears every timer. */
  startScheduler(): () => void {
    if (this.options.reconcileIntervalMs > 0) {
      this.sweep = setInterval(() => { this.schedule() }, this.options.reconcileIntervalMs)
      this.sweep.unref()
    }
    return () => {
      if (this.sweep) clearInterval(this.sweep)
      this.sweep = undefined
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  refresh(containers = true): Promise<void> {
    if (!this.flight) {
      this.flightContainers = containers
      this.flight = this.collect(containers).finally(() => { this.flight = undefined; this.flightContainers = false })
      return this.flight
    }
    // A page refresh still captures containers when a lighter scan is in flight.
    if (!containers || this.flightContainers) return this.flight
    const pending = this.flight
    return pending.then(async () => {
      try { await this.captureContainers?.() }
      catch (error) { this.warnings.push(String(error)) }
    })
  }

  /** Collect process rows only; container discovery stays a page-triggered read. */
  reconcile(): Promise<void> {
    return this.refresh(false)
  }

  private async collect(containers: boolean): Promise<void> {
    this.warnings = []
    const [scanned] = await Promise.all([
      this.scan().catch(error => { this.warnings.push(String(error)); return [] as ProcessRow[] }),
      containers ? this.captureContainers?.().catch(error => { this.warnings.push(String(error)) }) : undefined,
    ])
    this.lastScan = Date.now()
    const alive = scanned.filter(row => row.alive && row.startedAt)
    const byPid = new Map(alive.map(row => [row.pid, row]))
    // Processes carrying this registry's ownership marker, at any depth.
    const owned = alive.flatMap(info => {
      const owner = info.marker ? decodeOwner(this.key, info.marker) : undefined
      return owner ? [{ info, owner }] : []
    })
    const ownedByPid = new Map(owned.map(row => [row.info.pid, row]))
    const ownedRoots = owned.filter(({ info, owner }) => {
      const parent = ownedByPid.get(info.parentPid)
      return !parent || parent.owner.call !== owner.call || parent.owner.session !== owner.session || identityOlder(info.startedAt!, parent.info.startedAt!)
    })
    const hostRoots = this.hostRoots(alive, byPid, owned.map(row => row.info.pid), ownedRoots.map(row => row.info.pid))
    this.hidden = new Set([
      ...owned.filter(row => !ownedRoots.includes(row)).map(row => identity(row.info.pid, row.info.startedAt!)),
      ...hostRoots.hidden.map(row => identity(row.pid, row.startedAt!)),
    ])
    this.processCalls = new Map(ownedRoots.map(row => [identity(row.info.pid, row.info.startedAt!), row.owner.call]))
    // Live jobs already have a controller and a human-readable command label.
    // Persist only work that survives outside that job, avoiding one file row per build.
    const independent = ownedRoots.filter(row => !this.runningJob(row.owner.call))
    const host = new NativeProcesses().host
    const candidates = [
      ...independent.map(({ info, owner }) => ({ info, name: info.name.slice(0, 512), project: owner.project, session: owner.session })),
      ...hostRoots.roots.map(info => ({ info, name: info.name.slice(0, 512), project: '', session: '' })),
    ]
    if (!candidates.length) return
    const present = await this.store.read()
    const missing = candidates.filter(({ info }) => !present.some(row => row.kind === 'process' && row.host === host && row.pid === info.pid && row.startedAt === info.startedAt))
    if (!missing.length) return
    await this.store.update(rows => {
      for (const { info, name, project, session } of missing) {
        if (rows.some(row => row.kind === 'process' && row.host === host && row.pid === info.pid && row.startedAt === info.startedAt)) continue
        rows.push({ id: randomUUID(), name, project, session, url: '', createdAt: new Date().toISOString(), kind: 'process', pid: info.pid, startedAt: info.startedAt!, host, tree: true, pendingStop: [] })
      }
    })
  }

  /**
   * Split the unmarked descendants of the Harness into visible roots and hidden
   * descendants. Two scans must see the same process before it is persisted, so
   * the short-lived helpers this plugin itself spawns never become records.
   */
  private hostRoots(alive: readonly ProcessRow[], byPid: ReadonlyMap<number, ProcessRow>, ownedPids: readonly number[], ownedRootPids: readonly number[]): { roots: ProcessRow[]; hidden: ProcessRow[] } {
    if (!this.options.hostOwned) { this.hostSeen = new Set(); return { roots: [], hidden: [] } }
    const owned = new Set(ownedPids)
    const ancestors = ancestorsOf(byPid, ownedRootPids)
    const candidates = hostDescendants(alive, process.pid)
      .filter(row => row.pid !== process.pid && !owned.has(row.pid) && !ancestors.has(row.pid))
    const candidatePids = new Set(candidates.map(row => row.pid))
    // A candidate under another candidate is a descendant, never a row of its own.
    const roots = candidates.filter(row => !candidatePids.has(row.parentPid))
    const hidden = candidates.filter(row => candidatePids.has(row.parentPid))
    const observed = new Set(candidates.map(row => identity(row.pid, row.startedAt!)))
    const stable = roots.filter(row => this.hostSeen.has(identity(row.pid, row.startedAt!)))
    this.hostSeen = observed
    return { roots: stable, hidden }
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

export function installAutomatic(ctx: Context, store: RegistryStore, options: AutomaticOptions = {}): AutomaticServices {
  const automatic = new AutomaticServices(store, () => hostService<SessionHost>(ctx, 'sessions'), inspectProcesses, options)
  ctx.inject(['jobs'], child => {
    child.effect(() => automatic.attachJobs(hostService<Jobs>(child, 'jobs')!), 'service-manager: observe background tasks')
  })
  ctx.inject(['shellEnv'], child => {
    child.effect(() => hostService<ShellEnvironment>(child, 'shellEnv')!.register({ name: 'service-manager', variables: { [OWNER_ENV]: { description: 'Host-owned service attribution inherited by child processes.' } }, resolve: exec => automatic.owner(exec) }), 'service-manager: process attribution')
  })
  // Activity that can create processes schedules one coalesced scan, so a record
  // exists before a hard kill instead of only after the next settings visit.
  ctx.on('tools/execute', (exec, next) => { automatic.schedule(); return automatic.call.run(String(exec.callId), next) })
  ctx.effect(() => automatic.startScheduler(), 'service-manager: process reconciliation')
  // Observation only: disposing the plugin never stops jobs or discovered resources.
  return automatic
}
