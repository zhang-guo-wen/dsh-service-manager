import type { ServiceView } from '../types.ts'

export interface SessionGroup { session: string; services: ServiceView[]; running: number; ended: number }
export interface WorkspaceGroup { project: string; sessions: SessionGroup[]; count: number; ended: number }
export interface GroupOptions {
  /** Include records the host no longer reports as running. */
  includeEnded?: boolean
}

interface ProjectPath { key: string; project: string; name: string; windows: boolean }

function projectPath(project: string): ProjectPath | undefined {
  const windows = /^(?:[a-z]:[\\/]|(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+)/i.test(project)
  if (!windows && !project.startsWith('/')) return
  const path = windows ? project.replace(/\\/g, '/') : project
  const normalized = path.replace(/\/+$/, '') || '/'
  return {
    key: `${windows ? 'windows' : 'posix'}:${windows ? normalized.toLowerCase() : normalized}`,
    project,
    name: normalized.split('/').pop() || '',
    windows,
  }
}

// A user-written session label is not sufficient evidence to associate a legacy
// workspace name with a path. Use the complete Harness session identity only.
const sessionIdentity = /^session-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const bareSessionIdentity = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

/**
 * The Harness session a record belongs to, when the record names one. Current
 * sessions carry the `session-` prefix; sessions stored before it are bare
 * UUIDs. A user-written label is never a navigation target.
 */
export function sessionTargetId(session: string): string | undefined {
  return sessionIdentity.test(session) || bareSessionIdentity.test(session) ? session : undefined
}

/** Group services without merging sessions across workspaces. */
export function groupServices(services: readonly ServiceView[], options: GroupOptions = {}): WorkspaceGroup[] {
  const running = services.filter(service => service.status === 'running')
  const visible = options.includeEnded ? services : running
  // Alias evidence stays running-only: an ended record proves nothing about the
  // workspace a legacy service name belongs to.
  const pathsBySession = new Map<string, Map<string, ProjectPath>>()
  for (const { record } of running) {
    const path = projectPath(record.project)
    if (!path || !sessionIdentity.test(record.session)) continue
    let paths = pathsBySession.get(record.session)
    if (!paths) pathsBySession.set(record.session, paths = new Map())
    if (!paths.has(path.key)) paths.set(path.key, path)
  }

  const workspaces = new Map<string, WorkspaceGroup>()
  const sessions = new Map<WorkspaceGroup, Map<string, SessionGroup>>()
  for (const service of visible) {
    const { project, session } = service.record
    let path = projectPath(project)
    if (!path && project && !/[\\/]/.test(project)) {
      const candidates = [...(pathsBySession.get(session)?.values() ?? [])].filter(candidate =>
        candidate.windows ? candidate.name.toLowerCase() === project.toLowerCase() : candidate.name === project)
      if (candidates.length === 1) path = candidates[0]
    }
    const key = path?.key ?? `label:${project}`
    let workspace = workspaces.get(key)
    if (!workspace) {
      workspace = { project: path?.project ?? project, sessions: [], count: 0, ended: 0 }
      workspaces.set(key, workspace)
      sessions.set(workspace, new Map())
    }
    const account = sessions.get(workspace)!
    let group = account.get(session)
    if (!group) {
      group = { session, services: [], running: 0, ended: 0 }
      account.set(session, group)
      workspace.sessions.push(group)
    }
    group.services.push(service)
    if (service.status === 'running') {
      group.running++
      workspace.count++
    } else {
      group.ended++
      workspace.ended++
    }
  }
  // Running services lead their session; the stable sort keeps host order within each status.
  for (const workspace of workspaces.values()) {
    for (const group of workspace.sessions) {
      group.services.sort((left, right) => Number(right.status === 'running') - Number(left.status === 'running'))
    }
  }
  return [...workspaces.values()]
}

/** Show the directory name; the full registered path remains in the tooltip. */
export function projectLabel(project: string, fallback: string): string {
  return project.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || project || fallback
}

const isIdentity = (value: string): boolean => sessionIdentity.test(value) || bareSessionIdentity.test(value)

/**
 * Prefer the name the Session list shows in the sidebar, then preserve explicit
 * session labels, then shorten opaque identities. A name that is only the
 * identity again is no improvement over the shortened form.
 */
export function sessionLabel(session: string, title: string | undefined, label: string, fallback: string): string {
  const name = title?.trim()
  if (name && !isIdentity(name)) return name
  if (!session) return fallback
  if (sessionIdentity.test(session)) return `${label} · ${session.slice(8, 16)}`
  if (bareSessionIdentity.test(session)) return `${label} · ${session.slice(0, 8)}`
  return session
}
