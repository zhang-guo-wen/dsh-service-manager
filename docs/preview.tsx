import { createRoot } from 'react-dom/client'
import { ServiceSection } from '../src/client/ServiceSection.tsx'
import { zh } from '../src/client/locales.ts'
import type { ServiceView } from '../src/types.ts'
import type { ServiceFace } from '../src/client/ServiceSection.tsx'
import '@preview-harness/ui-theme/src/styles/design-platform.css'
import './preview.css'

const meta = { project: 'C:/02-codespace/Jianmen', session: 'session-4b8de650-ce90-484b-bacf-63c1d926ecef', url: '', createdAt: '2026-09-29T00:00:00.000Z' }
let services: ServiceView[] = [
  { record: { ...meta, id: '11111111-1111-4111-8111-111111111111', name: '前端开发服务器', kind: 'process', pid: 24816, startedAt: '63899911111', host: 'win32:dev', tree: true, pendingStop: [], url: 'http://localhost:5173' }, status: 'running', detail: 'node.exe', remaining: 1 },
  { record: { ...meta, id: '22222222-2222-4222-8222-222222222222', name: 'Redis 开发容器', kind: 'container', containerId: 'a4d820'.padEnd(64, 'b'), context: 'desktop-linux' }, status: 'running', detail: 'running; restart=no', remaining: 1 },
  { record: { ...meta, id: '33333333-3333-4333-8333-333333333333', name: '文档预览', kind: 'process', pid: 17920, startedAt: '63899722222', host: 'win32:dev', tree: false, pendingStop: [] }, status: 'stopped', detail: '', remaining: 0 },
  { record: { ...meta, id: '66666666-6666-4666-8666-666666666666', name: '报表预览服务器', kind: 'process', pid: 45340, startedAt: '63899733333', host: 'win32:dev', tree: false, pendingStop: [] }, status: 'changed', detail: 'PID was reused; the registered process has exited', remaining: 0 },
  { record: { ...meta, id: '77777777-7777-4777-8777-777777777777', name: '受限进程', kind: 'process', pid: 51200, startedAt: '63899744444', host: 'win32:dev', tree: false, pendingStop: [] }, status: 'unknown', detail: 'Process identity is inaccessible', remaining: 0 },
  { record: { ...meta, session: '报表预览', id: '44444444-4444-4444-8444-444444444444', name: '报表预览服务器', kind: 'process', pid: 29981, startedAt: '63899722222', host: 'win32:dev', tree: false, pendingStop: [] }, status: 'running', detail: '', remaining: 1 },
  { record: { ...meta, project: 'C:/02-codespace/DeepSeek', session: '前后端联调', name: '服务管理界面预览', kind: 'process', pid: 19920, startedAt: '63899722222', host: 'win32:dev', tree: false, pendingStop: [] }, status: 'running', detail: '', remaining: 1 },
]
const face: ServiceFace = {
  list: async () => ({ services: structuredClone(services), file: 'C:\\Users\\dev\\.dsh\\service-manager\\services.json' }),
  stop: async ({ ids }) => { services = services.map(row => ids.includes(row.record.id) ? { ...row, status: 'stopped', remaining: 0 } : row); return { results: ids.map(id => ({ id, ok: true, message: '' })) } },
  openSession: session => { console.log('openSession', session) },
}
createRoot(document.getElementById('root')!).render(<div className="preview-shell"><aside><h1>设置</h1><span>通用</span><span>模型</span><span>插件</span><strong>服务管理</strong></aside><main><ServiceSection {...face as any} t={(key: keyof typeof zh, params?: Record<string, unknown>) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), String(zh[key]))} /></main></div>)
