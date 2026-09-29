// Developer-only preview of the actual component and Harness primitives.
// No host services or Docker commands are invoked.
import { createServer } from 'vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const harness = resolve(process.env.DSH_HARNESS_ROOT || resolve(root, '../../deepseek-harness'))
const server = await createServer({
  configFile: false, root,
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: '@deepseek-ai/dsh-client-ui-primitives', replacement: resolve(root, 'docs/preview-primitives.ts') },
      { find: '@preview-harness', replacement: resolve(harness, 'packages/client') },
    ],
  },
  server: { host: '127.0.0.1', port: 4317, strictPort: true, fs: { allow: [root, harness] } },
})
await server.listen()
console.log('Service Manager preview: http://127.0.0.1:4317/docs/preview.html')
const close = async () => { await server.close(); process.exit(0) }
process.on('SIGINT', close)
process.on('SIGTERM', close)
