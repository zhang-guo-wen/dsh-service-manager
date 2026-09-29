/** A manual normal stop cannot be delivered to a Windows console process. */
export class NormalStopUnsupportedError extends Error {
  readonly code = 'normal-stop-unsupported' as const

  constructor() {
    super('This Windows process has no window that accepts a close request. It is still running; use explicit force stop if needed.')
  }
}

/** Preserve command diagnostics without adding repeated Error prefixes. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
