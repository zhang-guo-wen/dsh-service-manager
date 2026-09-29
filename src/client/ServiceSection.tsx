import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ListResult, MutationResult, ServiceView, StopRequest } from '../types.ts'
import { groupRunningServices, projectLabel, sessionLabel } from './service-tree.ts'
import css from './ServiceSection.module.css'

export interface ServiceFace {
  list(): Promise<ListResult>
  stop(request: StopRequest): Promise<MutationResult>
}
export type ServiceSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.serviceManager'> & InjectFace<ServiceFace>
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function ServiceSection({ list, stop, t }: ServiceSectionProps) {
  const [data, setData] = useState<ListResult>({ services: [], file: '' })
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [action, setAction] = useState<ServiceView['record'] | null>(null)
  const mounted = useRef(false)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const revision = ++generation.current
    setLoading(true)
    try {
      const next = await list()
      if (!mounted.current || revision !== generation.current) return
      setData(next)
      setLoaded(true)
      setError('')
    } catch (err) {
      if (mounted.current && revision === generation.current) {
        setData({ services: [], file: '' })
        setLoaded(false)
        setError(message(err))
      }
    } finally { if (mounted.current && revision === generation.current) setLoading(false) }
  }, [list])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false; generation.current++ }
  }, [refresh])

  const groups = groupRunningServices(data.services)
  const running = groups.reduce((count, group) => count + group.count, 0)

  const confirm = async () => {
    if (!action || busy) return
    const pending = action
    setBusy(true)
    setError('')
    try {
      const result = await stop({ ids: [pending.id], force: true })
      if (!mounted.current) return
      const failure = result.results.find(row => !row.ok)
      await refresh()
      if (!mounted.current) return
      setAction(null)
      if (failure) setError(`${pending.name}: ${failure.message}`)
    } catch (err) { if (mounted.current) { setAction(null); setError(message(err)) } }
    finally { if (mounted.current) setBusy(false) }
  }

  return <section className={css.section} aria-label={t('title')} aria-busy={loading || busy}>
    <header className={css.header}>
      <div><h2>{t('title')} <span className={css.total}>{running}</span></h2><p className={css.hint}>{t('hint')}</p></div>
      <Button variant="ghost" size="sm" disabled={loading || busy} onClick={() => { void refresh() }}>{loading ? t('refreshing') : t('refresh')}</Button>
    </header>
    {error && <p className={css.error} role="alert">{t('error')}: {error}</p>}
    {data.warnings?.map(warning => <p key={warning} className={css.error} role="alert">{t('discoveryWarning')}: {warning}</p>)}
    {!loaded ? <div className={css.empty} role="status">{loading ? t('refreshing') : t('loadFailed')}</div> : !groups.length ? <div className={css.empty}>
      <span className={css.emptyDot} /><strong>{t('empty')}</strong><p>{t('emptyHint')}</p>
    </div> : <ul className={css.workspaces} aria-label={t('workspace')}>
      {groups.map(group => <li key={group.project}>
        <details className={css.workspace} open>
          <summary title={group.project}><span className={css.groupLabel}>{projectLabel(group.project, t('unassignedWorkspace'))}</span><span className={css.count}>{group.count}</span></summary>
          <ul className={css.sessions} aria-label={t('session')}>
            {group.sessions.map(session => <li key={session.session}>
              <details className={css.session} open>
                <summary title={session.session}><span className={css.groupLabel}>{sessionLabel(session.session, t('session'), t('unassignedSession'))}</span><span className={css.count}>{session.services.length}</span></summary>
                <ul className={css.services} aria-label={t('services')}>
                  {session.services.map(({ record }) => <li key={record.id} className={css.service}>
                    <span className={css.dot} title={t('running')} />
                    <div className={css.info}>
                      <strong title={record.name}>{record.name}</strong>
                      <span className={css.meta} title={record.kind === 'process' ? String(record.pid) : record.kind === 'container' ? `${record.context} · ${record.containerId}` : record.jobId}>
                        {t(record.kind)} · {record.kind === 'process' ? `PID ${record.pid}` : record.kind === 'container' ? record.containerId.slice(0, 12) : record.jobId}
                        {record.url && <> · <a className={css.url} href={record.url} target="_blank" rel="noopener noreferrer" title={record.url}>{record.url}</a></>}
                      </span>
                    </div>
                    <Button variant="outline" size="sm" disabled={busy || loading} onClick={() => setAction(record)}>{t('forceStop')}</Button>
                  </li>)}
                </ul>
              </details>
            </li>)}
          </ul>
        </details>
      </li>)}
    </ul>}
    <Modal open={action !== null} onClose={() => { if (!busy) setAction(null) }} title={t('forceStop')} closeLabel={t('close')}
      description={t('forceStopHint')}
      footer={<div className={css.actions}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setAction(null)} data-modal-autofocus>{t('cancel')}</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { void confirm() }}>{busy ? t('busy') : t('forceStop')}</Button>
      </div>}>
      <p className={css.target}>{action?.name}</p>
    </Modal>
  </section>
}
