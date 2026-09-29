import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ServiceRegistry } from './manager.ts'

/** Registration belongs to host discovery/API; agents can inspect and explicitly stop. */
export function registerTools(ctx: Context, registry: ServiceRegistry): void {
  const tools = ctx.get('tools')
  if (!tools) return
  const output = {
    schema: { type: 'object' as const, additionalProperties: false, properties: { json: { type: 'string' as const, required: true as const } } },
    render: (_args: unknown, value: { json: string }) => [{ type: 'text' as const, text: value.json }],
  }
  ctx.effect(() => tools.register(defineTool({
    name: 'service_list', description: 'List registered services with freshly queried status. Unknown means status could not be verified.',
    parameters: {}, output,
    async execute() { return { json: JSON.stringify(await registry.list()) } },
  })), 'service-manager: list tool')
  ctx.effect(() => tools.register(defineTool({
    name: 'service_stop', description: 'Manually stop registered services by record ID. Use only when the user requests stopping them. Never stop on session completion, plugin unload, or Harness shutdown. Force must be explicitly requested; it may lose unsaved work.',
    parameters: { ids: { type: 'array', items: { type: 'string' }, required: true }, force: { type: 'boolean' } }, output,
    async execute(args) { return { json: JSON.stringify(await registry.stop(args)) } },
  })), 'service-manager: stop tool')
}
