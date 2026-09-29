import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AutomaticServices, installAutomatic } from '../src/automatic.ts'
import type { HostJob, Jobs } from '../src/automatic.ts'
import { RegistryStore } from '../src/store.ts'
import { ServiceRegistry } from '../src/manager.ts'
import { decodeOwner, encodeOwner, ownerFromEnvironment } from '../src/ownership.ts'
import type { OwnedProcess } from '../src/discover-processes.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'auto-services-'))
  dirs.push(dir)
  const store = new RegistryStore(join(dir, 'services.json'))
  let rows: OwnedProcess[] = []
  const auto = new AutomaticServices(store, () => ({ list: () => [{ header: { id: 'session-a', cwd: 'C:/workspace' } }] }), async () => rows)
  const marker = encodeOwner(auto.key, { session: 'session-a', project: 'C:/workspace', call: 'call-a' })
  const process = (pid: number, parentPid = 1, startedAt = '100'): OwnedProcess => ({ pid, parentPid, startedAt, name: 'server', alive: true, marker })
  return { dir, store, auto, process, set: (next: OwnedProcess[]) => { rows = next } }
}

function fakeJobs(initial: HostJob[]) {
  let listener: Parameters<Jobs['events']['subscribe']>[1] | undefined
  const data = new Map(initial.map(job => [job.id, job]))
  const jobs: Jobs = {
    list: owner => [...data.values()].filter(job => job.owner === owner),
    get: id => { const job = data.get(id); if (!job) throw new Error('Missing job'); return { ...job } },
    kill: vi.fn(id => { data.get(id)!.status = 'killed'; return 'requested' }),
    wait: async id => jobs.get(id),
    events: { subscribe: (_filter, callback) => { listener = callback; return () => { listener = undefined } } },
  }
  return { jobs, data, emit: (job: HostJob) => { data.set(job.id, job); listener?.({ type: 'registered', job }) } }
}

describe('host automatic discovery', () => {
  it('keeps marked descendants after their launcher exits and deduplicates concurrent refreshes', async () => {
    const f = await fixture()
    f.set([f.process(200), f.process(201, 200, '110')])
    await Promise.all([f.auto.refresh(), f.auto.refresh()])
    expect(await f.store.read()).toMatchObject([{ pid: 200, session: 'session-a', project: 'C:/workspace', tree: true, startedAt: '100' }])
    f.set([f.process(201, 200, '110')])
    await f.auto.refresh()
    expect(await f.store.read()).toHaveLength(2)
    expect((await f.store.read())[1]).toMatchObject({ pid: 201, startedAt: '110' })
  })

  it('ignores foreign markers and never attaches an old child to a recycled parent PID', async () => {
    const f = await fixture()
    f.set([f.process(200, 1, '300'), f.process(201, 200, '110'), { ...f.process(202), marker: encodeOwner('foreign', { session: 'x', project: '', call: '' }) }])
    await f.auto.refresh()
    expect((await f.store.read()).map(row => row.kind === 'process' && row.pid)).toEqual([200, 201])
  })

  it('includes already-running shell jobs, observes new jobs, and detaches without cancellation', async () => {
    const f = await fixture()
    const job: HostJob = { id: 'bash-1', kind: 'bash', owner: 'session-a', label: 'npm run build', status: 'running', startedAt: 1 }
    const fake = fakeJobs([job, { ...job, id: 'subagent-1', kind: 'subagent' }])
    const dispose = f.auto.attachJobs(fake.jobs)
    expect((await f.auto.list()).map(row => row.record)).toMatchObject([{ kind: 'job', project: 'C:/workspace', session: 'session-a' }])
    fake.emit({ ...job, id: 'pwsh-1', kind: 'pwsh' })
    expect(await f.auto.list()).toHaveLength(2)
    fake.data.get('bash-1')!.status = 'completed'
    expect(await f.auto.list()).toHaveLength(1)
    dispose()
    expect(fake.jobs.kill).not.toHaveBeenCalled()
  })

  it('only cancels an explicitly selected job and rejects reused host job identities', async () => {
    const f = await fixture()
    const fake = fakeJobs([{ id: 'bash-1', kind: 'bash', owner: 'session-a', label: 'build', status: 'running', startedAt: 1 }])
    f.auto.attachJobs(fake.jobs)
    const id = (await f.auto.list())[0]!.record.id
    fake.data.get('bash-1')!.startedAt = 2
    await expect(f.auto.stop(id)).rejects.toThrow('identity changed')
    expect(fake.jobs.kill).not.toHaveBeenCalled()
    fake.data.get('bash-1')!.startedAt = 1
    const manager = new ServiceRegistry(f.store)
    manager.discovery = f.auto
    expect(await manager.stop({ ids: [id] })).toMatchObject({ results: [{ ok: true }] })
    expect(fake.jobs.kill).toHaveBeenCalledWith('bash-1', 'session-a', 'cancelled by the user')
  })

  it('keeps live work under its job controller and persists surviving processes after settlement', async () => {
    const f = await fixture()
    const fake = fakeJobs([])
    f.auto.attachJobs(fake.jobs)
    f.auto.call.run('call-a', () => fake.emit({ id: 'bash-1', kind: 'bash', owner: 'session-a', label: 'server', status: 'running', startedAt: 1 }))
    expect(await f.auto.list()).toHaveLength(1)
    f.set([f.process(200)])
    await f.auto.refresh()
    expect(await f.auto.list()).toHaveLength(1)
    expect(await f.store.read()).toEqual([])
    fake.data.get('bash-1')!.status = 'completed'
    await f.auto.refresh()
    expect(await f.auto.list()).toHaveLength(0)
    expect(await f.store.read()).toMatchObject([{ pid: 200, session: 'session-a' }])
  })

  it('uses the host environment extension without adding a model tool call', async () => {
    const f = await fixture()
    const ctx = new Context()
    const register = vi.fn(() => vi.fn())
    ctx.provide('shellEnv', { register })
    try {
      const fiber = ctx.plugin((child: Context) => { installAutomatic(child, f.store) })
      await fiber
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(register).toHaveBeenCalledTimes(1)
      const contribution = register.mock.calls[0]![0] as any
      const env = contribution.resolve({ callId: 'call', agent: { id: 'session-a', session: { header: { cwd: 'C:/workspace' } } } })
      expect(decodeOwner(f.auto.key, env.DSH_SERVICE_OWNER)).toEqual({ project: 'C:/workspace', session: 'session-a', call: 'call' })
      await fiber.dispose()
    } finally { await ctx.fiber.dispose() }
  })

  it('never returns unrelated environment values or malformed markers', () => {
    expect(ownerFromEnvironment('SECRET=private\0DSH_SERVICE_OWNER=abc\0')).toBe('abc')
    expect(decodeOwner('key', 'key.not-json')).toBeUndefined()
    expect(decodeOwner('key', encodeOwner('other', { project: '', session: '', call: '' }))).toBeUndefined()
  })
})
