import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'
import { TYPERT_REMOTE } from '../src/remote.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null, Modal: () => null }))
describe('client integration', () => {
  it('registers a page immediately after Plugins and disposes only UI contributions', async () => {
    const cleanups: (() => void)[] = []
    const offRemote = vi.fn()
    const offLocale = vi.fn()
    const register = vi.fn(() => vi.fn())
    const ctx = {
      remote: { $mount: vi.fn(async () => offRemote) },
      locale: { register: vi.fn(() => offLocale), bind: () => (key: string) => key },
      effect: (fn: () => (() => void)) => { cleanups.push(fn()) },
      slots: { inject: (_name: string, fn: () => void) => fn(), register },
    }
    await apply(ctx as unknown as Context)
    expect(ctx.remote.$mount).toHaveBeenCalledWith(TYPERT_REMOTE)
    expect(register.mock.calls[0]?.[0]).toMatchObject({ name: 'settings.section', id: 'service-manager', order: 15.5, locale: 'settings.serviceManager' })
    expect(TYPERT_REMOTE.descriptors.map(row => row.method)).toEqual(['listServices', 'registerService', 'stopServices', 'removeServices'])
    cleanups.forEach(fn => fn())
    expect(offRemote).toHaveBeenCalledOnce()
    expect(offLocale).toHaveBeenCalledOnce()
  })
})
