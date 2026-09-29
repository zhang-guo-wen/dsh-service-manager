import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RegistryStore } from '../src/store.ts'
import { ServiceRegistry } from '../src/manager.ts'
import { parseLinuxStat, processTargets } from '../src/processes.ts'
import { NormalStopUnsupportedError } from '../src/errors.ts'
import type { ContainerAdapter, ContainerInfo, ProcessAdapter, ProcessInfo, ProcessService } from '../src/types.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'dsh-services-'))
  directories.push(path)
  const snapshot = new Map<number, ProcessInfo>([[12345, { pid: 12345, parentPid: 1, startedAt: '100', alive: true, name: 'server' }]])
  const signals: { pid: number; force: boolean }[] = []
  const processes: ProcessAdapter = {
    host: 'test-host', snapshot: vi.fn(async () => new Map(snapshot)),
    signal: vi.fn(async (target, force) => { signals.push({ pid: target.pid, force }); snapshot.delete(target.pid) }),
  }
  const container: ContainerInfo = { id: 'a'.repeat(64), name: 'redis', phase: 'running', running: true, restart: 'no' }
  const containers: ContainerAdapter = {
    resolveContext: vi.fn(async context => context ?? 'desktop-linux'),
    inspect: vi.fn(async () => ({ ...container })),
    stop: vi.fn(async () => { container.running = false; container.phase = 'exited' }),
  }
  const store = new RegistryStore(join(path, 'services.json'))
  return { path, store, manager: new ServiceRegistry(store, processes, containers), snapshot, signals, processes, containers, container }
}

describe('manual service registry', () => {
  it('refreshes only local registered and pending PIDs without caching live state', async () => {
    const f = await fixture()
    const row = await f.manager.register({ kind: 'process', name: 'Server', pid: 12345 })
    await f.store.update(rows => {
      const local = rows[0] as ProcessService
      local.pendingStop = [{ pid: 12346, startedAt: '110' }, { pid: 12345, startedAt: '100' }]
      rows.push({ ...local, id: randomUUID(), host: 'other-host', pid: 99999, pendingStop: [] })
    })
    f.snapshot.set(12346, { pid: 12346, parentPid: 12345, startedAt: '110', alive: true, name: 'child' })
    f.snapshot.delete(12345)
    vi.mocked(f.processes.snapshot).mockClear()
    expect((await f.manager.list()).services.find(service => service.record.id === row.id)).toMatchObject({ status: 'running', remaining: 1 })
    expect(f.processes.snapshot).toHaveBeenLastCalledWith([12345, 12346])
    f.snapshot.delete(12346)
    expect((await f.manager.list()).services[0]?.status).toBe('stopped')
    expect(f.processes.snapshot).toHaveBeenCalledTimes(2)
  })

  it('checks containers while the process snapshot is pending', async () => {
    const f = await fixture()
    await f.manager.register({ kind: 'process', name: 'Server', pid: 12345 })
    await f.manager.register({ kind: 'container', name: 'Redis', container: 'redis' })
    const pending = Promise.withResolvers<Map<number, ProcessInfo>>()
    f.processes.snapshot = vi.fn(() => pending.promise)
    const inspected = Promise.withResolvers<void>()
    f.containers.inspect = vi.fn(async () => { inspected.resolve(); return f.container })
    const listing = f.manager.list()
    try { await inspected.promise }
    finally { pending.resolve(f.snapshot) }
    expect((await listing).services.map(service => service.status)).toEqual(['running', 'running'])
  })

  it('keeps an unsupported normal stop running until a separate explicit force request', async () => {
    const f = await fixture()
    const row = await f.manager.register({ kind: 'process', name: 'Console server', pid: 12345 })
    f.processes.signal = vi.fn(async (target, force) => {
      f.signals.push({ pid: target.pid, force })
      if (!force) throw new NormalStopUnsupportedError()
      f.snapshot.delete(target.pid)
    })
    const normal = await f.manager.stop({ ids: [row.id] })
    expect(normal.results[0]).toMatchObject({ ok: false, code: 'normal-stop-unsupported' })
    expect(normal.results[0]?.message).not.toContain('Error:')
    expect(f.signals).toEqual([{ pid: 12345, force: false }])
    expect((await f.manager.list()).services[0]).toMatchObject({ status: 'running', remaining: 1 })
    expect((await f.store.read())[0]).toMatchObject({ pendingStop: [{ pid: 12345, startedAt: '100' }] })
    expect((await f.manager.stop({ ids: [row.id], force: true })).results[0]?.ok).toBe(true)
    expect(f.signals).toEqual([{ pid: 12345, force: false }, { pid: 12345, force: true }])
  })

  it('persists only identities and metadata and performs no automatic stop', async () => {
    const f = await fixture()
    const row = await f.manager.register({ kind: 'process', name: 'Dev server', pid: 12345, project: 'demo' })
    const content = JSON.parse(await readFile(f.store.file, 'utf8'))
    expect(content.version).toBe(1)
    expect(content.services[0]).toMatchObject({ pid: 12345, startedAt: '100', project: 'demo', tree: false })
    expect(content.services[0]).not.toHaveProperty('status')
    expect((await f.manager.list()).services[0]?.status).toBe('running')
    expect((await new ServiceRegistry(new RegistryStore(f.store.file), f.processes, f.containers).list()).services[0]?.record.id).toBe(row.id)
    await f.manager.remove({ ids: [row.id] })
    expect(f.signals).toEqual([])
    expect(f.containers.stop).not.toHaveBeenCalled()
    expect(await f.store.read()).toEqual([])
    expect(f.snapshot.has(12345)).toBe(true)
  })

  it('refuses PID reuse and cannot kill the replacement', async () => {
    const f = await fixture()
    const row = await f.manager.register({ kind: 'process', name: 'Server', pid: 12345 })
    f.snapshot.get(12345)!.startedAt = '200'
    expect((await f.manager.list()).services[0]?.status).toBe('changed')
    expect((await f.manager.stop({ ids: [row.id], force: true })).results[0]?.ok).toBe(false)
    expect(f.signals).toEqual([])
  })

  it('keeps inaccessible identity unknown and refuses stop', async () => {
    const f = await fixture()
    const row = await f.manager.register({ kind: 'process', name: 'Server', pid: 12345 })
    f.snapshot.get(12345)!.startedAt = null
    expect((await f.manager.list()).services[0]?.status).toBe('unknown')
    expect((await f.manager.stop({ ids: [row.id] })).results[0]?.ok).toBe(false)
    expect(f.signals).toEqual([])
  })

  it('rejects absent processes, invalid input, duplicates and Harness registration', async () => {
    const f = await fixture()
    await expect(f.manager.register({ kind: 'process', name: 'missing', pid: 100 })).rejects.toThrow()
    await expect(f.manager.register({ kind: 'process', name: 'bad', pid: 0 })).rejects.toThrow()
    await expect(f.manager.register({ kind: 'process', name: 'Harness', pid: process.pid })).rejects.toThrow()
    await expect(f.manager.register({ kind: 'process', name: 'url', pid: 12345, url: 'javascript:alert(1)' })).rejects.toThrow()
    await f.manager.register({ kind: 'process', name: 'Server', pid: 12345 })
    await expect(f.manager.register({ kind: 'process', name: 'Again', pid: 12345 })).rejects.toThrow('already registered')
  })

  it('only stops the root by default and handles repeated stops', async () => {
    const f = await fixture()
    f.snapshot.set(12346, { pid: 12346, parentPid: 12345, startedAt: '110', alive: true, name: 'child' })
    const row = await f.manager.register({ kind: 'process', name: 'Server', pid: 12345 })
    expect((await f.manager.stop({ ids: [row.id] })).results[0]?.ok).toBe(true)
    expect(f.signals).toEqual([{ pid: 12345, force: false }])
    expect(f.snapshot.has(12346)).toBe(true)
    expect((await f.manager.stop({ ids: [row.id] })).results[0]?.ok).toBe(true)
    expect((await f.manager.list()).services[0]?.status).toBe('stopped')
  })

  it('retains orphan identities after a partial normal stop for explicit force', async () => {
    const f = await fixture()
    f.snapshot.set(12346, { pid: 12346, parentPid: 12345, startedAt: '110', alive: true, name: 'child' })
    const row = await f.manager.register({ kind: 'process', name: 'Tree', pid: 12345, tree: true })
    f.processes.signal = vi.fn(async (target, force) => {
      f.signals.push({ pid: target.pid, force })
      if (target.pid === 12345 || force) f.snapshot.delete(target.pid)
    })
    expect((await f.manager.stop({ ids: [row.id] })).results[0]?.ok).toBe(false)
    expect(f.signals).toEqual([{ pid: 12346, force: false }, { pid: 12345, force: false }])
    expect((await f.manager.list()).services[0]?.remaining).toBe(1)
    // A new process takes the old parent's PID; it must survive the next stop.
    f.snapshot.set(12345, { pid: 12345, parentPid: 1, startedAt: '300', alive: true, name: 'replacement' })
    expect((await f.manager.stop({ ids: [row.id], force: true })).results[0]?.ok).toBe(true)
    expect(f.snapshot.has(12345)).toBe(true)
    expect(f.snapshot.has(12346)).toBe(false)
  })

  it('does not stop a tree with an inaccessible child or a Harness descendant', async () => {
    const f = await fixture()
    f.snapshot.set(12346, { pid: 12346, parentPid: 12345, startedAt: null, alive: true, name: 'child' })
    const row = await f.manager.register({ kind: 'process', name: 'Tree', pid: 12345, tree: true })
    expect((await f.manager.stop({ ids: [row.id] })).results[0]?.ok).toBe(false)
    f.snapshot.delete(12346)
    f.snapshot.set(process.pid, { pid: process.pid, parentPid: 12345, startedAt: '200', alive: true, name: 'Harness' })
    expect((await f.manager.stop({ ids: [row.id] })).results[0]?.ok).toBe(false)
    expect(f.signals).toEqual([])
  })

  it('binds a full container ID and the selected context, leaving data intact', async () => {
    const f = await fixture()
    const row = await f.manager.register({ kind: 'container', name: 'Redis', container: 'redis' })
    expect(row).toMatchObject({ containerId: 'a'.repeat(64), context: 'desktop-linux' })
    expect((await f.manager.stop({ ids: [row.id] })).results[0]?.ok).toBe(true)
    expect(f.containers.stop).toHaveBeenCalledWith('desktop-linux', 'a'.repeat(64), false)
    expect((await f.manager.list()).services[0]?.status).toBe('stopped')
    expect(await f.store.read()).toHaveLength(1)
  })

  it('distinguishes Docker unavailability from a missing container', async () => {
    const f = await fixture()
    await f.manager.register({ kind: 'container', name: 'Redis', container: 'redis' })
    f.containers.inspect = vi.fn(async () => { throw new Error('Docker unavailable') })
    expect((await f.manager.list()).services[0]?.status).toBe('unknown')
    f.containers.inspect = vi.fn(async () => null)
    expect((await f.manager.list()).services[0]?.status).toBe('stopped')
  })

  it('reports each selected service independently', async () => {
    const f = await fixture()
    const row = await f.manager.register({ kind: 'process', name: 'Server', pid: 12345 })
    const result = await f.manager.stop({ ids: [randomUUID(), row.id, row.id] })
    expect(result.results.map(row => row.ok)).toEqual([false, true])
    expect(f.signals).toHaveLength(1)
  })
})

describe('file coordination', () => {
  it('serializes concurrent writers across registry instances without losing changes', async () => {
    const f = await fixture()
    const stores = [f.store, new RegistryStore(f.store.file)]
    await Promise.all(Array.from({ length: 16 }, (_, index) => stores[index % 2]!.update(rows => {
      rows.push({ id: randomUUID(), kind: 'process', name: `Service ${index}`, pid: 20000 + index, startedAt: String(index + 1), host: 'test-host', tree: false, pendingStop: [], project: '', session: '', url: '', createdAt: new Date().toISOString() })
    })))
    expect(await f.store.read()).toHaveLength(16)
  })

  it('never overwrites malformed or unsupported registry data', async () => {
    const f = await fixture()
    for (const content of ['{broken', '{"version":2,"services":[]}', '{"version":1,"services":[{}]}']) {
      await writeFile(f.store.file, content)
      await expect(f.store.update(rows => rows.splice(0))).rejects.toThrow()
      expect(await readFile(f.store.file, 'utf8')).toBe(content)
    }
  })
})

describe('process parsing and traversal', () => {
  it('reads Linux start ticks with whitespace and parentheses inside process names', () => {
    const fields = ['S', '12', ...Array(17).fill('0'), '123456', '0']
    expect(parseLinuxStat(34, `34 (a name (test)) ${fields.join(' ')}`, 'boot')).toMatchObject({ pid: 34, parentPid: 12, startedAt: 'boot:123456', name: 'a name (test)', alive: true })
    fields[0] = 'Z'
    expect(parseLinuxStat(34, `34 (zombie) ${fields.join(' ')}`, 'boot').alive).toBe(false)
  })
  it('orders deep descendants before the root and tolerates cycles', () => {
    const rows = new Map<number, ProcessInfo>([
      [10, { pid: 10, parentPid: 12, startedAt: '100', name: '', alive: true }],
      [11, { pid: 11, parentPid: 10, startedAt: '110', name: '', alive: true }],
      [12, { pid: 12, parentPid: 11, startedAt: '120', name: '', alive: true }],
    ])
    expect(processTargets({ pid: 10, startedAt: '100' }, rows, true).map(row => row.pid)).toEqual([12, 11, 10])
  })
  it('excludes an old Windows child whose creator PID has been reused', () => {
    const rows = new Map<number, ProcessInfo>([
      [10, { pid: 10, parentPid: 1, startedAt: '200', name: '', alive: true }],
      [11, { pid: 11, parentPid: 10, startedAt: '100', name: '', alive: true }],
    ])
    expect(processTargets({ pid: 10, startedAt: '200' }, rows, true).map(row => row.pid)).toEqual([10])
  })
})
