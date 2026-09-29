// @vitest-environment jsdom
// Boots the shipped browser artifact the way the Host does: the handoff bundle
// registers through window.__ModuleLoader__.load, resolves its externals, and
// the registered section renders against the injected face.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createElement, type ReactNode } from 'react'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { zh } from '../src/client/locales.ts'
import { REMOTE_NAMESPACE } from '../src/remote.ts'
import type { ServiceView } from '../src/types.ts'

afterEach(cleanup)
const primitives = {
  Button: ({ variant, size, children, ...props }: any) => <button type="button" {...props}>{children}</button>,
  Modal: ({ open, title, description, children, footer }: any) => open ? <div role="dialog" aria-label={title}><h2>{title}</h2><p>{description}</p>{children}{footer}</div> : null,
}
const externals: Record<string, unknown> = {
  'react': React,
  'react/jsx-runtime': jsxRuntime,
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
}
const translate = (key: string, params?: Record<string, unknown>) =>
  Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), String(zh[key as keyof typeof zh]))
const liveSession = 'session-4b8de650-ce90-484b-bacf-63c1d926ecef'
const service: ServiceView = {
  record: { id: '00000000-0000-4000-8000-000000000001', kind: 'process', name: 'Vite server', pid: 12345, startedAt: '100', host: 'test', tree: false, pendingStop: [], project: 'C:/work/demo', session: liveSession, url: '', createdAt: '2026-09-29T00:00:00.000Z' },
  status: 'running', detail: '', remaining: 1,
}

/** Load lib/client.js through the Host handoff and run its apply against a stub client Context. */
async function boot(workspace?: { openSession(target: string): void }, rows: ServiceView[] = [service]) {
  // jsdom's import.meta.url is not a file URL, so resolve from the package root.
  const source = await readFile(resolve('lib/client.js'), 'utf8')
  let registration: { id: string; factory(requireExternal: (name: string) => unknown): { apply(ctx: unknown): Promise<void> } } | undefined
  const scope = { __ModuleLoader__: { load: (value: typeof registration) => { registration = value } } }
  new Function('window', source)(scope)
  expect(registration?.id).toBe('@guowenzhang/dsh-service-manager')
  const client = registration!.factory(name => {
    const external = externals[name]
    if (external === undefined) throw new Error(`unexpected external: ${name}`)
    return external
  })

  const remote = {
    listServices: vi.fn(async () => ({ ok: true, value: { services: structuredClone(rows), file: 'services.json' } })),
    stopServices: vi.fn(async ({ ids }: { ids: string[] }) => ({ ok: true, value: { results: ids.map(id => ({ id, ok: true, message: 'Stopped' })) } })),
  }
  const disposals: (() => void)[] = []
  let section: { options: any; Component: (props: any) => ReactNode } | undefined
  const ctx = {
    remote: { $mount: vi.fn(async () => () => {}) },
    locale: { register: vi.fn(() => () => {}), bind: () => translate },
    effect: (fn: () => () => void) => { disposals.push(fn()) },
    slots: {
      inject: (_name: string, fn: () => void) => { fn() },
      register: (options: any, Component: any) => { section = { options, Component }; return () => {} },
    },
    get: (name: string) => name === `remote.${REMOTE_NAMESPACE}` ? remote : name === 'uiWorkspace' ? workspace : undefined,
  }
  await client.apply(ctx)
  return { remote, disposals, section: section! }
}

describe('shipped client bundle', () => {
  it('registers the settings page through the Host handoff and renders live status rows', async () => {
    const { section, remote } = await boot()
    expect(section.options).toMatchObject({ name: 'settings.section', id: 'service-manager', order: 15.5, locale: 'settings.serviceManager' })
    const face = section.options.inject()
    render(createElement(section.Component, { ...face, t: translate }))
    await screen.findByText('Vite server')
    expect(remote.listServices).toHaveBeenCalledWith({})
    expect(screen.getByText(/PID 12345/)).toBeTruthy()
    expect(typeof face.openSession).toBe('function')
  })

  it('reaches the Workspace navigation capability that loads around this plugin', async () => {
    const workspace = { openSession: vi.fn() }
    const { section } = await boot(workspace)
    render(createElement(section.Component, { ...section.options.inject(), t: translate }))
    await screen.findByText('Vite server')
    expect(fireEvent.click(screen.getByRole('button', { name: zh.openSession }))).toBe(false)
    expect(workspace.openSession).toHaveBeenCalledExactlyOnceWith(liveSession)
  })

  it('reports a host without session navigation instead of failing to render', async () => {
    const { section } = await boot(undefined)
    render(createElement(section.Component, { ...section.options.inject(), t: translate }))
    await screen.findByText('Vite server')
    fireEvent.click(screen.getByRole('button', { name: zh.openSession }))
    expect((await screen.findByRole('alert')).textContent).toContain('session navigation is unavailable')
  })

  it('stops every running service from the shipped page after confirmation', async () => {
    const { section, remote } = await boot(undefined, [service, { ...service, record: { ...service.record, id: 'second', name: 'Worker' } }])
    render(createElement(section.Component, { ...section.options.inject(), t: translate }))
    await screen.findByText('Vite server')
    fireEvent.click(screen.getByRole('button', { name: zh.stopAll }))
    fireEvent.click(within(screen.getByRole('dialog', { name: zh.stopAll })).getByRole('button', { name: zh.stopAll }))
    await vi.waitFor(() => expect(remote.stopServices).toHaveBeenCalledExactlyOnceWith({ ids: [service.record.id, 'second'], force: true }))
  })
})
