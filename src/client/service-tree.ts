import type { ServiceView } from '../types.ts'

export interface SessionGroup { session: string; services: ServiceView[] }
export interface WorkspaceGroup { project: string; sessions: SessionGroup[]; count: number }

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

/** Group confirmed running services without merging sessions across workspaces. */
export function groupRunningServices(services: readonly ServiceView[]): WorkspaceGroup[] {
  const running = services.filter(service => service.status === 'running')
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
  for (const service of running) {
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
      workspace = { project: path?.project ?? project, sessions: [], count: 0 }
      workspaces.set(key, workspace)
      sessions.set(workspace, new Map())
    }
    const account = sessions.get(workspace)!
    let group = account.get(session)
    if (!group) {
      group = { session, services: [] }
      account.set(session, group)
      workspace.sessions.push(group)
    }
    group.services.push(service)
    workspace.count++
  }
  return [...workspaces.values()]
}

/** Show the directory name; the full registered path remains in the tooltip. */
export function projectLabel(project: string, fallback: string): string {
  return project.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || project || fallback
}

/** Shorten opaque session identities while preserving explicit session labels. */
export function sessionLabel(session: string, label: string, fallback: string): string {
  if (!session) return fallback
  return /^session-[\da-f-]+$/i.test(session) ? `${label} · ${session.slice(8, 16)}` : session
}
