import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ServiceRegistry } from './manager.ts'
import type { ListRequest, ListResult, MutationResult, RegisterRequest, RemoveRequest, ServiceRecord, StopRequest } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { serviceManager: ServiceManager }
}

export class ServiceManager extends TypertRemoteService {
  constructor(ctx: Context, readonly registry: ServiceRegistry) { super(ctx, 'serviceManager') }

  @Remote('listServices')
  async listServices(request: ListRequest): Promise<ListResult> {
    void request
    return this.registry.list()
  }

  @Remote('registerService')
  async registerService(request: RegisterRequest): Promise<ServiceRecord> { return this.registry.register(request) }

  @Remote('stopServices')
  async stopServices(request: StopRequest): Promise<MutationResult> { return this.registry.stop(request) }

  @Remote('removeServices')
  async removeServices(request: RemoveRequest): Promise<MutationResult> { return this.registry.remove(request) }
}
