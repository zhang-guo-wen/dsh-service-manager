import { execFile } from 'node:child_process'

export type Runner = (file: string, args: string[], timeout?: number) => Promise<string>
export const run: Runner = (file, args, timeout = 15_000) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, shell: false, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${file}: ${stderr.trim() || error.message}`))
    else resolve(stdout.trim().replace(/^\uFEFF/, ''))
  })
})

/** Encode scripts so quoting and a user's shell cannot change their meaning. */
export function powershell(script: string, runner: Runner = run): Promise<string> {
  return runner('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(
    `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); try { ${script} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
    'utf16le',
  ).toString('base64')])
}
