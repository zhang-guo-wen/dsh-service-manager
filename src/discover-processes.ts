import { readFile, readdir } from 'node:fs/promises'
import { parseLinuxStat } from './processes.ts'
import { ownerFromEnvironment } from './ownership.ts'
import { loadWindowsNative, windowsNativeSupported } from './windows-native.ts'
import type { ProcessRow } from './types.ts'

export interface OwnedProcess extends ProcessRow { marker: string }

/**
 * Read the process table with parentage and the inherited ownership marker.
 * Windows uses native kernel reads; Linux reads `/proc`. Platforms without an
 * implementation report no rows, so every caller degrades to jobs and containers.
 */
export async function inspectProcesses(): Promise<ProcessRow[]> {
  if (process.platform === 'linux') return inspectLinux()
  if (!windowsNativeSupported()) return []
  return (await loadWindowsNative()).snapshot(undefined, true)
}

/** Inspect inherited ownership even when the original shell has already exited. */
export async function discoverProcesses(): Promise<OwnedProcess[]> {
  return (await inspectProcesses()).filter((row): row is OwnedProcess => Boolean(row.marker))
}

async function inspectLinux(): Promise<ProcessRow[]> {
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  const names = (await readdir('/proc')).filter(name => /^\d+$/.test(name))
  const rows = await Promise.all(names.map(async (name): Promise<ProcessRow | undefined> => {
    const pid = Number(name)
    if (pid <= 1 || pid === process.pid) return
    let row: ProcessRow
    try { row = parseLinuxStat(pid, await readFile(`/proc/${pid}/stat`, 'utf8'), boot) }
    catch { return }
    if (!row.alive) return
    try {
      const marker = ownerFromEnvironment(await readFile(`/proc/${pid}/environ`, 'utf8'))
      if (marker) row.marker = marker
    } catch { /* A process whose environment is unreadable still keeps its identity. */ }
    return row
  }))
  return rows.filter((row): row is ProcessRow => row !== undefined)
}
