import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { discoverProcesses } from '../src/discover-processes.ts'
import { NativeProcesses } from '../src/processes.ts'

describe('native inherited ownership', () => {
  it('finds a detached child after its launcher exits, with the exact stop identity', async () => {
    const marker = `service-discovery-${process.pid}`
    const code = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});console.log(child.pid);child.unref()`
    const parent = spawn(process.execPath, ['-e', code], { env: { ...process.env, DSH_SERVICE_OWNER: marker }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    parent.stdout.on('data', chunk => { output += chunk })
    await once(parent, 'close')
    const pid = Number(output.trim())
    expect(pid).toBeGreaterThan(1)
    try {
      const discovered = (await discoverProcesses()).find(row => row.pid === pid)
      expect(discovered).toMatchObject({ marker, pid, alive: true })
      const native = await new NativeProcesses().snapshot([pid])
      expect(discovered?.startedAt).toBe(native.get(pid)?.startedAt)
    } finally { try { process.kill(pid, 'SIGKILL') } catch {} }
  }, 15_000)
})
