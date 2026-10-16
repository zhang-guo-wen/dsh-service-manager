// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ServiceRecord, ServiceView } from '../src/types.ts'
import { zh } from '../src/client/locales.ts'
import { ServiceSection, type ServiceFace, type ServiceSectionProps } from '../src/client/ServiceSection.tsx'

// Keep HTML button semantics and dialogs while the host owns its primitives.
// `relativeTime` reimplements the host's documented buckets so the assertions
// read this section's own wiring (which key, which params), not the host maths.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ variant, size, children, ...props }: any) => <button type="button" {...props}>{children}</button>,
  Modal: ({ open, title, description, children, footer }: any) => open ? <div role="dialog" aria-label={title}><h2>{title}</h2><p>{description}</p>{children}{footer}</div> : null,
  Tag: ({ children }: any) => <span>{children}</span>,
  StateDot: ({ state }: any) => <span data-state={state} aria-hidden="true" />,
  // The host Toast portals to the body; the stand-in keeps its role and copy in
  // the tree so a case reads the outcome the section hands it.
  Toast: ({ text }: any) => <span role="status">{text}</span>,
  relativeTime: (at: number, now: number) => {
    const minutes = Math.max(0, Math.round((now - at) / 60_000))
    if (minutes < 1) return { unit: 'now', n: 0 }
    if (minutes < 60) return { unit: 'minutes', n: minutes }
    const hours = Math.round(minutes / 60)
    if (hours < 24) return { unit: 'hours', n: hours }
    const days = Math.round(hours / 24)
    if (days < 30) return { unit: 'days', n: days }
    const months = Math.round(days / 30)
    if (months < 12) return { unit: 'months', n: months }
    return { unit: 'years', n: Math.round(months / 12) }
  },
}))
afterEach(cleanup)
const record: ServiceRecord = { id: '00000000-0000-4000-8000-000000000001', kind: 'process', name: 'Vite server', pid: 12345, startedAt: '100', host: 'test', tree: false, pendingStop: [], project: 'C:/work/demo', session: '开发会话', url: '', createdAt: '2026-09-29T00:00:00.000Z' }
const liveSession = 'session-4b8de650-ce90-484b-bacf-63c1d926ecef'
function row(id: string, name: string, project = record.project, session = record.session, status: ServiceView['status'] = 'running'): ServiceView {
  return { record: { ...record, id, name, project, session }, status, detail: '', remaining: status === 'running' ? 1 : 0 }
}
// The host interpolates {name} placeholders; the fixture must do the same or assertions would read the raw template.
const translate = (key: keyof typeof zh, params?: Record<string, unknown>) =>
  Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), String(zh[key]))
function fixture(rows = [row(record.id, record.name)], initialTitles?: ReadonlyMap<string, string>) {
  let services = rows
  // The host store publishes a fresh snapshot per change; the fixture must too,
  // or a rename would keep the identity useSyncExternalStore compares.
  let titles = new Map(initialTitles ?? [])
  const listeners = new Set<() => void>()
  const face: ServiceFace = {
    list: vi.fn(async () => ({ services: structuredClone(services), file: 'services.json' })),
    stop: vi.fn(async ({ ids }) => {
      services = services.map(service => ids.includes(service.record.id) ? { ...service, status: 'stopped', remaining: 0 } : service)
      return { results: ids.map(id => ({ id, ok: true, message: 'Stopped' })) }
    }),
    remove: vi.fn(async ({ ids }) => {
      services = services.filter(service => !ids.includes(service.record.id))
      return { results: ids.map(id => ({ id, ok: true, message: 'Record removed; service was not stopped' })) }
    }),
    candidates: vi.fn(async () => ({ candidates: [] })),
    claim: vi.fn(async () => ({})),
    openSession: vi.fn(),
    ...initialTitles ? {
      sessionTitles: () => titles,
      subscribeSessions: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    } : {},
  }
  const close = vi.fn()
  const props = { ...face, close, t: translate } as ServiceSectionProps
  const rename = (session: string, name: string) => { titles = new Map(titles).set(session, name); listeners.forEach(listener => { listener() }) }
  return { props, face, close, rename }
}
const confirmStop = () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.forceStop, exact: true }))

describe('running service tree', () => {
  it.each(['http://127.0.0.1:47100', 'https://example.com/service?view=logs'])('renders %s as a link opening a separate browser tab', async url => {
    const service = row(record.id, record.name)
    service.record.url = url
    const f = fixture([service])
    render(<ServiceSection {...f.props} />)
    const link = await screen.findByRole('link', { name: url })
    expect(link.getAttribute('href')).toBe(url)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(f.face.stop).not.toHaveBeenCalled()
  })

  it('shows automatic background tasks with the same single stop action', async () => {
    const f = fixture([{ record: { id: record.id, name: 'npm run build', kind: 'job', jobId: 'bash-7', project: record.project, session: record.session, url: '', createdAt: record.createdAt }, status: 'running', detail: '', remaining: 1 }])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('npm run build')
    expect(screen.getByText('后台任务 · bash-7')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.forceStop }))
    confirmStop()
    await screen.findByText(zh.empty)
    expect(f.face.stop).toHaveBeenCalledWith({ ids: [record.id], force: true })
  })
  it('groups three levels and keeps equal session names in separate workspaces', async () => {
    const f = fixture([row('a', 'Frontend'), row('b', 'Backend'), row('c', 'Redis', 'C:/work/other'), row('d', 'Preview', record.project, '预览会话')])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Frontend')
    const root = screen.getByRole('list', { name: zh.workspace })
    const workspaces = within(root).getAllByRole('list', { name: zh.session })
    expect(workspaces).toHaveLength(2)
    expect(within(workspaces[0]!).getAllByRole('list', { name: zh.services })).toHaveLength(2)
    expect(within(workspaces[0]!).getByText('Backend')).toBeTruthy()
    expect(within(workspaces[1]!).getByText('Redis')).toBeTruthy()
    expect(root.querySelectorAll('details')).toHaveLength(5)
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([zh.refresh, zh.adopt, zh.stopAll, zh.forceStop, zh.forceStop, zh.forceStop, zh.forceStop])
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(f.face.stop).not.toHaveBeenCalled()
  })

  it('shows legacy and automatic registrations in one workspace and stops the selected record only', async () => {
    const f = fixture([row('manual', 'jianmen-backend', 'Jianmen', liveSession), row('automatic', 'cmd.exe', 'C:\\02-codespace\\Jianmen', liveSession)])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('jianmen-backend')
    expect(screen.getAllByRole('list', { name: zh.session })).toHaveLength(1)
    expect(screen.getAllByRole('list', { name: zh.services })).toHaveLength(1)
    const service = screen.getByText('cmd.exe').closest('li')!
    fireEvent.click(within(service).getByRole('button', { name: zh.forceStop }))
    confirmStop()
    await waitFor(() => expect(f.face.stop).toHaveBeenCalledWith({ ids: ['automatic'], force: true }))
    await waitFor(() => expect(screen.queryByText('cmd.exe')).toBeNull())
    expect(screen.getByText('jianmen-backend')).toBeTruthy()
  })

  it('hides stopped, unknown, changed services and their empty groups', async () => {
    const f = fixture([row('a', 'Live'), row('b', 'Finished', 'empty', '', 'stopped'), row('c', 'Unknown', 'empty', '', 'unknown'), row('d', 'Reused', 'empty', '', 'changed')])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Live')
    for (const text of ['Finished', 'Unknown', 'Reused', 'empty']) expect(screen.queryByText(text)).toBeNull()
    expect(screen.getAllByRole('button', { name: zh.forceStop })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: zh.openSession })).toBeNull()
  })

  it('groups missing associations and shortens session ids without changing stop identity', async () => {
    const f = fixture([row('a', 'Unassigned', '', ''), row('b', 'Opaque', 'C:\\work\\demo\\', 'session-12345678-abcd-4000-8000-123456789abc')])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Unassigned')
    expect(screen.getByText(zh.unassignedWorkspace)).toBeTruthy()
    expect(screen.getByText(zh.unassignedSession)).toBeTruthy()
    expect(screen.getByText('会话 · 12345678')).toBeTruthy()
    expect(screen.getByText('demo')).toBeTruthy()
  })

  it('stops only after confirmation and hides the service and empty groups afterwards', async () => {
    const f = fixture()
    const view = render(<ServiceSection {...f.props} />)
    await screen.findByText(record.name)
    fireEvent.click(screen.getByRole('button', { name: zh.forceStop }))
    expect(f.face.stop).not.toHaveBeenCalled()
    confirmStop()
    await screen.findByText(zh.empty)
    expect(f.face.stop).toHaveBeenCalledWith({ ids: [record.id], force: true })
    expect(screen.queryByRole('list', { name: zh.workspace })).toBeNull()
    expect(screen.queryByText(record.name)).toBeNull()
    view.unmount()
    expect(f.face.stop).toHaveBeenCalledTimes(1)
  })

  it('cancels confirmation without stopping and requires confirmation again on retry', async () => {
    const f = fixture()
    render(<ServiceSection {...f.props} />)
    await screen.findByText(record.name)
    fireEvent.click(screen.getByRole('button', { name: zh.forceStop }))
    const dialog = within(screen.getByRole('dialog', { name: zh.forceStop }))
    expect(dialog.getByText(zh.forceStopHint)).toBeTruthy()
    expect(dialog.queryByRole('checkbox')).toBeNull()
    expect(f.face.stop).not.toHaveBeenCalled()
    fireEvent.click(dialog.getByRole('button', { name: zh.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(f.face.stop).not.toHaveBeenCalled()
    expect(screen.getByText(record.name)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.forceStop }))
    expect(screen.getByRole('dialog', { name: zh.forceStop })).toBeTruthy()
    expect(f.face.stop).not.toHaveBeenCalled()
    confirmStop()
    await screen.findByText(zh.empty)
    expect(f.face.stop).toHaveBeenCalledTimes(1)
    expect(f.face.stop).toHaveBeenCalledWith({ ids: [record.id], force: true })
  })

  it('shows action failures without claiming the service stopped', async () => {
    const f = fixture()
    render(<ServiceSection {...f.props} stop={vi.fn(async () => ({ results: [{ id: record.id, ok: false, message: 'Access denied' }] }))} />)
    await screen.findByText(record.name)
    fireEvent.click(screen.getByRole('button', { name: zh.forceStop }))
    confirmStop()
    expect((await screen.findByRole('alert')).textContent).toContain('Vite server: Access denied')
    expect(screen.queryByText(zh.empty)).toBeNull()
  })

  it('keeps the last rows and the list itself on screen when a status refresh fails, then retries in place', async () => {
    const f = fixture()
    const list = vi.fn<ServiceFace['list']>().mockResolvedValueOnce(await f.face.list()).mockRejectedValueOnce(new Error('Query unavailable')).mockResolvedValueOnce(await f.face.list())
    render(<ServiceSection {...f.props} list={list} />)
    await screen.findByText(record.name)
    const listNode = screen.getByRole('list', { name: zh.workspace })

    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Query unavailable')
    expect(alert.textContent).toContain(zh.staleHint)
    // The rows and their scroll container are the same nodes: nothing remounted.
    expect(screen.getByText(record.name)).toBeTruthy()
    expect(screen.getByRole('list', { name: zh.workspace })).toBe(listNode)
    expect(screen.queryByText(zh.empty)).toBeNull()
    expect(screen.queryByText(zh.loadFailed)).toBeNull()

    fireEvent.click(within(alert).getByRole('button', { name: zh.retry }))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('reports a first read that never succeeded with its own retry', async () => {
    const f = fixture()
    const list = vi.fn<ServiceFace['list']>().mockRejectedValueOnce(new Error('Query unavailable')).mockResolvedValueOnce(await f.face.list())
    render(<ServiceSection {...f.props} list={list} />)
    expect(await screen.findByText(zh.loadFailed)).toBeTruthy()
    expect(screen.queryByText(zh.empty)).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('Query unavailable')

    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(await screen.findByText(record.name)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names every status in words beside the host dot', async () => {
    const f = fixture([
      row('run', 'Live', 'C:/work/demo', liveSession),
      row('stop', 'Exited', 'C:/work/demo', liveSession, 'stopped'),
      row('reuse', 'Reused', 'C:/work/demo', liveSession, 'changed'),
    ])
    const { container } = render(<ServiceSection {...f.props} />)
    await screen.findByText('Live')
    fireEvent.click(screen.getByRole('checkbox'))
    await screen.findByText('Exited')

    const cases: [string, string, string][] = [['Live', 'done', zh.running], ['Exited', 'idle', zh.stopped], ['Reused', 'warning', zh.changed]]
    for (const [name, dot, label] of cases) {
      const service = screen.getByText(name).closest('li') as HTMLElement
      expect(service.querySelector('[data-state]')?.getAttribute('data-state')).toBe(dot)
      expect(within(service).getByText(label)).toBeTruthy()
    }
    expect(container.querySelectorAll('[data-state]').length).toBeGreaterThanOrEqual(3)
  })

  it('labels a row with the host relative-time bucket for when it was tracked', async () => {
    const tracked: ServiceView = {
      ...row('tracked', 'Tracked'),
      record: { ...record, id: 'tracked', name: 'Tracked', createdAt: new Date(Date.now() - 5 * 60_000).toISOString() },
    }
    const f = fixture([tracked])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Tracked')
    expect(screen.getByText(translate('trackedFor', { time: translate('timeMinutes', { count: 5 }) }))).toBeTruthy()
    expect(screen.getByText(translate('trackedFor', { time: translate('timeMinutes', { count: 5 }) })).getAttribute('title')).toBe(tracked.record.createdAt)
  })

  it('offers a next step from the empty state instead of only naming the state', async () => {
    const f = fixture([])
    render(<ServiceSection {...f.props} />)
    await screen.findByText(zh.empty)
    expect(screen.getByText(zh.emptyHint)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.emptyAction }))
    expect(await screen.findByRole('dialog', { name: zh.adoptTitle })).toBeTruthy()
  })

  it('reports a successful stop in the host banner and keeps a failed one in its dialog with a retry', async () => {
    const f = fixture()
    const stop = vi.fn<ServiceFace['stop']>()
      .mockRejectedValueOnce(new Error('stop refused'))
      .mockResolvedValueOnce({ results: [{ id: record.id, ok: true, message: 'Stopped' }] })
    const view = render(<ServiceSection {...f.props} stop={stop} />)
    await screen.findByText(record.name)
    fireEvent.click(screen.getByRole('button', { name: zh.forceStop }))
    confirmStop()

    // Failure: the dialog stays with its target and the retry inside it.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('stop refused')
    expect(alert.textContent).toContain(zh.dialogRetryHint)
    const dialog = within(screen.getByRole('dialog', { name: zh.forceStop }))
    expect(dialog.getByText(record.name)).toBeTruthy()

    fireEvent.click(within(alert).getByRole('button', { name: zh.retry }))
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('status').textContent).toBe(zh.stoppedOne)
    view.unmount()
  })

  it('shows the in-flight state of a running write', async () => {
    const f = fixture()
    let finish!: () => void
    const stop = vi.fn<ServiceFace['stop']>(() => new Promise(resolve => { finish = () => resolve({ results: [{ id: record.id, ok: true, message: 'Stopped' }] }) }))
    render(<ServiceSection {...f.props} stop={stop} />)
    await screen.findByText(record.name)
    fireEvent.click(screen.getByRole('button', { name: zh.forceStop }))
    confirmStop()

    const dialog = within(screen.getByRole('dialog', { name: zh.forceStop }))
    // The busy line and the confirm button both name the write in progress.
    await waitFor(() => expect(dialog.getAllByText(zh.busy)).toHaveLength(2))
    expect(dialog.getByRole('button', { name: zh.busy })).toHaveProperty('disabled', true)
    fireEvent.click(dialog.getByRole('button', { name: zh.cancel }))
    // The dialog cannot be dismissed mid-write.
    expect(screen.getByRole('dialog', { name: zh.forceStop })).toBeTruthy()

    await act(async () => { finish() })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('ended services', () => {
  it('reveals exited, reused and unknown PIDs only after the toggle', async () => {
    const f = fixture([
      row('run', 'Live', 'C:/work/demo', liveSession),
      row('stop', 'Exited', 'C:/work/demo', liveSession, 'stopped'),
      row('reuse', 'Reused', 'C:/work/demo', liveSession, 'changed'),
      row('unknown', 'Unclear', 'C:/work/demo', liveSession, 'unknown'),
    ])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Live')
    for (const name of ['Exited', 'Reused', 'Unclear']) expect(screen.queryByText(name)).toBeNull()

    fireEvent.click(screen.getByRole('checkbox'))
    await screen.findByText('Exited')
    expect(screen.getByText(zh.stopped)).toBeTruthy()
    expect(screen.getByText(zh.changed)).toBeTruthy()
    expect(screen.getByText(zh.unknown)).toBeTruthy()
    expect(screen.getAllByText(/PID 12345/)).toHaveLength(4)
    expect(screen.getAllByRole('button', { name: zh.forceStop })).toHaveLength(1)
    expect(screen.getByText(`+3`)).toBeTruthy()

    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(screen.queryByText('Exited')).toBeNull())
    expect(screen.getByText('Live')).toBeTruthy()
  })

  it('keeps a session group whose services have all ended', async () => {
    const f = fixture([row('done', 'Finished', 'C:/work/demo', liveSession, 'stopped')])
    render(<ServiceSection {...f.props} />)
    await screen.findByText(zh.empty)
    fireEvent.click(screen.getByRole('checkbox'))
    await screen.findByText('Finished')
    expect(screen.getByText('会话 · 4b8de650')).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.stopAll })).toHaveProperty('disabled', true)
  })
})

describe('session navigation', () => {
  it.each([liveSession, 'ea3ab92f-b004-4a8d-b62e-a4ccd2ae1145'])('opens %s without collapsing the session group', async session => {
    const f = fixture([row('a', 'Backend', 'C:/work/demo', session)])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Backend')
    // fireEvent reports false when the handler prevented the summary from toggling.
    expect(fireEvent.click(screen.getByRole('button', { name: zh.openSession }))).toBe(false)
    expect(f.face.openSession).toHaveBeenCalledWith(session)
    expect(f.face.stop).not.toHaveBeenCalled()
  })

  it('leaves the settings panel so the opened session is visible', async () => {
    const f = fixture([row('a', 'Backend', 'C:/work/demo', liveSession)])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Backend')
    expect(f.close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.openSession }))
    expect(f.face.openSession).toHaveBeenCalledWith(liveSession)
    expect(f.close).toHaveBeenCalledTimes(1)
  })

  it('keeps the panel open and reports the failure when the session cannot be opened', async () => {
    const f = fixture([row('a', 'Backend', 'C:/work/demo', liveSession)])
    render(<ServiceSection {...f.props} openSession={vi.fn(() => { throw new Error('unknown session') })} />)
    await screen.findByText('Backend')
    fireEvent.click(screen.getByRole('button', { name: zh.openSession }))
    expect((await screen.findByRole('alert')).textContent).toContain('unknown session')
    expect(f.close).not.toHaveBeenCalled()
    expect(screen.getByText('Backend')).toBeTruthy()
  })

  it('labels a session row with the name its Session list row shows', async () => {
    const f = fixture([row('a', 'Backend', 'C:/work/demo', liveSession)], new Map([[liveSession, '修复服务管理弹窗']]))
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Backend')
    expect(screen.getByText('修复服务管理弹窗')).toBeTruthy()
    expect(screen.queryByText('会话 · 4b8de650')).toBeNull()
  })

  it('falls back to the shortened identity for sessions the list does not name', async () => {
    const f = fixture([row('a', 'Backend', 'C:/work/demo', liveSession)], new Map())
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Backend')
    expect(screen.getByText('会话 · 4b8de650')).toBeTruthy()
  })

  it('follows a rename in the Session list and keeps the identity in the tooltip', async () => {
    const f = fixture([row('a', 'Backend', 'C:/work/demo', liveSession)], new Map([[liveSession, '旧名称']]))
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Backend')
    expect(screen.getByText('旧名称')).toBeTruthy()
    act(() => { f.rename(liveSession, '新名称') })
    await screen.findByText('新名称')
    expect(screen.queryByText('旧名称')).toBeNull()
    expect(screen.getByTitle(liveSession)).toBeTruthy()
  })

  it('offers no session action for a user-written label', async () => {
    const f = fixture([row('a', 'Backend', 'C:/work/demo', '开发会话')])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Backend')
    expect(screen.queryByRole('button', { name: zh.openSession })).toBeNull()
  })

  it('reports a session that cannot be opened without hiding the service', async () => {
    const f = fixture([row('a', 'Backend', 'C:/work/demo', liveSession)])
    render(<ServiceSection {...f.props} openSession={vi.fn(() => { throw new Error('unknown session') })} />)
    await screen.findByText('Backend')
    fireEvent.click(screen.getByRole('button', { name: zh.openSession }))
    expect((await screen.findByRole('alert')).textContent).toContain('unknown session')
    expect(screen.getByText('Backend')).toBeTruthy()
  })
})

describe('stop all', () => {
  it('stops every running service only after confirmation', async () => {
    const f = fixture([
      row('a', 'Alpha', 'C:/work/demo', liveSession),
      row('b', 'Beta', 'C:/work/demo', liveSession),
      row('c', 'Finished', 'C:/work/demo', liveSession, 'stopped'),
    ])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByRole('button', { name: zh.stopAll }))
    expect(f.face.stop).not.toHaveBeenCalled()
    const dialog = within(screen.getByRole('dialog', { name: zh.stopAll }))
    expect(dialog.getByText(translate('stopAllHint', { count: 2 }))).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: zh.stopAll }))
    await waitFor(() => expect(f.face.stop).toHaveBeenCalledExactlyOnceWith({ ids: ['a', 'b'], force: true }))
    await screen.findByText(zh.empty)
  })

  it('cancels without stopping anything', async () => {
    const f = fixture()
    render(<ServiceSection {...f.props} />)
    await screen.findByText(record.name)
    fireEvent.click(screen.getByRole('button', { name: zh.stopAll }))
    fireEvent.click(within(screen.getByRole('dialog', { name: zh.stopAll })).getByRole('button', { name: zh.cancel }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(f.face.stop).not.toHaveBeenCalled()
    expect(screen.getByText(record.name)).toBeTruthy()
  })

  it('reports the services that could not be stopped', async () => {
    const f = fixture([row('a', 'Alpha'), row('b', 'Beta')])
    render(<ServiceSection {...f.props} stop={vi.fn(async ({ ids }) => ({ results: ids.map(id => ({ id, ok: id !== 'a', message: id === 'a' ? 'Access denied' : 'Stopped' })) }))} />)
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByRole('button', { name: zh.stopAll }))
    fireEvent.click(within(screen.getByRole('dialog', { name: zh.stopAll })).getByRole('button', { name: zh.stopAll }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(translate('stopAllFailed', { count: 1 }))
    expect(alert.textContent).toContain('Alpha: Access denied')
    expect(screen.queryByText(zh.empty)).toBeNull()
  })

  it('stays disabled while nothing is running', async () => {
    const f = fixture([row('done', 'Finished', 'C:/work/demo', '', 'stopped')])
    render(<ServiceSection {...f.props} />)
    await screen.findByText(zh.empty)
    expect(screen.getByRole('button', { name: zh.stopAll })).toHaveProperty('disabled', true)
  })
})

describe('leftovers from an earlier run', () => {
  const legacyRow = (id: string, name: string): ServiceView => ({ ...row(id, name), legacy: true })

  it('marks a service that was already running and stops every leftover after one confirmation', async () => {
    const f = fixture([legacyRow('old', 'Old vite'), legacyRow('older', 'Old redis'), row('new', 'Fresh server')])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Old vite')
    expect(screen.getAllByText(zh.legacy)).toHaveLength(2)
    expect(screen.getByText(`${zh.legacy} 2`)).toBeTruthy()
    expect(f.face.stop).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.stopLegacy }))
    const dialog = within(screen.getByRole('dialog', { name: zh.stopLegacy }))
    expect(dialog.getByText(translate('stopLegacyHint', { count: 2 }))).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: zh.stopLegacy }))
    await waitFor(() => expect(f.face.stop).toHaveBeenCalledExactlyOnceWith({ ids: ['old', 'older'], force: true }))
    // The current run's own service stays untouched.
    await screen.findByText('Fresh server')
    expect(f.face.stop).toHaveBeenCalledTimes(1)
  })

  it('offers no leftover action when every service belongs to this run', async () => {
    const f = fixture([row('a', 'Fresh server')])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Fresh server')
    expect(screen.queryByText(zh.legacy)).toBeNull()
    expect(screen.queryByRole('button', { name: zh.stopLegacy })).toBeNull()
  })

  it('cancels the leftover batch without stopping anything', async () => {
    const f = fixture([legacyRow('old', 'Old vite')])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Old vite')
    fireEvent.click(screen.getByRole('button', { name: zh.stopLegacy }))
    fireEvent.click(within(screen.getByRole('dialog', { name: zh.stopLegacy })).getByRole('button', { name: zh.cancel }))
    expect(f.face.stop).not.toHaveBeenCalled()
    expect(screen.getByText('Old vite')).toBeTruthy()
  })
})

describe('record cleanup', () => {
  it('removes an ended record without stopping its resource', async () => {
    const f = fixture([row('a', 'Live'), row('done', 'Finished', 'C:/work/demo', record.session, 'stopped')])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Live')
    fireEvent.click(screen.getByRole('checkbox'))
    await screen.findByText('Finished')
    fireEvent.click(screen.getByRole('button', { name: zh.removeRecord }))
    const dialog = within(screen.getByRole('dialog', { name: zh.removeRecord }))
    expect(dialog.getByText(zh.removeRecordHint)).toBeTruthy()
    expect(f.face.remove).not.toHaveBeenCalled()
    expect(f.face.stop).not.toHaveBeenCalled()
    fireEvent.click(dialog.getByRole('button', { name: zh.removeRecord }))
    await waitFor(() => expect(f.face.remove).toHaveBeenCalledExactlyOnceWith({ ids: ['done'] }))
    await waitFor(() => expect(screen.queryByText('Finished')).toBeNull())
    expect(f.face.stop).not.toHaveBeenCalled()
    expect(screen.getByText('Live')).toBeTruthy()
  })

  it('offers no removal for a running service', async () => {
    const f = fixture([row('a', 'Live')])
    render(<ServiceSection {...f.props} />)
    await screen.findByText('Live')
    expect(screen.queryByRole('button', { name: zh.removeRecord })).toBeNull()
    expect(f.face.remove).not.toHaveBeenCalled()
  })
})

describe('adopting a listening service', () => {
  const candidate = { pid: 4242, startedAt: '500', name: 'postgres.exe', port: 5432, protocol: 'TCP', address: '127.0.0.1:5432' }

  it('scans on open and adopts one candidate by identity', async () => {
    const f = fixture()
    render(<ServiceSection {...f.props} candidates={vi.fn(async () => ({ candidates: [candidate] }))} />)
    await screen.findByText(record.name)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.adopt }))
    const dialog = within(await screen.findByRole('dialog', { name: zh.adoptTitle }))
    expect(dialog.getByText('postgres.exe')).toBeTruthy()
    expect(dialog.getByText(/127\.0\.0\.1:5432 · PID 4242/)).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: zh.adoptOne }))
    await waitFor(() => expect(f.props.claim).toHaveBeenCalledExactlyOnceWith({ kind: 'process', name: 'postgres.exe (:5432)', pid: 4242, tree: false }))
    expect(f.face.stop).not.toHaveBeenCalled()
  })

  it('reports an empty scan and a scan failure without stopping anything', async () => {
    const f = fixture()
    const first = render(<ServiceSection {...f.props} candidates={vi.fn(async () => ({ candidates: [] }))} />)
    await screen.findByText(record.name)
    fireEvent.click(screen.getByRole('button', { name: zh.adopt }))
    expect(await screen.findByText(zh.adoptEmpty)).toBeTruthy()
    first.unmount()

    render(<ServiceSection {...f.props} candidates={vi.fn(async () => ({ candidates: [], warnings: ['netstat unavailable'] }))} />)
    await screen.findByText(record.name)
    fireEvent.click(screen.getByRole('button', { name: zh.adopt }))
    expect((await screen.findByRole('alert')).textContent).toContain('netstat unavailable')
  })
})
