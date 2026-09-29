// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ServiceRecord, ServiceView } from '../src/types.ts'
import { zh } from '../src/client/locales.ts'
import { ServiceSection, type ServiceFace, type ServiceSectionProps } from '../src/client/ServiceSection.tsx'

// Keep HTML button semantics and dialogs while the host owns its primitives.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ variant, size, children, ...props }: any) => <button type="button" {...props}>{children}</button>,
  Modal: ({ open, title, description, children, footer }: any) => open ? <div role="dialog" aria-label={title}><h2>{title}</h2><p>{description}</p>{children}{footer}</div> : null,
}))
afterEach(cleanup)
const record: ServiceRecord = { id: '00000000-0000-4000-8000-000000000001', kind: 'process', name: 'Vite server', pid: 12345, startedAt: '100', host: 'test', tree: false, pendingStop: [], project: 'C:/work/demo', session: '开发会话', url: '', createdAt: '2026-09-29T00:00:00.000Z' }
function row(id: string, name: string, project = record.project, session = record.session, status: ServiceView['status'] = 'running'): ServiceView {
  return { record: { ...record, id, name, project, session }, status, detail: '', remaining: status === 'running' ? 1 : 0 }
}
function fixture(rows = [row(record.id, record.name)]) {
  let services = rows
  const face: ServiceFace = {
    list: vi.fn(async () => ({ services: structuredClone(services), file: 'services.json' })),
    stop: vi.fn(async ({ ids }) => {
      services = services.map(service => ids.includes(service.record.id) ? { ...service, status: 'stopped', remaining: 0 } : service)
      return { results: ids.map(id => ({ id, ok: true, message: 'Stopped' })) }
    }),
  }
  const props = { ...face, t: (key: keyof typeof zh) => zh[key] } as ServiceSectionProps
  return { props, face }
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
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([zh.refresh, zh.forceStop, zh.forceStop, zh.forceStop, zh.forceStop])
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(f.face.stop).not.toHaveBeenCalled()
  })

  it('shows legacy and automatic registrations in one workspace and stops the selected record only', async () => {
    const session = 'session-4b8de650-ce90-484b-bacf-63c1d926ecef'
    const f = fixture([row('manual', 'jianmen-backend', 'Jianmen', session), row('automatic', 'cmd.exe', 'C:\\02-codespace\\Jianmen', session)])
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

  it('clears stale rows when status refresh fails', async () => {
    const f = fixture()
    const list = vi.fn<ServiceFace['list']>().mockResolvedValueOnce(await f.face.list()).mockRejectedValueOnce(new Error('Query unavailable'))
    render(<ServiceSection {...f.props} list={list} />)
    await screen.findByText(record.name)
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    await screen.findByRole('alert')
    expect(screen.queryByText(record.name)).toBeNull()
    expect(screen.queryByText(zh.empty)).toBeNull()
    expect(screen.getByText(zh.loadFailed)).toBeTruthy()
  })
})
