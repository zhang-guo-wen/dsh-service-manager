import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Modal, StateDot, Tag, Toast, relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RelativeTimeUnit, StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActionResult, ListCandidatesResult, ListResult, MutationResult, RegisterRequest, RemoveRequest, ServiceCandidate, ServiceView, StopRequest } from '../types.ts'
import { groupServices, projectLabel, sessionLabel, sessionTargetId } from './service-tree.ts'
import css from './ServiceSection.module.css'

export interface ServiceFace {
  list(): Promise<ListResult>
  stop(request: StopRequest): Promise<MutationResult>
  remove(request: RemoveRequest): Promise<MutationResult>
  /** Local listening services the user can adopt; the host starts one `netstat`/`ss` read per call. */
  candidates(): Promise<ListCandidatesResult>
  claim(request: RegisterRequest): Promise<unknown>
  /** Absent when the host exposes no Session navigation capability. */
  openSession?(session: string): void
  /** Names the Session list shows for its rows; absent when the host mounts no Session catalog. */
  sessionTitles?(): ReadonlyMap<string, string>
  /** Watch the Session list for renames; a host without the catalog never notifies. */
  subscribeSessions?(listener: () => void): () => void
}
export type ServiceSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.serviceManager'> & InjectFace<ServiceFace>
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const noTitles: ReadonlyMap<string, string> = new Map()
const noSubscription = (): void => {}

/** Which write is in flight; `id` names the candidate row a claim acts on. */
type PendingWrite = { readonly kind: 'stop' | 'stopAll' | 'stopLegacy' | 'remove' | 'claim'; readonly id?: string }

/** The locale key naming each relative-time bucket the host returns. */
const TIME_KEYS: Record<RelativeTimeUnit, 'timeNow' | 'timeMinutes' | 'timeHours' | 'timeDays' | 'timeMonths' | 'timeYears'> = {
  now: 'timeNow',
  minutes: 'timeMinutes',
  hours: 'timeHours',
  days: 'timeDays',
  months: 'timeMonths',
  years: 'timeYears',
}

/** The host dot vocabulary for this plugin's statuses; the text beside it names the state. */
const STATUS_DOT: Record<ServiceView['status'], StateDotState> = {
  running: 'done',
  stopped: 'idle',
  changed: 'warning',
  unknown: 'idle',
}

/** Name the first failures; a batch can report more than a notice can read. */
function describeFailures(failures: readonly ActionResult[], names: ReadonlyMap<string, string>): string {
  const shown = failures.slice(0, 3).map(row => `${names.get(row.id) ?? row.id}: ${row.message}`)
  return failures.length > shown.length ? `${shown.join('; ')} …` : shown.join('; ')
}

export function ServiceSection({ list, stop, remove, candidates, claim, openSession, sessionTitles, subscribeSessions, close, t }: ServiceSectionProps) {
  const [data, setData] = useState<ListResult>({ services: [], file: '' })
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  // One write at a time; the dialog that owns it reports in progress itself.
  const [pending, setPending] = useState<PendingWrite | null>(null)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [sessionError, setSessionError] = useState('')
  /**
   * The settled outcome of the last stop, remove or claim, reported in the host's
   * floating banner: the service tree can be long, so a line under it scrolls out
   * of view exactly when the reader wants the answer. `seq` restarts the hold
   * when the same outcome is reported again.
   */
  const [notice, setNotice] = useState<{ text: string; seq: number } | null>(null)
  const noticeSeq = useRef(0)
  const reportNotice = (text: string): void => {
    noticeSeq.current += 1
    setNotice({ text, seq: noticeSeq.current })
  }
  const [claimError, setClaimError] = useState<{ readonly key: string; readonly message: string } | null>(null)
  const [showEnded, setShowEnded] = useState(false)
  const [action, setAction] = useState<ServiceView['record'] | null>(null)
  const [stoppingAll, setStoppingAll] = useState(false)
  const [removing, setRemoving] = useState<ServiceView['record'] | null>(null)
  const [stoppingLegacy, setStoppingLegacy] = useState(false)
  const [adopting, setAdopting] = useState(false)
  const [adoptRows, setAdoptRows] = useState<ServiceCandidate[]>([])
  const [adoptLoading, setAdoptLoading] = useState(false)
  const [adoptError, setAdoptError] = useState('')
  const mounted = useRef(false)
  const generation = useRef(0)
  const busy = pending !== null
  // The Session list arrives asynchronously and rows can be renamed at any time,
  // so subscribe to the host's own store instead of reading it once.
  const readTitles = useCallback((): ReadonlyMap<string, string> => sessionTitles?.() ?? noTitles, [sessionTitles])
  const watchSessions = useCallback((notify: () => void): (() => void) => subscribeSessions?.(notify) ?? noSubscription, [subscribeSessions])
  const titles = useSyncExternalStore(watchSessions, readTitles, readTitles)

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
      // A failed read keeps the rows already on screen; the band above them says
      // they are the last successful read rather than the current query's answer.
      if (mounted.current && revision === generation.current) setError(message(err))
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
  const legacyServices = runningServices.filter(service => service.legacy)
  // Relative buckets come from the host; the words stay in this dictionary.
  const now = Date.now()
  const trackedAt = (createdAt: string): string => {
    const at = Date.parse(createdAt)
    if (!Number.isFinite(at)) return ''
    const { unit, n } = relativeTime(at, now)
    return t('trackedFor', { time: t(TIME_KEYS[unit], { count: n }) })
  }

  const confirm = async () => {
    if (!action || busy) return
    const target = action
    setPending({ kind: 'stop', id: target.id })
    setActionError('')
    setNotice(null)
    try {
      const result = await stop({ ids: [target.id], force: true })
      if (!mounted.current) return
      const failure = result.results.find(row => !row.ok)
      await refresh()
      if (!mounted.current) return
      // A failure keeps the dialog, its target, and the retry in place.
      if (failure) { setActionError(`${target.name}: ${failure.message}`); return }
      setAction(null)
      reportNotice(t('stoppedOne'))
    } catch (err) { if (mounted.current) setActionError(message(err)) }
    finally { if (mounted.current) setPending(null) }
  }

  const confirmAll = async () => {
    if (busy) return
    const targets = runningServices
    if (!targets.length) { setStoppingAll(false); return }
    const names = new Map(targets.map(service => [service.record.id, service.record.name]))
    setPending({ kind: 'stopAll' })
    setActionError('')
    setNotice(null)
    try {
      const result = await stop({ ids: targets.map(service => service.record.id), force: true })
      const failures = result.results.filter(row => !row.ok)
      await refresh()
      if (!mounted.current) return
      if (failures.length) { setActionError(`${t('stopAllFailed', { count: failures.length })}: ${describeFailures(failures, names)}`); return }
      setStoppingAll(false)
      reportNotice(t('stoppedAll'))
    } catch (err) { if (mounted.current) setActionError(message(err)) }
    finally { if (mounted.current) setPending(null) }
  }

  const jump = (session: string) => {
    if (!openSession) return
    setSessionError('')
    try {
      openSession(session)
      // This section lives inside the settings panel, so leaving it open would
      // hide the session that just became current.
      close?.()
    }
    catch (err) { if (mounted.current) setSessionError(`${t('openSessionFailed')}: ${message(err)}`) }
  }

  /** Stop every running service that predates this Harness run, after explicit confirmation. */
  const confirmLegacy = async () => {
    if (busy) return
    const targets = legacyServices
    if (!targets.length) { setStoppingLegacy(false); return }
    const names = new Map(targets.map(service => [service.record.id, service.record.name]))
    setPending({ kind: 'stopLegacy' })
    setActionError('')
    setNotice(null)
    try {
      const result = await stop({ ids: targets.map(service => service.record.id), force: true })
      const failures = result.results.filter(row => !row.ok)
      await refresh()
      if (!mounted.current) return
      if (failures.length) { setActionError(`${t('stopLegacyFailed', { count: failures.length })}: ${describeFailures(failures, names)}`); return }
      setStoppingLegacy(false)
      reportNotice(t('stoppedLegacy'))
    } catch (err) { if (mounted.current) setActionError(message(err)) }
    finally { if (mounted.current) setPending(null) }
  }

  /** Drop one record without touching its resource. */
  const confirmRemove = async () => {
    if (!removing || busy) return
    const target = removing
    setPending({ kind: 'remove', id: target.id })
    setActionError('')
    setNotice(null)
    try {
      const result = await remove({ ids: [target.id] })
      const failures = result.results.filter(row => !row.ok)
      await refresh()
      if (!mounted.current) return
      if (failures.length) { setActionError(`${t('removeRecordFailed', { count: failures.length })}: ${describeFailures(failures, new Map([[target.id, target.name]]))}`); return }
      setRemoving(null)
      reportNotice(t('removedOne'))
    } catch (err) { if (mounted.current) setActionError(message(err)) }
    finally { if (mounted.current) setPending(null) }
  }

  const scanCandidates = useCallback(async () => {
    setAdoptLoading(true)
    setAdoptError('')
    try {
      const result = await candidates()
      if (!mounted.current) return
      setAdoptRows(result.candidates)
      if (result.warnings?.length) setAdoptError(result.warnings.join('; '))
    } catch (err) { if (mounted.current) { setAdoptRows([]); setAdoptError(message(err)) } }
    finally { if (mounted.current) setAdoptLoading(false) }
  }, [candidates])

  const openAdopt = () => { setActionError(''); setClaimError(null); setAdopting(true); void scanCandidates() }

  /** Adopt one listening process; only the process itself is followed, never its children. */
  const claimOne = async (candidate: ServiceCandidate) => {
    const key = `${candidate.pid}:${candidate.port}`
    setPending({ kind: 'claim', id: key })
    setAdoptError('')
    setClaimError(null)
    setNotice(null)
    try {
      await claim({ kind: 'process', name: `${candidate.name} (:${candidate.port})`.slice(0, 512), pid: candidate.pid, tree: false })
      if (!mounted.current) return
      setAdoptRows(rows => rows.filter(row => row.pid !== candidate.pid || row.port !== candidate.port))
      reportNotice(t('claimedOne', { name: candidate.name }))
      await refresh()
    } catch (err) { if (mounted.current) setClaimError({ key, message: message(err) }) }
    finally { if (mounted.current) setPending(null) }
  }
  // A candidate row whose claim failed keeps its place and its retry.
  const claimKey = (candidate: ServiceCandidate): string => `${candidate.pid}:${candidate.port}`

  return <section className={css.section} aria-label={t('title')} aria-busy={loading || busy}>
    <header className={css.header}>
      <div className={css.heading}>
        <h2>{t('title')} <Tag tone="neutral">{running}</Tag>{showEnded && ended > 0 && <Tag tone="quiet">{t('ended')} {ended}</Tag>}{legacyServices.length > 0 && <span className={css.legacyTotal} title={t('legacyTitle')}>{t('legacy')} {legacyServices.length}</span>}</h2>
        <p className={css.hint}>{t('hint')}</p>
      </div>
      <div className={css.controls}>
        <label className={css.toggle}>
          <input type="checkbox" checked={showEnded} disabled={busy} onChange={event => { setShowEnded(event.target.checked) }} />
          {t('showEnded')}
        </label>
        <Button variant="ghost" size="sm" disabled={loading || busy} onClick={() => { void refresh() }}>{loading ? t('refreshing') : t('refresh')}</Button>
        <Button variant="ghost" size="sm" disabled={loading || busy} onClick={openAdopt}>{t('adopt')}</Button>
        {legacyServices.length > 0 && <Button variant="outline" size="sm" disabled={loading || busy} onClick={() => { setActionError(''); setStoppingLegacy(true) }}>{t('stopLegacy')}</Button>}
        <Button variant="outline" size="sm" disabled={loading || busy || !running} onClick={() => { setActionError(''); setStoppingAll(true) }}>{t('stopAll')}</Button>
      </div>
    </header>
    {loaded && error && <p className={css.error} role="alert">
      <span>{t('error')}: {error} {t('staleHint')}</span>
      <Button size="sm" variant="outline" disabled={loading || busy} onClick={() => { void refresh() }}>{t('retry')}</Button>
    </p>}
    {sessionError && <p className={css.error} role="alert">{sessionError}</p>}
    {data.warnings?.map(warning => <p key={warning} className={css.error} role="alert">{t('discoveryWarning')}: {warning}</p>)}
    {!loaded
      ? <div className={css.empty}>
        {loading
          ? <p className={css.hint} role="status">{t('refreshing')}</p>
          : <><strong>{t('loadFailed')}</strong>
            {error && <p className={css.error} role="alert">{error}</p>}
            <Button size="sm" variant="outline" className={css.emptyAction} disabled={loading || busy} onClick={() => { void refresh() }}>{t('retry')}</Button></>}
      </div>
      : !groups.length
        ? <div className={css.empty}>
          <StateDot state="idle" size={10} /><strong>{t('empty')}</strong><p>{t('emptyHint')}</p>
          <Button size="sm" variant="outline" className={css.emptyAction} disabled={loading || busy} onClick={openAdopt}>{t('emptyAction')}</Button>
        </div>
        : <ul className={css.workspaces} aria-label={t('workspace')}>
          {groups.map(group => <li key={group.project}>
            <details className={css.workspace} open>
              <summary title={group.project}><span className={css.groupLabel}>{projectLabel(group.project, t('unassignedWorkspace'))}</span><span className={css.count}>{group.count}</span></summary>
              <ul className={css.sessions} aria-label={t('session')}>
                {group.sessions.map(session => {
                  const target = sessionTargetId(session.session)
                  return <li key={session.session}>
                    <details className={css.session} open>
                      <summary title={session.session}>
                        <span className={css.groupLabel}>{sessionLabel(session.session, titles.get(session.session), t('session'), t('unassignedSession'))}</span>
                        <span className={css.count}>{session.running}{showEnded && session.ended > 0 && <span className={css.countEnded} title={t('ended')}>+{session.ended}</span>}</span>
                        {target && openSession && <button type="button" className={css.jump} onClick={event => { event.preventDefault(); event.stopPropagation(); jump(target) }}>{t('openSession')}</button>}
                      </summary>
                      <ul className={css.services} aria-label={t('services')}>
                        {session.services.map(({ record, status, detail, legacy }) => {
                          const identity = record.kind === 'process' ? String(record.pid) : record.kind === 'container' ? `${record.context} · ${record.containerId}` : record.jobId
                          return <li key={record.id} className={css.service} data-status={status}>
                            {/* The dot is decoration; the status word beside it carries the state. */}
                            <StateDot state={STATUS_DOT[status]} size={8} />
                            <div className={css.info}>
                              <strong title={record.name}>{record.name}</strong>
                              <span className={css.meta} title={status === 'running' ? identity : detail || identity}>
                                {t(record.kind)} · {record.kind === 'process' ? `PID ${record.pid}` : record.kind === 'container' ? record.containerId.slice(0, 12) : record.jobId}
                                {record.url && <> · <a className={css.url} href={record.url} target="_blank" rel="noopener noreferrer" title={record.url}>{record.url}</a></>}
                              </span>
                            </div>
                            {legacy && status === 'running' && <span className={css.legacy} title={t('legacyTitle')}>{t('legacy')}</span>}
                            <span className={css.when} title={record.createdAt}>{trackedAt(record.createdAt)}</span>
                            <span className={css.status} title={detail || undefined}>{t(status)}</span>
                            {status === 'running'
                              ? <Button variant="outline" size="sm" disabled={busy || loading} onClick={() => { setActionError(''); setAction(record) }}>{t('forceStop')}</Button>
                              : <Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => { setActionError(''); setRemoving(record) }}>{t('removeRecord')}</Button>}
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
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { void confirm() }}>{pending?.kind === 'stop' ? t('busy') : t('forceStop')}</Button>
      </div>}>
      <p className={css.target}>{action?.name}</p>
      {pending?.kind === 'stop' && <p className={css.busy} role="status">{t('busy')}</p>}
      {actionError && <p className={css.error} role="alert">
        <span>{actionError} {t('dialogRetryHint')}</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void confirm() }}>{t('retry')}</Button>
      </p>}
    </Modal>
    <Modal open={stoppingAll} onClose={() => { if (!busy) setStoppingAll(false) }} title={t('stopAll')} closeLabel={t('close')}
      description={t('stopAllHint', { count: running })}
      footer={<div className={css.actions}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setStoppingAll(false)} data-modal-autofocus>{t('cancel')}</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { void confirmAll() }}>{pending?.kind === 'stopAll' ? t('busy') : t('stopAll')}</Button>
      </div>}>
      <ul className={css.targets}>{runningServices.map(service => <li key={service.record.id} title={service.record.name}>{service.record.name}</li>)}</ul>
      {actionError && <p className={css.error} role="alert">
        <span>{actionError} {t('dialogRetryHint')}</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void confirmAll() }}>{t('retry')}</Button>
      </p>}
    </Modal>
    <Modal open={stoppingLegacy} onClose={() => { if (!busy) setStoppingLegacy(false) }} title={t('stopLegacy')} closeLabel={t('close')}
      description={t('stopLegacyHint', { count: legacyServices.length })}
      footer={<div className={css.actions}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setStoppingLegacy(false)} data-modal-autofocus>{t('cancel')}</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { void confirmLegacy() }}>{pending?.kind === 'stopLegacy' ? t('busy') : t('stopLegacy')}</Button>
      </div>}>
      <ul className={css.targets}>{legacyServices.map(service => <li key={service.record.id} title={service.record.name}>{service.record.name}</li>)}</ul>
      {actionError && <p className={css.error} role="alert">
        <span>{actionError} {t('dialogRetryHint')}</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void confirmLegacy() }}>{t('retry')}</Button>
      </p>}
    </Modal>
    <Modal open={removing !== null} onClose={() => { if (!busy) setRemoving(null) }} title={t('removeRecord')} closeLabel={t('close')}
      description={t('removeRecordHint')}
      footer={<div className={css.actions}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setRemoving(null)} data-modal-autofocus>{t('cancel')}</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { void confirmRemove() }}>{pending?.kind === 'remove' ? t('removing') : t('removeRecord')}</Button>
      </div>}>
      <p className={css.target}>{removing?.name}</p>
      {pending?.kind === 'remove' && <p className={css.busy} role="status">{t('removing')}</p>}
      {actionError && <p className={css.error} role="alert">
        <span>{actionError} {t('dialogRetryHint')}</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void confirmRemove() }}>{t('retry')}</Button>
      </p>}
    </Modal>
    <Modal open={adopting} onClose={() => { if (!adoptLoading && !busy) setAdopting(false) }} title={t('adoptTitle')} closeLabel={t('close')}
      description={t('adoptHint')}
      footer={<div className={css.actions}>
        <Button variant="ghost" size="sm" disabled={adoptLoading || busy} onClick={() => { void scanCandidates() }}>{adoptLoading ? t('adoptScanned') : t('refresh')}</Button>
        <Button variant="outline" size="sm" disabled={adoptLoading || busy} onClick={() => setAdopting(false)} data-modal-autofocus>{t('close')}</Button>
      </div>}>
      {adoptError && <p className={css.error} role="alert">{adoptError}</p>}
      {!adoptRows.length
        ? <p className={css.target}>{adoptLoading ? t('adoptScanned') : t('adoptEmpty')}</p>
        : <ul className={css.candidates}>{adoptRows.map(candidate => {
          const key = claimKey(candidate)
          const failing = claimError?.key === key
          return <li key={key} className={css.candidate}>
            <div className={css.info}>
              <strong title={candidate.name}>{candidate.name}</strong>
              <span className={css.meta}>{candidate.protocol} · {candidate.address} · PID {candidate.pid}</span>
            </div>
            {pending?.kind === 'claim' && pending.id === key && <span className={css.busy} role="status">{t('claiming')}</span>}
            {failing && <span className={css.error} role="alert">{claimError.message}</span>}
            <Button variant="outline" size="sm" disabled={adoptLoading || busy} onClick={() => { void claimOne(candidate) }}>{failing ? t('retry') : t('adoptOne')}</Button>
          </li>
        })}</ul>}
    </Modal>
    {/* The settled outcome of the last stop, remove or claim, in the host's
        floating banner: the service tree can be long, so a line under it scrolls
        out of view exactly when the reader wants the answer. */}
    {notice !== null && <Toast key={notice.seq} text={notice.text} tone="success"
      onDone={() => { setNotice(current => current?.seq === notice.seq ? null : current) }} />}
  </section>
}
