import { randomUUID } from 'node:crypto'
import { RegistryStore } from './store.ts'
import { NativeProcesses, processTargets } from './processes.ts'
import { DockerContainers } from './containers.ts'
import { errorMessage, NormalStopUnsupportedError } from './errors.ts'
import { idsSchema, registerSchema, stopSchema } from './schema.ts'
import type { ActionResult, ContainerAdapter, ListResult, MutationResult, ProcessAdapter, ProcessIdentity, ProcessInfo, ProcessService, RegisterRequest, RemoveRequest, ServiceRecord, ServiceView, StopRequest } from './types.ts'

function matches(target: ProcessIdentity, snapshot: Map<number, ProcessInfo>): boolean {
  const current = snapshot.get(target.pid)
  return Boolean(current?.alive && current.startedAt === target.startedAt)
}

function protectedPids(snapshot: Map<number, ProcessInfo>): Set<number> {
  const protectedSet = new Set([0, 1, process.pid])
  let parent = snapshot.get(process.pid)?.parentPid
  while (parent && !protectedSet.has(parent)) {
    protectedSet.add(parent)
    parent = snapshot.get(parent)?.parentPid
  }
  return protectedSet
}

export class ServiceRegistry {
  discovery?: import('./types.ts').ServiceDiscovery
  constructor(
    readonly store: RegistryStore,
    private readonly processes: ProcessAdapter = new NativeProcesses(),
    private readonly containers: ContainerAdapter = new DockerContainers(),
  ) {}

  async register(request: RegisterRequest): Promise<ServiceRecord> {
    const value = registerSchema.parse(request)
    const metadata = { id: randomUUID(), name: value.name, project: value.project ?? '', session: value.session ?? '', url: value.url ?? '', createdAt: new Date().toISOString() }
    let record: ServiceRecord
    if (value.kind === 'process') {
      const snapshot = await this.processes.snapshot()
      const current = snapshot.get(value.pid!)
      if (protectedPids(snapshot).has(value.pid!)) throw new Error('Cannot register the Harness, its ancestors, or a system process for stopping')
      if (!current?.alive || !current.startedAt) throw new Error('Process is absent or its creation identity cannot be verified')
      record = { ...metadata, kind: 'process', pid: current.pid, startedAt: current.startedAt, host: this.processes.host, tree: value.tree ?? false, pendingStop: [] }
    } else {
      const context = await this.containers.resolveContext(value.context)
      const current = await this.containers.inspect(context, value.container!)
      if (!current) throw new Error('Container does not exist')
      record = { ...metadata, kind: 'container', containerId: current.id, context }
    }
    return this.store.update(rows => {
      const duplicate = rows.some(row => row.kind === 'process' && record.kind === 'process'
        ? row.host === record.host && row.pid === record.pid && row.startedAt === record.startedAt
        : row.kind === 'container' && record.kind === 'container' && row.context === record.context && row.containerId === record.containerId)
      if (duplicate) throw new Error('This service is already registered')
      rows.push(record)
      return record
    })
  }

  async list(): Promise<ListResult> {
    await this.discovery?.refresh()
    const rows = await this.store.read()
    let snapshotError = ''
    const pids = [...new Set(rows.flatMap(row => row.kind === 'process' && row.host === this.processes.host
      ? [row.pid, ...row.pendingStop.map(target => target.pid)] : []))]
    // Start process and container checks together. Every refresh reads live state.
    const snapshotPromise = pids.length ? this.processes.snapshot(pids).catch(error => {
      snapshotError = String(error)
      return undefined
    }) : Promise.resolve(undefined)
    const services = await Promise.all(rows.map(async (record): Promise<ServiceView> => {
      try {
        if (record.kind === 'container') {
          const current = await this.containers.inspect(record.context, record.containerId)
          if (current && current.id !== record.containerId) return { record, status: 'changed', detail: 'Container identity changed', remaining: 0 }
          return { record, status: current?.running ? 'running' : 'stopped', detail: current ? `${current.phase}; restart=${current.restart}` : 'Container no longer exists', remaining: current?.running ? 1 : 0 }
        }
        if (record.host !== this.processes.host) throw new Error('Record belongs to a different host')
        const snapshot = await snapshotPromise
        if (!snapshot) throw new Error(snapshotError || 'Process snapshot unavailable')
        const current = snapshot.get(record.pid)
        const remaining = record.pendingStop.filter(target => matches(target, snapshot)).length
        const uncertain = record.pendingStop.some(target => { const info = snapshot.get(target.pid); return info?.alive && !info.startedAt })
        if (uncertain || current?.alive && !current.startedAt) throw new Error('Process identity is inaccessible')
        if (remaining > 0) return { record, status: 'running', detail: 'A manual stop has remaining process targets', remaining }
        if (!current?.alive) return { record, status: 'stopped', detail: '', remaining: 0 }
        if (current.startedAt !== record.startedAt) return { record, status: 'changed', detail: 'PID was reused; the registered process has exited', remaining: 0 }
        return { record, status: 'running', detail: current.name, remaining: 1 }
      } catch (error) { return { record, status: 'unknown', detail: String(error), remaining: 0 } }
    }))
    return { services: [...services.filter(row => this.discovery?.visible(row.record as ServiceRecord) !== false), ...await this.discovery?.list() ?? []], file: this.store.file, ...this.discovery?.warnings?.length ? { warnings: this.discovery.warnings } : {} }
  }

  /** Prepare and persist a manual stop's identities before delivering any signal. */
  private async prepareProcess(record: ProcessService): Promise<ProcessIdentity[]> {
    if (record.host !== this.processes.host) throw new Error('Record belongs to a different host')
    const snapshot = await this.processes.snapshot()
    const current = snapshot.get(record.pid)
    if (current?.alive && !current.startedAt) throw new Error('Process identity cannot be verified; stop refused')
    if (current?.alive && current.startedAt !== record.startedAt && record.pendingStop.length === 0) throw new Error('PID was reused; stop refused')
    const targets: ProcessIdentity[] = []
    for (const root of [...record.pendingStop, { pid: record.pid, startedAt: record.startedAt }]) {
      const info = snapshot.get(root.pid)
      if (info?.alive && !info.startedAt) throw new Error('A stop target cannot be verified')
      for (const target of processTargets(root, snapshot, record.tree)) {
        if (!targets.some(existing => existing.pid === target.pid && existing.startedAt === target.startedAt)) targets.push(target)
      }
    }
    const protectedSet = protectedPids(snapshot)
    if (targets.some(target => protectedSet.has(target.pid))) throw new Error('The stop targets include the Harness, an ancestor, or a system process')
    if (record.tree) {
      // Never silently skip a live child whose creation identity is inaccessible.
      const parents = new Set(targets.map(target => target.pid))
      if ([...snapshot.values()].some(info => parents.has(info.parentPid) && info.alive && !info.startedAt)) throw new Error('A child process identity cannot be verified; tree stop refused')
    }
    record.pendingStop = targets
    return targets
  }

  async stop(request: StopRequest): Promise<MutationResult> {
    const { ids, force = false } = stopSchema.parse(request)
    const results: ActionResult[] = []
    for (const id of new Set(ids)) {
      try {
        const automatic = await this.discovery?.stop(id)
        if (automatic) { results.push(automatic); continue }
        let targets: ProcessIdentity[] = []
        const record = await this.store.update(async rows => {
          const row = rows.find(item => item.id === id)
          if (!row) throw new Error('Service record does not exist')
          if (row.kind === 'process') targets = await this.prepareProcess(row)
          return structuredClone(row)
        })
        if (record.kind === 'container') {
          await this.containers.stop(record.context, record.containerId, force)
          const current = await this.containers.inspect(record.context, record.containerId)
          if (current?.running) throw new Error('Container is still running; check its restart policy')
        } else {
          const errors: unknown[] = []
          for (const target of targets) {
            try { await this.processes.signal(target, force) }
            catch (error) { errors.push(error) }
          }
          // A signal is a request, not proof that the process has ended.
          const pids = targets.map(target => target.pid)
          let snapshot = await this.processes.snapshot(pids)
          for (let attempt = 0; attempt < 3 && targets.some(target => matches(target, snapshot)); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 150))
            snapshot = await this.processes.snapshot(pids)
          }
          const remaining = targets.filter(target => matches(target, snapshot) || snapshot.get(target.pid)?.alive && !snapshot.get(target.pid)?.startedAt)
          await this.store.update(rows => {
            const row = rows.find(item => item.id === id)
            if (row?.kind === 'process') row.pendingStop = remaining
          })
          if (remaining.length) {
            if (errors.length && errors.every(error => error instanceof NormalStopUnsupportedError)) throw new NormalStopUnsupportedError()
            throw new Error(errors.map(errorMessage).join('; ') || 'Processes are still running; refresh or use explicit force stop')
          }
        }
        results.push({ id, ok: true, message: 'Stopped' })
      } catch (error) {
        results.push({ id, ok: false, message: errorMessage(error), ...error instanceof NormalStopUnsupportedError ? { code: error.code } : {} })
      }
    }
    return { results }
  }

  async remove(request: RemoveRequest): Promise<MutationResult> {
    const { ids } = idsSchema.parse(request)
    return this.store.update(rows => {
      const results: ActionResult[] = []
      for (const id of new Set(ids)) {
        const index = rows.findIndex(row => row.id === id)
        if (index < 0) results.push({ id, ok: false, message: 'Service record does not exist' })
        else { rows.splice(index, 1); results.push({ id, ok: true, message: 'Record removed; service was not stopped' }) }
      }
      return { results }
    })
  }
}
