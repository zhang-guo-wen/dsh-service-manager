import z from 'zod'

const text = z.string().trim().max(512)
export const identitySchema = z.object({ pid: z.number().int().min(1).max(0x7fffffff), startedAt: z.string().min(1).max(256) }).strict()
const metadata = {
  id: z.string().uuid(), name: text.min(1), project: text, session: text,
  url: text.refine(value => {
    if (value === '') return true
    try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' } catch { return false }
  }),
  createdAt: z.string().datetime(),
}
export const registrySchema = z.object({
  version: z.literal(1),
  services: z.array(z.discriminatedUnion('kind', [
    z.object({ ...metadata, kind: z.literal('process'), ...identitySchema.shape, host: text.min(1), tree: z.boolean(), pendingStop: z.array(identitySchema).max(4096) }).strict(),
    z.object({ ...metadata, kind: z.literal('container'), containerId: z.string().regex(/^[a-f0-9]{64}$/), context: text.min(1) }).strict(),
  ])).max(4096),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.services.map(row => row.id)).size !== value.services.length) ctx.addIssue({ code: 'custom', message: 'Duplicate service record IDs' })
})

export const registerSchema = z.object({
  kind: z.enum(['process', 'container']), name: text.min(1),
  pid: identitySchema.shape.pid.optional(),
  container: text.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).optional(),
  context: text.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).optional(), tree: z.boolean().optional(),
  project: text.optional(), session: text.optional(), url: metadata.url.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'process' ? !value.pid || value.container !== undefined || value.context !== undefined : !value.container || value.pid !== undefined || value.tree !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'Provide a PID for a process, or a container reference and optional Docker context for a container' })
  }
})
export const idsSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }).strict()
export const stopSchema = idsSchema.extend({ force: z.boolean().optional() })
