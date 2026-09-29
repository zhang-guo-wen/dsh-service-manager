import { describe, expect, it } from 'vitest'
import type { ServiceView } from '../src/types.ts'
import { groupRunningServices } from '../src/client/service-tree.ts'

const session = 'session-4b8de650-ce90-484b-bacf-63c1d926ecef'
function row(id: string, project: string, owner = session): ServiceView {
  return {
    record: { id, kind: 'job', jobId: id, name: id, project, session: owner, url: '', createdAt: '2026-09-29T00:00:00.000Z' },
    status: 'running', detail: '', remaining: 1,
  }
}

describe('workspace identity', () => {
  it('joins a legacy name with the unique path in the same full session without changing records', () => {
    const services = [row('backend', 'Jianmen'), row('frontend', 'C:\\02-codespace\\Jianmen')]
    const before = structuredClone(services)
    const groups = groupRunningServices(services)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ project: 'C:\\02-codespace\\Jianmen', count: 2 })
    expect(groups[0]!.sessions).toEqual([{ session, services }])
    expect(services).toEqual(before)
  })

  it('normalizes Windows drive and UNC paths while retaining distinct sessions', () => {
    const groups = groupRunningServices([
      row('a', 'C:\\work\\Demo\\'), row('b', 'c:/WORK/demo', 'another-session'),
      row('c', '\\\\server\\share\\Demo'), row('d', '//SERVER/share/demo/'),
    ])
    expect(groups.map(group => group.count)).toEqual([2, 2])
    expect(groups[0]!.sessions).toHaveLength(2)
  })

  it('does not merge distinct directories or guess an ambiguous legacy name', () => {
    const groups = groupRunningServices([row('a', 'C:/one/Jianmen'), row('b', 'D:/two/Jianmen'), row('c', 'Jianmen')])
    expect(groups.map(group => group.count)).toEqual([1, 1, 1])
  })

  it('requires the same complete session identity, not a shared prefix or user label', () => {
    for (const owner of ['', '开发会话', 'session-4b8de650-ce90-484b-bacf-000000000000']) {
      const services = [row('a', 'C:/work/Jianmen', owner === '' || owner === '开发会话' ? owner : session), row('b', 'Jianmen', owner)]
      expect(groupRunningServices(services)).toHaveLength(2)
    }
  })

  it('preserves POSIX case and excludes non-running services from alias evidence', () => {
    const stopped = { ...row('old', 'C:/old/Jianmen'), status: 'stopped' as const }
    const groups = groupRunningServices([row('a', '/work/Demo'), row('b', '/work/demo'), row('c', 'Jianmen'), stopped])
    expect(groups.map(group => group.project)).toEqual(['/work/Demo', '/work/demo', 'Jianmen'])
  })
})
