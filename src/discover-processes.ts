import { readFile, readdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseLinuxStat } from './processes.ts'
import { ownerFromEnvironment } from './ownership.ts'
import type { ProcessInfo } from './types.ts'

export interface OwnedProcess extends ProcessInfo { marker: string }
let windowsReader: (() => OwnedProcess[]) | undefined

/** Inspect inherited ownership even when the original shell has already exited. */
export async function discoverProcesses(): Promise<OwnedProcess[]> {
  if (process.platform === 'linux') {
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    const rows = await Promise.all((await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(async name => {
      try {
        const marker = ownerFromEnvironment(await readFile(`/proc/${name}/environ`, 'utf8'))
        if (!marker) return
        const row = parseLinuxStat(Number(name), await readFile(`/proc/${name}/stat`, 'utf8'), boot)
        return row.alive ? { ...row, marker } : undefined
      } catch { return undefined }
    }))
    return rows.filter((row): row is OwnedProcess => row !== undefined)
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') return []
  if (!windowsReader) windowsReader = await createWindowsReader()
  return windowsReader()
}

async function createWindowsReader(): Promise<() => OwnedProcess[]> {
  const { default: koffi } = await import('koffi')
  const kernel = koffi.load('kernel32.dll')
  const nt = koffi.load('ntdll.dll')
  const psapi = koffi.load('psapi.dll')
  const enumerate = psapi.func('int __stdcall EnumProcesses(void *ids, uint32_t size, void *used)')
  const open = kernel.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)')
  const close = kernel.func('int __stdcall CloseHandle(void *handle)')
  const wait = kernel.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t timeout)')
  const query = nt.func('int32_t __stdcall NtQueryInformationProcess(void *handle, uint32_t kind, void *data, uint32_t size, void *used)')
  const read = kernel.func('int __stdcall ReadProcessMemory(void *handle, void *address, void *data, size_t size, void *used)')
  const times = kernel.func('int __stdcall GetProcessTimes(void *handle, void *created, void *exit, void *kernel, void *user)')
  const image = kernel.func('int __stdcall QueryFullProcessImageNameW(void *handle, uint32_t flags, void *name, void *size)')
  return () => {
    const ids = Buffer.alloc(4 * 65536)
    const used = Buffer.alloc(4)
    if (!enumerate(ids, ids.length, used)) throw new Error('Cannot enumerate process ownership')
    const result: OwnedProcess[] = []
    for (let offset = 0; offset < used.readUInt32LE(); offset += 4) {
      const pid = ids.readUInt32LE(offset)
      if (pid <= 1 || pid === process.pid) continue
      const handle = open(0x100000 | 0x400 | 0x10, 0, pid)
      if (!handle) continue
      try {
        if (wait(handle, 0) !== 258) continue
        const basic = Buffer.alloc(48)
        if (query(handle, 0, basic, basic.length, null) !== 0) continue
        const wow = Buffer.alloc(8)
        if (query(handle, 26, wow, wow.length, null) !== 0) continue
        const narrow = wow.readBigUInt64LE() !== 0n
        const peb = narrow ? wow.readBigUInt64LE() : basic.readBigUInt64LE(8)
        const memory = (address: bigint, size: number): Buffer | undefined => {
          const bytes = Buffer.alloc(size)
          const count = Buffer.alloc(8)
          if (!read(handle, address, bytes, size, count) || count.readBigUInt64LE() !== BigInt(size)) return
          return bytes
        }
        const pointer = (address: bigint): bigint | undefined => {
          const bytes = memory(address, narrow ? 4 : 8)
          return bytes && (narrow ? BigInt(bytes.readUInt32LE()) : bytes.readBigUInt64LE())
        }
        const parameters = pointer(peb + (narrow ? 0x10n : 0x20n))
        if (!parameters) continue
        let address = pointer(parameters + (narrow ? 0x48n : 0x80n))
        if (!address) continue
        let environment = ''
        for (let length = 0; length < 256 * 1024;) {
          const size = 4096 - Number(address % 4096n)
          const bytes = memory(address, size)
          if (!bytes) break
          environment += bytes.toString('utf16le')
          const end = environment.indexOf('\0\0')
          if (end >= 0) { environment = environment.slice(0, end); break }
          address += BigInt(size)
          length += size
        }
        const marker = ownerFromEnvironment(environment)
        if (!marker) continue
        const created = Buffer.alloc(8)
        if (!times(handle, created, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) continue
        const name = Buffer.alloc(65536)
        const size = Buffer.alloc(4)
        size.writeUInt32LE(name.length / 2)
        const path = image(handle, 0, name, size) ? name.subarray(0, size.readUInt32LE() * 2).toString('utf16le') : ''
        if (wait(handle, 0) !== 258) continue
        result.push({ pid, parentPid: Number(basic.readBigUInt64LE(40)), startedAt: (created.readBigUInt64LE() + 504911232000000000n).toString(), name: basename(path) || `PID ${pid}`, alive: true, marker })
      } finally { close(handle) }
    }
    return result
  }
}
