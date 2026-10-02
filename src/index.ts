import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { RegistryStore } from './store.ts'
import { ServiceRegistry } from './manager.ts'
import { ServiceManager } from './service-remote.ts'
import { installAutomatic } from './automatic.ts'
import { installDockerDiscovery } from './docker-discovery.ts'

export { ServiceRegistry } from './manager.ts'
export { RegistryStore } from './store.ts'
export { ServiceManager } from './service-remote.ts'
export type * from './types.ts'
export const name = 'service-manager'
export const inject = []
export interface Config { dshHome?: string; file?: string }
export const Config = z.object({ dshHome: z.string().description('Harness user-data home override'), file: z.string().description('Registry JSON file override') })

export function apply(ctx: Context, config: Config = {}): void {
  const file = config.file ? resolve(config.file) : join(resolveDshHome(config.dshHome), 'service-manager', 'services.json')
  const registry = new ServiceRegistry(new RegistryStore(file))
  const automatic = installAutomatic(ctx, registry.store)
  registry.discovery = automatic
  installDockerDiscovery(ctx, automatic)
  new ServiceManager(ctx, registry)
  // No model-facing tools: discovery is automatic (see `installAutomatic`) and
  // stopping a resource is a user action in the settings section. Registering
  // `service_list` / `service_stop` made the model a second surface for both,
  // which is what this plugin's design keeps out.
  // Observer disposal removes hooks only. Resource stopping remains manual.
}
