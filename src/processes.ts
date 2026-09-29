import { readdir, readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { powershell } from './command.ts'
import { NormalStopUnsupportedError } from './errors.ts'
import type { ProcessAdapter, ProcessIdentity, ProcessInfo } from './types.ts'

export function parseLinuxStat(pid: number, text: string, boot: string): ProcessInfo {
  const end = text.lastIndexOf(')')
  if (end < 0) throw new Error('Malformed process stat')
  const fields = text.slice(end + 2).trim().split(/\s+/)
  if (!fields[19] || !fields[1]) throw new Error('Incomplete process stat')
  return { pid, parentPid: Number(fields[1]), startedAt: `${boot}:${fields[19]}`, name: text.slice(text.indexOf('(') + 1, end), alive: fields[0] !== 'Z' && fields[0] !== 'X' }
}

/** Collect children before parents without guessing ownership from ports or names. */
export function processTargets(root: ProcessIdentity, snapshot: Map<number, ProcessInfo>, tree: boolean): ProcessIdentity[] {
  const current = snapshot.get(root.pid)
  if (!current?.alive || current.startedAt !== root.startedAt) return []
  const visited = new Set<number>()
  const targets: ProcessIdentity[] = []
  const visit = (info: ProcessInfo): void => {
    if (visited.has(info.pid)) return
    visited.add(info.pid)
    if (tree) for (const child of snapshot.values()) {
      // Windows keeps the creator PID after its exit. A process older than
      // the current parent instance is not its child (the creator PID was reused).
      if (child.parentPid === info.pid && child.alive && child.startedAt && isNewerChild(child.startedAt, info.startedAt!)) visit(child)
    }
    if (info.startedAt) targets.push({ pid: info.pid, startedAt: info.startedAt })
  }
  visit(current)
  return targets
}

function isNewerChild(child: string, parent: string): boolean {
  if (/^\d+$/.test(child) && /^\d+$/.test(parent)) return BigInt(child) >= BigInt(parent)
  const childParts = child.split(':')
  const parentParts = parent.split(':')
  if (childParts.length === 2 && parentParts.length === 2 && childParts[0] === parentParts[0] && /^\d+$/.test(childParts[1]!) && /^\d+$/.test(parentParts[1]!)) return BigInt(childParts[1]!) >= BigInt(parentParts[1]!)
  return Number.isFinite(Date.parse(child)) && Date.parse(child) >= Date.parse(parent)
}

export class NativeProcesses implements ProcessAdapter {
  readonly host = `${process.platform}:${hostname()}`

  async snapshot(pids?: readonly number[]): Promise<Map<number, ProcessInfo>> {
    const selected = pids === undefined ? undefined : [...new Set(pids)]
    if (selected?.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Invalid process ID')
    if (selected?.length === 0) return new Map()
    if (process.platform === 'win32') {
      // Listing needs creation identities, not a machine-wide WMI process tree.
      const output = await powershell(selected ? `$rows=@(foreach ($targetId in @(${selected.join(',')})) {
        try { $p=[System.Diagnostics.Process]::GetProcessById($targetId) }
        catch [System.ArgumentException] { continue }
        try {
          $stamp=$null
          try { $stamp=$p.StartTime.ToUniversalTime().Ticks.ToString() } catch {}
          [pscustomobject]@{pid=$targetId;parentPid=0;startedAt=$stamp;name=$p.ProcessName;alive=$true}
        } finally { $p.Dispose() }
      }); ConvertTo-Json -InputObject $rows -Compress` : `$stamps=@{}
      Get-Process | ForEach-Object { try { $stamps[$_.Id]=$_.StartTime.ToUniversalTime().Ticks.ToString() } catch {} }
      $rows=@(Get-CimInstance Win32_Process | ForEach-Object {
        $stamp=$stamps[[int]$_.ProcessId]
        [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;startedAt=$stamp;name=$_.Name;alive=$true}
      }); ConvertTo-Json -InputObject $rows -Compress`)
      const rows = JSON.parse(output) as ProcessInfo[]
      if (!Array.isArray(rows)) throw new Error('Unexpected process snapshot')
      return new Map(rows.filter(row => row.pid > 0).map(row => [row.pid, row]))
    }
    if (process.platform === 'linux') {
      const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
      const names = selected?.map(String) ?? (await readdir('/proc')).filter(name => /^\d+$/.test(name))
      const rows = await Promise.all(names.map(async name => {
        try { return parseLinuxStat(Number(name), await readFile(`/proc/${name}/stat`, 'utf8'), boot) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return null
          // An inaccessible process is present, but its identity cannot be checked.
          return { pid: Number(name), parentPid: 0, startedAt: null, name: '', alive: true }
        }
      }))
      return new Map(rows.filter((row): row is ProcessInfo => row !== null).map(row => [row.pid, row]))
    }
    throw new Error(`Unsupported process platform: ${process.platform}`)
  }

  async signal(target: ProcessIdentity, force: boolean): Promise<void> {
    if (target.pid <= 1 || target.pid === process.pid || !Number.isSafeInteger(target.pid)) throw new Error('Refusing to stop the Harness or a system process')
    if (process.platform === 'win32') {
      if (!/^\d+$/.test(target.startedAt)) throw new Error('Invalid process creation identity')
      const outcome = await powershell(`try { $p=Get-Process -Id ${target.pid} -ErrorAction Stop } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { exit 0 }
        if ($p.StartTime.ToUniversalTime().Ticks.ToString() -ne '${target.startedAt}') { throw 'Process identity changed; stop refused' }
        if (${force ? '$true' : '$false'}) { $p.Kill() }
        elseif (-not $p.CloseMainWindow()) { [Console]::Out.Write('normal-stop-unsupported') }`)
      if (outcome === 'normal-stop-unsupported') throw new NormalStopUnsupportedError()
      return
    }
    const current = (await this.snapshot()).get(target.pid)
    if (!current?.alive) return
    if (!current.startedAt || current.startedAt !== target.startedAt) throw new Error('Process identity changed; stop refused')
    try { process.kill(target.pid, force ? 'SIGKILL' : 'SIGTERM') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
}
