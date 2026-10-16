// Dev-preview shim for `clsx`. The preview reads the host primitives straight
// out of a harness checkout that has no installed `node_modules`, so this tiny
// equivalent keeps them renderable without pulling a dependency into the plugin.
type ClassValue = string | number | false | null | undefined | ClassValue[] | Record<string, unknown>

export function clsx(...inputs: ClassValue[]): string {
  const out: string[] = []
  for (const input of inputs) {
    if (input === null || input === undefined || input === false || input === '') continue
    if (typeof input === 'string' || typeof input === 'number') { out.push(String(input)); continue }
    if (Array.isArray(input)) { const nested = clsx(...input); if (nested) out.push(nested); continue }
    for (const [key, value] of Object.entries(input)) if (value) out.push(key)
  }
  return out.join(' ')
}

export default clsx
