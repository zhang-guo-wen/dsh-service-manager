import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
describe('built plugin contract', () => {
  it('loads lowered Remote methods and unloads without stopping resources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'service-plugin-'))
    dirs.push(dir)
    const host = await import('../lib/index.mjs')
    const ctx = new Context()
    const registered = new Set<string>()
    ctx.provide('tools', {
      register: (tool: { name: string }) => {
        registered.add(tool.name)
        return () => { registered.delete(tool.name) }
      },
    })
    try {
      const fiber = ctx.plugin(host, { file: join(dir, 'services.json') })
      await fiber
      const service = ctx.get('serviceManager') as any
      expect(service).toBeDefined()
      expect(remoteMethods(service).map(row => row.method)).toEqual(['listServices', 'registerService', 'stopServices', 'removeServices'])
      await vi.waitFor(() => expect([...registered].sort()).toEqual(['service_list', 'service_stop']))
      expect(await service.listServices({})).toEqual({ file: join(dir, 'services.json'), services: [] })
      const stop = vi.spyOn(service.registry, 'stop')
      await fiber.dispose()
      expect(stop).not.toHaveBeenCalled()
      expect(registered.size).toBe(0)
    } finally { await ctx.fiber.dispose() }
  })
  it('ships a browser handoff using only host-resolvable externals', async () => {
    const artifact = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    expect(artifact).toContain('id: "@guowenzhang/dsh-service-manager"')
    const requireCalls = [...artifact.matchAll(/require\(["']([^"']+)["']\)/g)].map(match => match[1]!)
    expect(requireCalls.length).toBeGreaterThan(0)
    expect(requireCalls.every(name => name === 'react' || name.startsWith('react/') || name.startsWith('@deepseek-ai/'))).toBe(true)
    expect(artifact).not.toMatch(/node:|powershell\.exe/)
  })
})
