export const NS = 'settings.serviceManager'
export const zh = {
  nav: '服务管理', title: '服务管理', hint: '按工作区和会话查看正在运行的服务。',
  workspace: '工作区', session: '会话', services: '服务',
  unassignedWorkspace: '未关联工作区', unassignedSession: '未关联会话',
  process: '进程', container: '容器', job: '后台任务', running: '运行中',
  refresh: '刷新', refreshing: '查询中…', loadFailed: '查询失败，请重试。',
  empty: '没有正在运行的服务', emptyHint: '后台任务和自动发现的服务会在这里显示。',
  forceStopHint: '确认强制停止此服务？未保存的数据可能丢失。',
  forceStop: '强制停止',
  cancel: '取消', close: '关闭', busy: '停止中…', error: '操作未完成',
  discoveryWarning: '部分资源未能自动发现',
} as const
export type ServiceKey = keyof typeof zh
export const en: Record<ServiceKey, string> = {
  nav: 'Services', title: 'Services', hint: 'Running services grouped by workspace and session.',
  workspace: 'Workspaces', session: 'Session', services: 'Services',
  unassignedWorkspace: 'No workspace', unassignedSession: 'No session',
  process: 'Process', container: 'Container', job: 'Background task', running: 'Running',
  refresh: 'Refresh', refreshing: 'Checking…', loadFailed: 'Could not load services. Please retry.',
  empty: 'No running services', emptyHint: 'Background tasks and automatically discovered services appear here.',
  forceStopHint: 'Force stop this service? Unsaved data may be lost.',
  forceStop: 'Force stop',
  cancel: 'Cancel', close: 'Close', busy: 'Stopping…', error: 'Action incomplete',
  discoveryWarning: 'Some resources could not be discovered',
}
