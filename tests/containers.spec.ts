import { describe, expect, it, vi } from 'vitest'
import { DockerContainers } from '../src/containers.ts'
const id = 'b'.repeat(64)
const response = (phase = 'running') => [id, '/redis', phase === 'running', phase, 'no'].map(item => JSON.stringify(item)).join('|')

describe('Docker adapter', () => {
  it('queries only nonsecret fields and distinguishes gone from unreachable', async () => {
    const runner = vi.fn(async () => response())
    const adapter = new DockerContainers(runner)
    expect(await adapter.inspect('default', 'redis')).toMatchObject({ id, running: true })
    expect(runner.mock.calls[0]?.[1]).toContain('--context')
    runner.mockRejectedValueOnce(new Error('docker: No such container: redis'))
    expect(await adapter.inspect('default', 'redis')).toBeNull()
    runner.mockRejectedValueOnce(new Error('Cannot connect to the Docker daemon'))
    await expect(adapter.inspect('default', 'redis')).rejects.toThrow('Cannot connect')
  })
  it('normal stop has no implicit force timeout; force is a separate command', async () => {
    const runner = vi.fn(async () => response())
    const adapter = new DockerContainers(runner)
    await adapter.stop('default', id, false)
    expect(runner).toHaveBeenLastCalledWith('docker', ['--context', 'default', 'container', 'stop', '--timeout', '-1', id], 12_000)
    await adapter.stop('default', id, true)
    expect(runner).toHaveBeenLastCalledWith('docker', ['--context', 'default', 'container', 'kill', id], 12_000)
    expect(runner.mock.calls.some(call => JSON.stringify(call).includes('"rm"'))).toBe(false)
  })
  it('rejects incomplete stop IDs, options disguised as names, and changed identities', async () => {
    const runner = vi.fn(async () => response())
    const adapter = new DockerContainers(runner)
    await expect(adapter.stop('default', id.slice(0, 12), true)).rejects.toThrow('complete')
    await expect(adapter.inspect('default', '--help')).rejects.toThrow('Invalid')
    await expect(adapter.inspect('--host', 'redis')).rejects.toThrow('Invalid')
    await expect(adapter.stop('default', 'a'.repeat(64), true)).rejects.toThrow('identity changed')
    expect(runner).toHaveBeenCalledTimes(1)
  })
})
