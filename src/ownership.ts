import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export const OWNER_ENV = 'DSH_SERVICE_OWNER'
export interface Ownership { project: string; session: string; call: string }
export function registryKey(file: string): string {
  const path = resolve(file)
  return createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex').slice(0, 24)
}
export function encodeOwner(key: string, owner: Ownership): string {
  return `${key}.${Buffer.from(JSON.stringify(owner)).toString('base64url')}`
}
export function decodeOwner(key: string, value: string): Ownership | undefined {
  if (!value.startsWith(`${key}.`) || value.length > 8192) return
  try {
    const owner = JSON.parse(Buffer.from(value.slice(key.length + 1), 'base64url').toString()) as Ownership
    if (['project', 'session', 'call'].every(key => typeof owner[key as keyof Ownership] === 'string' && owner[key as keyof Ownership].length <= 512)) return owner
  } catch {}
}

/** Only the ownership marker leaves the environment reader; other values are discarded. */
export function ownerFromEnvironment(environment: string): string | undefined {
  return environment.split('\0').find(entry => entry.startsWith(`${OWNER_ENV}=`))?.slice(OWNER_ENV.length + 1)
}
