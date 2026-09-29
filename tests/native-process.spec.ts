import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { NativeProcesses } from '../src/processes.ts'
import { NormalStopUnsupportedError } from '../src/errors.ts'
import { powershell } from '../src/command.ts'

describe('native process adapter', () => {
  it('queries a real child identity, rejects a stale identity, and explicitly stops the child', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
    await once(child, 'spawn')
    const adapter = new NativeProcesses()
    try {
      const info = (await adapter.snapshot()).get(child.pid!)!
      expect(info).toMatchObject({ pid: child.pid, parentPid: process.pid, alive: true })
      expect(info.startedAt).toBeTruthy()
      const selected = await adapter.snapshot([child.pid!, child.pid!])
      expect([...selected.keys()]).toEqual([child.pid])
      expect(selected.get(child.pid!)).toMatchObject({ startedAt: info.startedAt, alive: true })
      expect(await adapter.snapshot([])).toEqual(new Map())
      await expect(adapter.snapshot([1.5])).rejects.toThrow('Invalid process ID')
      const stale = process.platform === 'win32' ? '1' : 'invalid'
      await expect(adapter.signal({ pid: child.pid!, startedAt: stale }, true)).rejects.toThrow('identity changed')
      expect(child.exitCode).toBeNull()
      if (process.platform === 'win32') {
        await expect(adapter.signal({ pid: child.pid!, startedAt: info.startedAt! }, false)).rejects.toBeInstanceOf(NormalStopUnsupportedError)
        expect((await adapter.snapshot([child.pid!])).get(child.pid!)?.alive).toBe(true)
      }
      const exit = once(child, 'exit')
      await adapter.signal({ pid: child.pid!, startedAt: info.startedAt! }, true)
      await exit
      expect((await adapter.snapshot([child.pid!])).get(child.pid!)?.alive ?? false).toBe(false)
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  }, 30_000)

  it.runIf(process.platform === 'win32')('returns plain Unicode diagnostics without PowerShell progress or CLIXML', async () => {
    await expect(powershell("Write-Progress -Activity 'Preparing module' -Status 'Running'; throw '测试错误 & diagnostic'")).rejects.toThrow(/^powershell\.exe: 测试错误 & diagnostic$/)
  }, 15_000)
})
