import { run, type Runner } from './command.ts'

/** One listening socket offered for explicit adoption. */
export interface Listener {
  pid: number
  port: number
  protocol: string
  address: string
}

/**
 * Read `netstat -ano` output. The state word stays English on localized
 * Windows installs, but the match stays case-insensitive to tolerate variants.
 */
export function parseWindowsNetstat(output: string): Listener[] {
  const listeners: Listener[] = []
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5 || !/^tcp/i.test(fields[0]!)) continue
    if (!/listen/i.test(fields[3]!)) continue
    const address = fields[1]!
    const port = Number(address.slice(address.lastIndexOf(':') + 1))
    const pid = Number(fields[4])
    if (!Number.isSafeInteger(port) || port <= 0 || !Number.isSafeInteger(pid) || pid <= 0) continue
    listeners.push({ pid, port, protocol: 'TCP', address })
  }
  return listeners
}

/** Read `ss -ltnp` output, where the owning process arrives as `pid=<n>`. */
export function parseLinuxListeners(output: string): Listener[] {
  const listeners: Listener[] = []
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields[0] !== 'LISTEN' || fields.length < 5) continue
    const local = fields[3]!
    const port = Number(local.slice(local.lastIndexOf(':') + 1))
    const pid = Number(/pid=(\d+)/.exec(fields.slice(4).join(' '))?.[1])
    if (!Number.isSafeInteger(port) || port <= 0 || !Number.isSafeInteger(pid) || pid <= 0) continue
    listeners.push({ pid, port, protocol: 'TCP', address: local })
  }
  return listeners
}

/** Keep one row per process and port; a dual-stack listener is one service. */
function dedupe(listeners: readonly Listener[]): Listener[] {
  const seen = new Set<string>()
  const rows: Listener[] = []
  for (const listener of listeners) {
    const key = `${listener.pid}:${listener.port}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(listener)
  }
  return rows.slice(0, 500)
}

/**
 * Read the local listening sockets with their owning PIDs. This is a user-triggered
 * read: it starts an external process, so it never runs on a timer.
 */
export async function listListeners(runner: Runner = run): Promise<Listener[]> {
  if (process.platform === 'win32') return dedupe(parseWindowsNetstat(await runner('netstat', ['-ano'], 10_000)))
  if (process.platform === 'linux') return dedupe(parseLinuxListeners(await runner('ss', ['-ltnpH'], 10_000)))
  throw new Error(`Listening services are not discoverable on ${process.platform}`)
}
