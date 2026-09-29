import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActionResult, ListResult, MutationResult, ServiceView, StopRequest } from '../types.ts'
import { groupServices, projectLabel, sessionLabel, sessionTargetId } from './service-tree.ts'
import css from './ServiceSection.module.css'

export interface ServiceFace {
  list(): Promise<ListResult>
  stop(request: StopRequest): Promise<MutationResult>
  /** Absent when the host exposes no Session navigation capability. */
  openSession?(session: string): void
}
export type ServiceSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.serviceManager'> & InjectFace<ServiceFace>
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Name the first failures; a batch can report more than a notice can read. */
function describeFailures(failures: readonly ActionResult[], names: ReadonlyMap<string, string>): string {
  const shown = failures.slice(0, 3).map(row => `${names.get(row.id) ?? row.id}: ${row.message}`)
  return failures.length > shown.length ? `${shown.join('; ')} …` : shown.join('; ')
}

export function ServiceSection({ list, stop, openSession, t }: ServiceSectionProps) {
  const [data, setData] = useState<ListResult>({ services: [], file: '' })
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showEnded, setShowEnded] = useState(false)
  const [action, setAction] = useState<ServiceView['record'] | null>(null)
  const [stoppingAll, setStoppingAll] = useState(false)
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

  const groups = groupServices(data.services, { includeEnded: showEnded })
  const running = groups.reduce((count, group) => count + group.count, 0)
  const ended = groups.reduce((count, group) => count + group.ended, 0)
  // Stop-all reads the full status list, so a hidden ended row never enters a batch.
  const runningServices = data.services.filter(service => service.status === 'running')

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

  const confirmAll = async () => {
    if (busy) return
    const targets = runningServices
    if (!targets.length) { setStoppingAll(false); return }
    const names = new Map(targets.map(service => [service.record.id, service.record.name]))
    setBusy(true)
    setError('')
    try {
      const result = await stop({ ids: targets.map(service => service.record.id), force: true })
      const failures = result.results.filter(row => !row.ok)
      await refresh()
      if (!mounted.current) return
      setStoppingAll(false)
      if (failures.length) setError(`${t('stopAllFailed', { count: failures.length })}: ${describeFailures(failures, names)}`)
    } catch (err) { if (mounted.current) { setStoppingAll(false); setError(message(err)) } }
    finally { if (mounted.current) setBusy(false) }
  }

  const jump = (session: string) => {
    if (!openSession) return
    setError('')
    try { openSession(session) }
    catch (err) { if (mounted.current) setError(`${t('openSessionFailed')}: ${message(err)}`) }
  }

  return <section className={css.section} aria-label={t('title')} aria-busy={loading || busy}>
    <header className={css.header}>
      <div>
        <h2>{t('title')} <span className={css.total}>{running}</span>{showEnded && ended > 0 && <span className={css.total}>{t('ended')} {ended}</span>}</h2>
        <p className={css.hint}>{t('hint')}</p>
      </div>
      <div className={css.controls}>
        <label className={css.toggle}>
          <input type="checkbox" checked={showEnded} disabled={busy} onChange={event => { setShowEnded(event.target.checked) }} />
          {t('showEnded')}
        </label>
        <Button variant="ghost" size="sm" disabled={loading || busy} onClick={() => { void refresh() }}>{loading ? t('refreshing') : t('refresh')}</Button>
        <Button variant="outline" size="sm" disabled={loading || busy || !running} onClick={() => { setStoppingAll(true) }}>{t('stopAll')}</Button>
      </div>
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
            {group.sessions.map(session => {
              const target = sessionTargetId(session.session)
              return <li key={session.session}>
                <details className={css.session} open>
                  <summary title={session.session}>
                    <span className={css.groupLabel}>{sessionLabel(session.session, t('session'), t('unassignedSession'))}</span>
                    <span className={css.count}>{session.running}{showEnded && session.ended > 0 && <span className={css.countEnded} title={t('ended')}>+{session.ended}</span>}</span>
                    {target && openSession && <button type="button" className={css.jump} onClick={event => { event.preventDefault(); event.stopPropagation(); jump(target) }}>{t('openSession')}</button>}
                  </summary>
                  <ul className={css.services} aria-label={t('services')}>
                    {session.services.map(({ record, status, detail }) => {
                      const identity = record.kind === 'process' ? String(record.pid) : record.kind === 'container' ? `${record.context} · ${record.containerId}` : record.jobId
                      return <li key={record.id} className={css.service} data-status={status}>
                        <span className={css.dot} data-status={status} title={t(status)} />
                        <div className={css.info}>
                          <strong title={record.name}>{record.name}</strong>
                          <span className={css.meta} title={status === 'running' ? identity : detail || identity}>
                            {t(record.kind)} · {record.kind === 'process' ? `PID ${record.pid}` : record.kind === 'container' ? record.containerId.slice(0, 12) : record.jobId}
                            {record.url && <> · <a className={css.url} href={record.url} target="_blank" rel="noopener noreferrer" title={record.url}>{record.url}</a></>}
                          </span>
                        </div>
                        {status === 'running'
                          ? <Button variant="outline" size="sm" disabled={busy || loading} onClick={() => setAction(record)}>{t('forceStop')}</Button>
                          : <span className={css.status} title={detail || undefined}>{t(status)}</span>}
                      </li>
                    })}
                  </ul>
                </details>
              </li>
            })}
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
    <Modal open={stoppingAll} onClose={() => { if (!busy) setStoppingAll(false) }} title={t('stopAll')} closeLabel={t('close')}
      description={t('stopAllHint', { count: running })}
      footer={<div className={css.actions}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setStoppingAll(false)} data-modal-autofocus>{t('cancel')}</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { void confirmAll() }}>{busy ? t('busy') : t('stopAll')}</Button>
      </div>}>
      <ul className={css.targets}>{runningServices.map(service => <li key={service.record.id} title={service.record.name}>{service.record.name}</li>)}</ul>
    </Modal>
  </section>
}
