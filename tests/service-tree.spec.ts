import { describe, expect, it } from 'vitest'
import type { ServiceView } from '../src/types.ts'
import { groupServices, sessionLabel, sessionTargetId } from '../src/client/service-tree.ts'

const session = 'session-4b8de650-ce90-484b-bacf-63c1d926ecef'
const legacySession = 'ea3ab92f-b004-4a8d-b62e-a4ccd2ae1145'
function row(id: string, project: string, owner = session, status: ServiceView['status'] = 'running'): ServiceView {
  return {
    record: { id, kind: 'job', jobId: id, name: id, project, session: owner, url: '', createdAt: '2026-09-29T00:00:00.000Z' },
    status, detail: '', remaining: status === 'running' ? 1 : 0,
  }
}

describe('workspace identity', () => {
  it('joins a legacy name with the unique path in the same full session without changing records', () => {
    const services = [row('backend', 'Jianmen'), row('frontend', 'C:\\02-codespace\\Jianmen')]
    const before = structuredClone(services)
    const groups = groupServices(services)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ project: 'C:\\02-codespace\\Jianmen', count: 2, ended: 0 })
    expect(groups[0]!.sessions).toEqual([{ session, services, running: 2, ended: 0 }])
    expect(services).toEqual(before)
  })

  it('normalizes Windows drive and UNC paths while retaining distinct sessions', () => {
    const groups = groupServices([
      row('a', 'C:\\work\\Demo\\'), row('b', 'c:/WORK/demo', 'another-session'),
      row('c', '\\\\server\\share\\Demo'), row('d', '//SERVER/share/demo/'),
    ])
    expect(groups.map(group => group.count)).toEqual([2, 2])
    expect(groups[0]!.sessions).toHaveLength(2)
  })

  it('does not merge distinct directories or guess an ambiguous legacy name', () => {
    const groups = groupServices([row('a', 'C:/one/Jianmen'), row('b', 'D:/two/Jianmen'), row('c', 'Jianmen')])
    expect(groups.map(group => group.count)).toEqual([1, 1, 1])
  })

  it('requires the same complete session identity, not a shared prefix or user label', () => {
    for (const owner of ['', '开发会话', 'session-4b8de650-ce90-484b-bacf-000000000000']) {
      const services = [row('a', 'C:/work/Jianmen', owner === '' || owner === '开发会话' ? owner : session), row('b', 'Jianmen', owner)]
      expect(groupServices(services)).toHaveLength(2)
    }
  })

  it('preserves POSIX case and excludes non-running services from alias evidence', () => {
    const stopped = row('old', 'C:/old/Jianmen', session, 'stopped')
    const groups = groupServices([row('a', '/work/Demo'), row('b', '/work/demo'), row('c', 'Jianmen'), stopped])
    expect(groups.map(group => group.project)).toEqual(['/work/Demo', '/work/demo', 'Jianmen'])
  })

  it('keeps ended services out unless they are requested', () => {
    const services = [row('live', 'C:/work/demo'), row('done', 'C:/work/demo', session, 'stopped')]
    expect(groupServices(services)[0]).toMatchObject({ count: 1, ended: 0 })
    expect(groupServices(services)[0]!.sessions[0]!.services.map(service => service.record.id)).toEqual(['live'])
  })

  it('lists ended services under their session with running rows first and separate counts', () => {
    const services = [
      row('done', 'C:/work/demo', session, 'stopped'),
      row('live', 'C:/work/demo'),
      row('reused', 'C:/work/demo', session, 'changed'),
      row('unclear', 'C:/work/demo', session, 'unknown'),
    ]
    const groups = groupServices(services, { includeEnded: true })
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ count: 1, ended: 3 })
    expect(groups[0]!.sessions[0]).toMatchObject({ running: 1, ended: 3 })
    expect(groups[0]!.sessions[0]!.services.map(service => [service.record.id, service.status])).toEqual([
      ['live', 'running'], ['done', 'stopped'], ['reused', 'changed'], ['unclear', 'unknown'],
    ])
  })

  it('never treats an ended record as alias evidence for a legacy workspace name', () => {
    const groups = groupServices([
      row('path', 'C:\\02-codespace\\Jianmen', session, 'stopped'),
      row('label', 'Jianmen', session, 'stopped'),
    ], { includeEnded: true })
    expect(groups.map(group => group.project)).toEqual(['C:\\02-codespace\\Jianmen', 'Jianmen'])
  })
})

describe('session navigation targets', () => {
  it.each([session, legacySession])('accepts the complete Harness identity %s', value => {
    expect(sessionTargetId(value)).toBe(value)
  })

  it('shortens both stored session identity formats and keeps user labels verbatim', () => {
    expect(sessionLabel(session, '会话', '无')).toBe('会话 · 4b8de650')
    expect(sessionLabel(legacySession, '会话', '无')).toBe('会话 · ea3ab92f')
    expect(sessionLabel('开发会话', '会话', '无')).toBe('开发会话')
    expect(sessionLabel('', '会话', '无')).toBe('无')
  })

  it.each(['', '开发会话', '前后端联调', 'session-4b8de650', '4b8de650-ce90-484b-bacf', 'session-4b8de650-ce90-484b-bacf'])(
    'refuses the user-written or partial label %s', value => {
      expect(sessionTargetId(value)).toBeUndefined()
    })
})
