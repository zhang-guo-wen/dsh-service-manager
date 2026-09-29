import { run, type Runner } from './command.ts'
import type { ContainerAdapter, ContainerInfo } from './types.ts'

const referencePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
function checkReference(value: string): void {
  if (!referencePattern.test(value) || value.length > 512) throw new Error('Invalid Docker reference')
}

export class DockerContainers implements ContainerAdapter {
  constructor(private readonly runner: Runner = run) {}

  async resolveContext(context?: string): Promise<string> {
    if (!context && !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) throw new Error('DOCKER_HOST overrides require an explicit named Docker context')
    const selected = context ?? await this.runner('docker', ['context', 'show'])
    checkReference(selected)
    return selected
  }

  async inspect(context: string, reference: string): Promise<ContainerInfo | null> {
    checkReference(context)
    checkReference(reference)
    try {
      const output = await this.runner('docker', ['--context', context, 'container', 'inspect', '--format', '{{json .Id}}|{{json .Name}}|{{json .State.Running}}|{{json .State.Status}}|{{json .HostConfig.RestartPolicy.Name}}', reference])
      const fields: unknown[] = output.split('|').map(part => JSON.parse(part))
      if (fields.length !== 5 || typeof fields[0] !== 'string' || !/^[a-f0-9]{64}$/.test(fields[0]) || typeof fields[1] !== 'string' || typeof fields[2] !== 'boolean' || typeof fields[3] !== 'string' || typeof fields[4] !== 'string') throw new Error('Unexpected Docker response')
      return { id: fields[0], name: fields[1].replace(/^\//, ''), running: fields[2], phase: fields[3], restart: fields[4] }
    } catch (error) {
      if (/No such (?:container|object):/i.test(String(error))) return null
      throw error
    }
  }

  async stop(context: string, id: string, force: boolean): Promise<void> {
    checkReference(context)
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('A complete container ID is required to stop')
    const current = await this.inspect(context, id)
    if (!current) return
    if (current.id !== id) throw new Error('Container identity changed; stop refused')
    if (!current.running) return
    if (current.phase === 'paused' && !force) throw new Error('Container is paused; unpause it or use explicit force stop')
    // An infinite Docker grace period avoids an implicit force kill. The command
    // is bounded locally; a separate explicit force request can interrupt it.
    await this.runner('docker', ['--context', context, 'container', force ? 'kill' : 'stop', ...force ? [] : ['--timeout', '-1'], id], 12_000)
  }
}
