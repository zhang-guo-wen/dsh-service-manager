import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ListRequest, ListResult, MutationResult, RegisterRequest, RemoveRequest, ServiceRecord, StopRequest } from '../types.ts'
import { REMOTE_NAMESPACE, TYPERT_REMOTE } from '../remote.ts'
import { NS, en, zh, type ServiceKey } from './locales.ts'
import { ServiceSection, type ServiceFace } from './ServiceSection.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.serviceManager': ServiceKey }
}
interface RemoteService {
  listServices(request: ListRequest): Promise<RemoteResult<ListResult>>
  registerService(request: RegisterRequest): Promise<RemoteResult<ServiceRecord>>
  stopServices(request: StopRequest): Promise<RemoteResult<MutationResult>>
  removeServices(request: RemoveRequest): Promise<RemoteResult<MutationResult>>
}
/** Structural lookup keeps optional host services out of the plugin's runtime dependencies. */
interface SessionNavigator { openSession(target: string): void }
async function unwrap<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
export const inject = ['slots', 'locale', 'remote']
export async function apply(ctx: Context): Promise<void> {
  const off = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => () => off(), 'service-manager: remote mount')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'service-manager: dictionaries')
  const t = ctx.locale.bind(NS)
  const remote = (): RemoteService => {
    const service = ctx.get(`remote.${REMOTE_NAMESPACE}`) as RemoteService | undefined
    if (!service) throw new Error('serviceManager namespace is not mounted')
    return service
  }
  const face: ServiceFace = {
    list: () => unwrap(remote().listServices({})),
    stop: request => unwrap(remote().stopServices(request)),
    // Resolved on use: the Workspace navigation service may load after this plugin.
    openSession: session => {
      const workspace = ctx.get('uiWorkspace') as SessionNavigator | undefined
      if (typeof workspace?.openSession !== 'function') throw new Error('session navigation is unavailable')
      workspace.openSession(session)
    },
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'service-manager', order: 15.5,
    label: () => t('nav'), locale: NS, inject: () => face,
  }, ServiceSection))
}
