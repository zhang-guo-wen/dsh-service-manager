import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutomaticServices, hostDescendants } from '../src/automatic.ts'
import { ServiceRegistry } from '../src/manager.ts'
import { RegistryStore } from '../src/store.ts'
import { startedBefore } from '../src/processes.ts'
import { encodeOwner } from '../src/ownership.ts'
import type { ProcessAdapter, ProcessInfo, ProcessIdentity, ProcessRow, ServiceRecord } from '../src/types.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const row = (pid: number, parentPid: number, startedAt: string, extra: Partial<ProcessRow> = {}): ProcessRow =>
  ({ pid, parentPid, startedAt, name: `p${pid}`, alive: true, ...extra })

async function fixture(rows: ProcessRow[] = [], options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'reconcile-'))
  dirs.push(dir)
  const store = new RegistryStore(join(dir, 'services.json'))
  let scanned = rows
  let scans = 0
  let captures = 0
  const auto = new AutomaticServices(store, () => undefined, async () => { scans++; return scanned }, { reconcileDelayMs: 0, reconcileIntervalMs: 0, ...options })
  auto.captureContainers = async () => { captures++ }
  return {
    store, auto,
    set: (next: ProcessRow[]) => { scanned = next },
    counts: () => ({ scans, captures }),
  }
}

describe('unmarked Harness descendants', () => {
  it('walks parentage with start-time ordering and rejects a reused creator PID', () => {
    const rows = [row(10, 1, '1'), row(11, 10, '2'), row(12, 11, '3'), row(13, 9, '4'), row(14, 10, '0')]
    // 13 has no readable parent and 14 started before the process that claims it.
    expect(hostDescendants(rows, 10).map(item => item.pid)).toEqual([10, 11, 12])
  })

  it('persists an unmarked descendant only after a second scan proves it survives', async () => {
    const f = await fixture()
    f.set([row(process.pid, 1, '1'), row(500, process.pid, '2')])
    await f.auto.reconcile()
    expect(await f.store.read()).toEqual([])
    await f.auto.reconcile()
    expect(await f.store.read()).toMatchObject([{ kind: 'process', pid: 500, project: '', session: '', tree: true, name: 'p500' }])
  })

  it('hides a descendant under its root and never persists the Harness process itself', async () => {
    const f = await fixture()
    f.set([row(process.pid, 1, '1'), row(500, process.pid, '2'), row(501, 500, '3')])
    await f.auto.reconcile()
    await f.auto.reconcile()
    const stored = await f.store.read()
    expect(stored.map(item => item.kind === 'process' && item.pid)).toEqual([500])
    const child: ServiceRecord = { id: '00000000-0000-4000-8000-000000000000', name: 'child', project: '', session: '', url: '', createdAt: new Date().toISOString(), kind: 'process', pid: 501, startedAt: '3', host: 'x', tree: true, pendingStop: [] }
    expect(f.auto.visible(child)).toBe(false)
  })

  it('never records the private runner that wraps an attributed process', async () => {
    const f = await fixture()
    const marker = encodeOwner(f.auto.key, { session: 'session-a', project: 'C:/workspace', call: 'call-a' })
    f.set([row(process.pid, 1, '1'), row(600, process.pid, '2'), row(601, 600, '3', { marker })])
    await f.auto.reconcile()
    await f.auto.reconcile()
    expect((await f.store.read()).map(item => item.kind === 'process' && item.pid)).toEqual([601])
  })

  it('leaves the unmarked channel off when the Config disables it', async () => {
    const f = await fixture([], { hostOwned: false })
    f.set([row(process.pid, 1, '1'), row(500, process.pid, '2')])
    await f.auto.reconcile()
    await f.auto.reconcile()
    expect(await f.store.read()).toEqual([])
  })
})

describe('reconciliation scheduling', () => {
  it('coalesces triggers and skips container discovery', async () => {
    const f = await fixture()
    f.auto.schedule(); f.auto.schedule(); f.auto.schedule()
    await f.auto.reconcile()
    expect(f.counts()).toEqual({ scans: 1, captures: 0 })
    await delay(20)
    expect(f.counts().scans).toBe(1)
    await f.auto.refresh()
    expect(f.counts()).toEqual({ scans: 2, captures: 1 })
  })

  it('holds the minimum interval between scheduled scans', async () => {
    const f = await fixture([], { reconcileDelayMs: 1, reconcileMinIntervalMs: 600 })
    f.auto.startScheduler()
    f.auto.schedule()
    await delay(30)
    expect(f.counts().scans).toBe(1)
    // A second trigger inside the window waits instead of scanning again.
    f.auto.schedule()
    await delay(60)
    expect(f.counts().scans).toBe(1)
    await delay(600)
    expect(f.counts().scans).toBe(2)
  })

  it('clears the pending timer when the observer is disposed', async () => {
    const f = await fixture([], { reconcileDelayMs: 20 })
    const dispose = f.auto.startScheduler()
    f.auto.schedule()
    dispose()
    await delay(50)
    expect(f.counts().scans).toBe(0)
  })

  it('sweeps periodically until disposal', async () => {
    const f = await fixture([], { reconcileDelayMs: 1, reconcileMinIntervalMs: 0, reconcileIntervalMs: 10 })
    const dispose = f.auto.startScheduler()
    await delay(70)
    dispose()
    expect(f.counts().scans).toBeGreaterThan(1)
    const settled = f.counts().scans
    await delay(40)
    expect(f.counts().scans).toBe(settled)
  })
})

describe('creation identities', () => {
  it('orders Windows ticks, Linux boot ticks, and ISO timestamps', () => {
    expect(startedBefore('100', '200')).toBe(true)
    expect(startedBefore('200', '100')).toBe(false)
    expect(startedBefore('boot:10', 'boot:20')).toBe(true)
    expect(startedBefore('one:10', 'two:20')).toBeUndefined()
    expect(startedBefore('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')).toBe(true)
    expect(startedBefore('ticks', '2026-01-02T00:00:00.000Z')).toBeUndefined()
  })

  it('marks a running process that predates the current Harness run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'legacy-'))
    dirs.push(dir)
    const store = new RegistryStore(join(dir, 'services.json'))
    const processes: ProcessAdapter = {
      host: 'test:host',
      snapshot: async (pids?: readonly number[]) => new Map(pids?.map(pid => [pid, { pid, parentPid: 1, startedAt: '900', name: 'legacy-server', alive: true } as ProcessInfo])),
      selfIdentity: async (): Promise<ProcessIdentity | undefined> => ({ pid: 1, startedAt: '1000' }),
      signal: async () => {},
    }
    const record = (pid: number, startedAt: string): ServiceRecord => ({ id: crypto.randomUUID(), name: `p${pid}`, project: '', session: '', url: '', createdAt: new Date().toISOString(), kind: 'process', pid, startedAt, host: 'test:host', tree: true, pendingStop: [] })
    await store.update(rows => { rows.push(record(700, '900'), record(701, '1000')) })
    const registry = new ServiceRegistry(store, processes)
    const services = (await registry.list()).services
    expect(services.find(item => item.record.kind === 'process' && item.record.pid === 700)?.legacy).toBe(true)
    expect(services.find(item => item.record.kind === 'process' && item.record.pid === 701)?.legacy).toBeUndefined()
  })
})
