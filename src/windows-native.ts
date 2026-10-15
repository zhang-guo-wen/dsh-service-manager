import { basename } from 'node:path'
import { ownerFromEnvironment } from './ownership.ts'
import type { ProcessRow } from './types.ts'

/**
 * Native Windows process reads shared by discovery and identity checks. The
 * reader replaces one PowerShell process per page refresh and one whole-table
 * WMI query per stop with synchronous kernel32/ntdll calls.
 */
export interface WindowsNativeApi {
  /**
   * Read process rows through kernel32/ntdll.
   * @param pids - exact PIDs to read; undefined reads the whole process table.
   * @param markers - whether to read each process environment block and attach any ownership marker found.
   * @returns one row per readable process, in enumeration order; unmarked rows carry no marker field.
   */
  snapshot(pids?: readonly number[], markers?: boolean): ProcessRow[]
}

/** The native reader needs an x64 Windows process for its PEB layout and FFI. */
export function windowsNativeSupported(): boolean {
  return process.platform === 'win32' && process.arch === 'x64'
}

let api: WindowsNativeApi | undefined
let loading: Promise<WindowsNativeApi> | undefined

/** Load the native reader once; a failed load stays retryable. */
export function loadWindowsNative(): Promise<WindowsNativeApi> {
  if (api) return Promise.resolve(api)
  loading ??= createWindowsNative().then(
    created => (api = created),
    error => { loading = undefined; throw error },
  )
  return loading
}

/* koffi bindings are untyped by design; the loader validates them at runtime. */
async function createWindowsNative(): Promise<WindowsNativeApi> {
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
  const times = kernel.func('int __stdcall GetProcessTimes(void *handle, void *created, void *exit, void *kernelTime, void *userTime)')
  const image = kernel.func('int __stdcall QueryFullProcessImageNameW(void *handle, uint32_t flags, void *name, void *size)')

  // SYNCHRONIZE carries the liveness wait; QUERY_LIMITED_INFORMATION covers
  // basic information, creation time, and the image name. Reading the
  // environment block additionally needs PROCESS_VM_READ.
  const QUERY_ONLY = 0x100000 | 0x1000
  const QUERY_AND_READ = 0x100000 | 0x1000 | 0x400 | 0x10
  const STILL_ACTIVE = 258
  // FILETIME to .NET ticks, the unit the PowerShell fallback returns.
  const TICKS_EPOCH_OFFSET = 504911232000000000n

  const table = (): number[] => {
    const ids = Buffer.alloc(4 * 65536)
    const used = Buffer.alloc(4)
    if (!enumerate(ids, ids.length, used)) throw new Error('Cannot enumerate process ownership')
    const rows: number[] = []
    for (let offset = 0; offset < used.readUInt32LE(); offset += 4) {
      const pid = ids.readUInt32LE(offset)
      if (pid > 0) rows.push(pid)
    }
    return rows
  }

  const inspect = (pid: number, handle: unknown, markers: boolean): ProcessRow | undefined => {
    if (wait(handle, 0) !== STILL_ACTIVE) return
    const basic = Buffer.alloc(48)
    const hasBasic = query(handle, 0, basic, basic.length, null) === 0
    let marker: string | undefined
    // Locating the environment block needs the PEB; without it the row keeps its
    // identity and reports no ownership evidence.
    if (markers && hasBasic) {
      const wow = Buffer.alloc(8)
      if (query(handle, 26, wow, wow.length, null) === 0) {
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
        let address = parameters && pointer(parameters + (narrow ? 0x48n : 0x80n))
        let environment = ''
        for (let length = 0; address && length < 256 * 1024;) {
          const size = 4096 - Number(address % 4096n)
          const bytes = memory(address, size)
          if (!bytes) break
          environment += bytes.toString('utf16le')
          const end = environment.indexOf('\0\0')
          if (end >= 0) { environment = environment.slice(0, end); break }
          address += BigInt(size)
          length += size
        }
        marker = environment ? ownerFromEnvironment(environment) : undefined
      }
    }
    // A live process with an unreadable creation time keeps a null identity, so
    // callers refuse to stop it instead of treating it as already gone.
    const created = Buffer.alloc(8)
    const hasTimes = times(handle, created, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)) !== 0
    const name = Buffer.alloc(65536)
    const size = Buffer.alloc(4)
    size.writeUInt32LE(name.length / 2)
    const path = image(handle, 0, name, size) ? name.subarray(0, size.readUInt32LE() * 2).toString('utf16le') : ''
    if (wait(handle, 0) !== STILL_ACTIVE) return
    return {
      pid,
      parentPid: hasBasic ? Number(basic.readBigUInt64LE(40)) : 0,
      startedAt: hasTimes ? (created.readBigUInt64LE() + TICKS_EPOCH_OFFSET).toString() : null,
      name: basename(path) || `PID ${pid}`,
      alive: true,
      ...marker === undefined ? {} : { marker },
    }
  }

  return {
    snapshot(pids, markers = false): ProcessRow[] {
      const rows: ProcessRow[] = []
      for (const pid of pids ?? table()) {
        if (pid <= 0) continue
        const handle = open(markers ? QUERY_AND_READ : QUERY_ONLY, 0, pid)
        if (!handle) continue
        try {
          const row = inspect(pid, handle, markers)
          if (row) rows.push(row)
        } finally { close(handle) }
      }
      return rows
    },
  }
}
