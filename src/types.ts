export interface ProcessIdentity {
  pid: number
  startedAt: string
}

export interface ProcessInfo {
  pid: number
  parentPid: number
  startedAt: string | null
  name: string
  alive: boolean
}

interface Metadata {
  id: string
  name: string
  project: string
  session: string
  url: string
  createdAt: string
}

export interface ProcessService extends Metadata {
  kind: 'process'
  pid: number
  startedAt: string
  host: string
  tree: boolean
  /** Identity-checked targets retained after a manual stop, including orphaned children. */
  pendingStop: ProcessIdentity[]
}

export interface ContainerService extends Metadata {
  kind: 'container'
  containerId: string
  context: string
}

export type ServiceRecord = ProcessService | ContainerService
export interface JobService extends Metadata { kind: 'job'; jobId: string }
export type ServiceStatus = 'running' | 'stopped' | 'unknown' | 'changed'
export interface ServiceView {
  record: ServiceRecord | JobService
  status: ServiceStatus
  detail: string
  remaining: number
}
export interface RegisterRequest {
  kind: 'process' | 'container'
  name: string
  pid?: number
  container?: string
  context?: string
  tree?: boolean
  project?: string
  session?: string
  url?: string
}
export interface StopRequest { ids: string[]; force?: boolean }
export interface RemoveRequest { ids: string[] }
export interface ListRequest {}
export interface ListResult { services: ServiceView[]; file: string; warnings?: string[] }
export interface ServiceDiscovery {
  warnings?: string[]
  refresh(): Promise<void>
  list(): Promise<ServiceView[]>
  stop(id: string): Promise<ActionResult | undefined>
  visible(record: ServiceRecord): boolean
}
export interface ActionResult { id: string; ok: boolean; message: string; code?: 'normal-stop-unsupported' }
export interface MutationResult { results: ActionResult[] }
export interface ContainerInfo {
  id: string
  name: string
  running: boolean
  phase: string
  restart: string
}
export interface ProcessAdapter {
  readonly host: string
  /** Omit pids for a full snapshot with parent relationships. */
  snapshot(pids?: readonly number[]): Promise<Map<number, ProcessInfo>>
  signal(target: ProcessIdentity, force: boolean): Promise<void>
}
export interface ContainerAdapter {
  resolveContext(context?: string): Promise<string>
  inspect(context: string, reference: string): Promise<ContainerInfo | null>
  stop(context: string, id: string, force: boolean): Promise<void>
}
