import { readFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { registrySchema } from './schema.ts'
import type { ServiceRecord } from './types.ts'

/** Re-read under a cross-process lock; never silently replace a damaged file. */
export class RegistryStore {
  readonly file: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(file: string) { this.file = resolve(file) }

  async read(): Promise<ServiceRecord[]> {
    let content: string
    try { content = await readFile(this.file, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return registrySchema.parse(JSON.parse(content)).services
  }

  update<T>(work: (rows: ServiceRecord[]) => T | Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      return withFileLock(this.file, async () => {
        const rows = await this.read()
        const value = await work(rows)
        const registry = registrySchema.parse({ version: 1, services: rows })
        await writeFileAtomic(this.file, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
        return value
      }, { waitMs: 60_000 })
    })
    this.queue = result.catch(() => {})
    return result
  }
}
