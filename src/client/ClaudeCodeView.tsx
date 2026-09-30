/**
 * The "Claude Code" conversation view: a task tab strip on top and the live
 * Claude Code window filling everything below it.
 *
 * The panel is wide but short, so width is what it has to spend and height is
 * what it has to save: each delegation is one ellipsised tab (the strip scrolls
 * horizontally once they stop fitting), and everything a tab cannot hold — the
 * full task text, the model, the timings — moves into {@link JobDetailModal}
 * behind the tab's `ⓘ`.
 *
 * Two data sources meet here. Job identity and lifecycle come for free from the
 * harness's `session/jobs` push (mirrored into `jobsBySession`), so status
 * changes need no polling at all. Everything the mirror does not carry — the
 * full task text, cost/turns, the Claude session id, the live output — comes
 * from this plugin's own `claudeCode/*` remote, polled only while this tab is
 * mounted AND the selected job is still running.
 *
 * The harness unmounts non-active views entirely, so local state would be lost
 * on every tab switch; the per-session panel state therefore lives in a bounded
 * module-level cache and the view resumes reading where it left off.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClaudeCodeApi } from './api.js'
import type { ClaudeEvent, JobInfo, JobStatus, JobView, JobsClient, ViewProps } from './types.js'
import { EventView } from './EventView.js'
import { OutputView } from './OutputView.js'
import { JobDetailModal } from './JobDetailModal.js'
import { formatDuration, statusLabel } from './format.js'
import { CSS } from './styles.js'
import { t } from './locales.js'

/** Stable empty list so a session with no jobs keeps one array identity. */
const NO_JOBS: readonly JobView[] = []

/** This plugin's own delegations; every row it tracks carries this kind. */
const JOB_KIND = 'claude-code'

/**
 * Kinds the panel lists: our own delegations plus the harness's `subagent` jobs.
 * An official `subagent_claude_code` run is an ordinary background job, so it is
 * worth seeing here too — its output is read through the harness `observe`
 * stream, not through our tracker.
 */
const PANEL_KINDS: readonly string[] = [JOB_KIND, 'subagent']

/** Roster poll period for the plugin's own tracker list. */
const TRACKED_POLL_MS = 2000

/**
 * Hook-shaped stand-in for an absent `jobs` service, so the roster hook is
 * called exactly once per render either way and simply yields `undefined`.
 */
const NO_ROSTER: JobsClient['state'] = (select) => select({ rows: {} })

/** Dedupe rows by id, keeping the highest-priority (earliest) copy of each. */
function mergeRows(...lists: readonly (readonly JobView[])[]): JobView[] {
  const byId = new Map<string, JobView>()
  for (const list of lists) {
    for (const job of list) if (!byId.has(job.id)) byId.set(job.id, job)
  }
  return [...byId.values()]
}

/** Project one tracker row onto the row shape the panel renders. */
function trackedRow(job: JobInfo): JobView {
  return {
    id: job.jobId,
    kind: JOB_KIND,
    label: job.label,
    status: job.status,
    ...(job.failureDetail !== undefined ? { detail: job.failureDetail } : {}),
    startedAt: job.startedAt,
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
  }
}

/** Live-output poll period while the selected job runs. */
const POLL_MS = 1000

/** Sessions whose panel state is kept across tab switches. */
const MAX_CACHED_SESSIONS = 8

/** One job's accumulated output plus its absolute read cursor. */
interface OutputState {
  text: string
  offset: number
  truncated: boolean
}

/** One job's accumulated structured events plus its own absolute read cursor. */
interface EventState {
  list: ClaudeEvent[]
  offset: number
  truncated: boolean
}

/** Panel state that must survive the view being unmounted on a tab switch. */
interface PanelState {
  selected?: string
  outputs: Map<string, OutputState>
  events: Map<string, EventState>
}

const panels = new Map<string, PanelState>()

function panelOf(sessionId: string): PanelState {
  let panel = panels.get(sessionId)
  if (panel === undefined) {
    panel = { outputs: new Map(), events: new Map() }
    panels.set(sessionId, panel)
    // Bounded cache: drop the least recently created session's panel state.
    while (panels.size > MAX_CACHED_SESSIONS) {
      const oldest = panels.keys().next()
      if (oldest.done === true) break
      panels.delete(oldest.value)
    }
  }
  return panel
}

function isLive(job: JobView): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

/** Live rows first in start order, then settled rows newest-first (official order). */
function ordered(jobs: readonly JobView[]): JobView[] {
  return [...jobs].sort((left, right) => {
    const liveLeft = isLive(left)
    if (liveLeft !== isLive(right)) return liveLeft ? -1 : 1
    if (liveLeft) return left.startedAt - right.startedAt
    const finished = (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
    return finished !== 0 ? finished : left.startedAt - right.startedAt
  })
}

/** Tab status dot: blue and breathing while live, then a settled colour. */
function dotClass(status: JobStatus): string {
  switch (status) {
    case 'running':
    case 'stopping': return `${CSS.tabDot} ${CSS.tabDotRunning}`
    case 'completed': return `${CSS.tabDot} ${CSS.tabDotDone}`
    case 'killed': return `${CSS.tabDot} ${CSS.tabDotKilled}`
    default: return `${CSS.tabDot} ${CSS.tabDotFailed}`
  }
}

/** How many characters of a task label one tab shows before the ellipsis. */
const TAB_LABEL_CHARS = 14

/**
 * Cut a label to tab width. The stylesheet also ellipsises (a CJK label is far
 * wider than a latin one at the same length), but cutting here keeps a long
 * label from stretching the strip before CSS ever gets to clamp it.
 */
function clip(label: string): string {
  const flat = label.replace(/\s+/g, ' ').trim()
  return flat.length > TAB_LABEL_CHARS ? `${flat.slice(0, TAB_LABEL_CHARS)}…` : flat
}

/** Pick the job the panel should show when the current choice is gone. */
function defaultSelection(rows: JobView[]): string | undefined {
  const running = rows.filter(isLive)
  if (running.length) return running[running.length - 1]?.id
  return rows[0]?.id
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * Build the view component bound to one API surface. The connection service is
 * only reachable from the plugin context, so the binding happens at
 * registration time instead of through a prop.
 */
export function createClaudeCodeView(api: ClaudeCodeApi, jobs?: JobsClient | undefined) {
  return function ClaudeCodeView({ sessionId, useSessions }: ViewProps) {
    // 0.2 keeps this session's roster on the `jobs` client service; 0.1.x
    // mirrored it on the session store at `jobsBySession`. Neither may exist, so
    // the plugin's own tracker list below is the last-resort source.
    const native = (jobs?.state ?? NO_ROSTER)((state) => state.rows[sessionId])
    const mirrored = useSessions((state) => state.jobsBySession?.[sessionId]) ?? NO_JOBS
    const [tracked, setTracked] = useState<readonly JobView[]>(NO_JOBS)
    // Merged, not either/or: the plugin's own tracker list is the one source
    // that cannot lag a job's start, so a running delegation is listed — and its
    // live reads begin — within one poll even when the harness roster is empty
    // or late.
    const rows = useMemo(
      () => ordered(mergeRows(native ?? NO_JOBS, mirrored, tracked).filter((job) => PANEL_KINDS.includes(job.kind))),
      [native, mirrored, tracked],
    )

    // Keeps the 0.2 roster stream open for this session while the panel is up.
    useEffect(() => {
      if (jobs?.watchRows === undefined) return undefined
      return jobs.watchRows(sessionId)
    }, [jobs, sessionId])

    // Poll the plugin's own tracker list: cheap, and the only roster source that
    // can never miss a job that just started.
    useEffect(() => {
      let alive = true
      const load = () => {
        api.listJobs(sessionId).then(
          (list) => { if (alive) setTracked(list.map(trackedRow)) },
          () => {},
        )
      }
      load()
      const timer = setInterval(load, TRACKED_POLL_MS)
      return () => { alive = false; clearInterval(timer) }
    }, [api, native, sessionId])

    const panel = panelOf(sessionId)
    // Seeded from the cached choice (tab switch) or the default pick, so the
    // first paint already shows a job instead of the "pick one" placeholder.
    const [selected, setSelected] = useState<string | undefined>(() => panel.selected ?? defaultSelection(rows))
    const [meta, setMeta] = useState<Record<string, JobInfo>>({})
    const [error, setError] = useState<string | null>(null)
    const [now, setNow] = useState(() => Date.now())
    const [copied, setCopied] = useState<string | null>(null)
    // Job whose detail modal is open, or undefined when none is.
    const [detailFor, setDetailFor] = useState<string | undefined>(undefined)
    // Module-level output cache mutates in place; this counter republishes it.
    const [revision, setRevision] = useState(0)
    const bumpRef = useRef(() => { setRevision((value) => value + 1) })

    // Keep the selection valid as jobs appear, settle and age out.
    useEffect(() => {
      const stillThere = selected !== undefined && rows.some((job) => job.id === selected)
      const next = stillThere ? selected : defaultSelection(rows)
      if (next !== selected) setSelected(next)
      panel.selected = next
    }, [rows, selected, panel])

    const current = rows.find((job) => job.id === selected)
    const currentStatus = current?.status
    // Rows we did not run ourselves (the harness's own `subagent` jobs) have no
    // tracker entry: their output is read through the harness `observe` stream,
    // and our own RPCs would only fail on them.
    const ours = current === undefined || current.kind === JOB_KIND
    const observed = (jobs?.state ?? NO_ROSTER)((state) => (selected === undefined ? undefined : state.observed?.[selected]))

    useEffect(() => {
      if (jobs?.observe === undefined || ours || selected === undefined) return undefined
      return jobs.observe(sessionId, selected)
    }, [jobs, ours, sessionId, selected])

    // Re-fetch metadata whenever a job appears or changes lifecycle state.
    const lifecycle = rows.map((job) => `${job.id}:${job.status}`).join(',')

    useEffect(() => {
      const abort = new AbortController()
      api.listJobs(sessionId, abort.signal).then(
        (jobs) => {
          const next: Record<string, JobInfo> = {}
          for (const job of jobs) next[job.jobId] = job
          setMeta(next)
          setError(null)
        },
        (failure: unknown) => {
          if (abort.signal.aborted) return
          setError(`${t('error.prefix')}: ${failure instanceof Error ? failure.message : String(failure)}`)
        },
      )
      return () => { abort.abort() }
    }, [sessionId, lifecycle])

    // Live output: one immediate read, then a 1s poll only while it runs. The
    // status is a dependency, so settling triggers exactly one final read.
    // Two independent absolute cursors advance per tick: the structured event
    // stream the panel renders, and the raw text stream kept as a fallback and
    // as the source for "copy output".
    useEffect(() => {
      if (selected === undefined || !ours) return
      const jobId = selected
      const abort = new AbortController()
      let timer: ReturnType<typeof setInterval> | undefined

      const onFailure = (failure: unknown) => {
        if (abort.signal.aborted) return
        setError(`${t('error.prefix')}: ${failure instanceof Error ? failure.message : String(failure)}`)
      }

      const pullText = () => {
        const state = panel.outputs.get(jobId) ?? { text: '', offset: 0, truncated: false }
        api.readOutput(sessionId, jobId, state.offset, abort.signal).then(
          (chunk) => {
            if (chunk.text === '' && !chunk.truncated) return
            panel.outputs.set(jobId, {
              text: state.text + chunk.text,
              offset: chunk.nextOffset,
              truncated: state.truncated || chunk.truncated,
            })
            bumpRef.current()
          },
          onFailure,
        )
      }

      const pullEvents = () => {
        const state = panel.events.get(jobId) ?? { list: [], offset: 0, truncated: false }
        api.readEvents(sessionId, jobId, state.offset, abort.signal).then(
          (chunk) => {
            if (chunk.events.length === 0 && !chunk.truncated) return
            panel.events.set(jobId, {
              list: state.list.concat(chunk.events),
              offset: chunk.nextOffset,
              truncated: state.truncated || chunk.truncated,
            })
            bumpRef.current()
          },
          onFailure,
        )
      }

      const pull = () => {
        pullEvents()
        pullText()
      }

      pull()
      if (currentStatus === 'running' || currentStatus === 'stopping') {
        timer = setInterval(pull, POLL_MS)
      }
      return () => {
        abort.abort()
        if (timer !== undefined) clearInterval(timer)
      }
    }, [sessionId, selected, currentStatus, panel, ours])

    // Tick only while something is live, so an idle panel costs nothing.
    const liveCount = rows.filter(isLive).length
    useEffect(() => {
      if (liveCount === 0) return
      setNow(Date.now())
      const timer = setInterval(() => { setNow(Date.now()) }, 1000)
      return () => { clearInterval(timer) }
    }, [liveCount])

    const onCancel = useCallback((jobId: string) => {
      if (!window.confirm(t('action.cancel.confirm'))) return
      const row = rows.find((job) => job.id === jobId)
      // Official rows are stopped through the harness; ours through our own abort.
      if (row !== undefined && row.kind !== JOB_KIND && jobs?.kill !== undefined) {
        Promise.resolve(jobs.kill(sessionId, jobId)).catch((failure: unknown) => {
          setError(`${t('error.prefix')}: ${failure instanceof Error ? failure.message : String(failure)}`)
        })
        return
      }
      api.cancel(sessionId, jobId).catch((failure: unknown) => {
        setError(`${t('error.prefix')}: ${failure instanceof Error ? failure.message : String(failure)}`)
      })
    }, [sessionId, rows, jobs])

    const flashCopied = useCallback((token: string) => {
      setCopied(token)
      window.setTimeout(() => { setCopied((value) => (value === token ? null : value)) }, 1500)
    }, [])

    const detail = current ? meta[current.id] : undefined
    const output = current ? panel.outputs.get(current.id) : undefined
    const events = current ? panel.events.get(current.id) : undefined
    // `revision` is read so the memo-free render tracks the mutable cache.
    void revision

    // A job that aged out of the list must not leave its modal behind.
    const modalJob = detailFor === undefined ? undefined : rows.find((job) => job.id === detailFor)
    const closeDetail = useCallback(() => { setDetailFor(undefined) }, [])
    const copySession = useCallback((sessionId: string) => {
      void copy(sessionId).then((done) => { if (done) flashCopied('session') })
    }, [flashCopied])

    if (rows.length === 0) {
      return (
        <div className={CSS.root} data-conversation-composer-overlay="">
          <div className={CSS.empty}>
            <div className={CSS.emptyTitle}>{t('list.empty.title')}</div>
            <div>{t('list.empty.hint')}</div>
            <div>{t('list.empty.note')}</div>
          </div>
        </div>
      )
    }

    return (
      <div className={CSS.root} data-conversation-composer-overlay="">
        <div className={CSS.body}>
          {/* One tab per delegation, single line each; the strip scrolls
              horizontally rather than wrapping into a second row. */}
          <div className={CSS.tabs} role="tablist" aria-label={t('list.title')}>
            {rows.map((job) => {
              const active = job.id === selected
              return (
                <div key={job.id} role="presentation" className={active ? `${CSS.tab} ${CSS.tabActive}` : CSS.tab}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={CSS.tabMain}
                    title={job.label}
                    onClick={() => { setSelected(job.id); panel.selected = job.id }}
                  >
                    <span className={dotClass(job.status)} />
                    <span className={CSS.tabLabel}>{clip(job.label)}</span>
                  </button>
                  {/* Opening the detail must not also switch tabs. */}
                  <button
                    type="button"
                    className={CSS.tabInfo}
                    title={t('detail.open')}
                    aria-label={t('detail.open')}
                    onClick={(event) => { event.stopPropagation(); setDetailFor(job.id) }}
                  >
                    ⓘ
                  </button>
                </div>
              )
            })}
          </div>

          <div className={CSS.pane}>
            {current === undefined ? (
              <div className={CSS.empty}>{t('select.empty')}</div>
            ) : (
              <>
                <div className={CSS.paneHead}>
                  <div className={CSS.stats}>
                    <span className={CSS.stat}>{t('detail.job')}: <span className={CSS.mono}>{current.id}</span></span>
                    <span className={CSS.stat}>{statusLabel(current.status)}</span>
                    {detail?.numTurns !== undefined ? <span className={CSS.stat}>{detail.numTurns} {t('stats.turns')}</span> : null}
                    {detail?.costUsd !== undefined ? <span className={CSS.stat}>{t('stats.cost')} ${detail.costUsd.toFixed(4)}</span> : null}
                    <span className={CSS.stat}>
                      {t('stats.duration')} {formatDuration(isLive(current) ? now - current.startedAt : (current.finishedAt ?? current.startedAt) - current.startedAt)}
                    </span>
                    {current.detail !== undefined ? <span className={CSS.stat}>{current.detail}</span> : null}
                  </div>
                </div>

                {error !== null ? <div className={CSS.error}>{error}</div> : null}

                {/* The structured stream is the panel's face; the raw text pane
                    still answers for jobs that produced no events at all (a run
                    that failed before its first block, or a settled job restored
                    from `finalOutput`). */}
                {!ours ? (
                  <>
                    {observed?.gapBefore === true ? <div className={CSS.error}>{t('events.truncated')}</div> : null}
                    {observed?.error !== undefined ? <div className={CSS.error}>{observed.error}</div> : null}
                    <OutputView jobId={current.id} text={observed?.text ?? ''} truncated={false} />
                  </>
                ) : events !== undefined && events.list.length > 0 ? (
                  <EventView
                    jobId={current.id}
                    events={events.list}
                    truncated={events.truncated}
                    live={isLive(current)}
                  />
                ) : (
                  <OutputView
                    jobId={current.id}
                    text={output?.text ?? (detail?.finalOutput ?? '')}
                    truncated={output?.truncated ?? false}
                  />
                )}

                <div className={CSS.actions}>
                  {isLive(current) ? (
                    <button type="button" className={`${CSS.button} ${CSS.danger}`} onClick={() => { onCancel(current.id) }}>
                      {t('action.cancel')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={CSS.button}
                    disabled={(output?.text ?? detail?.finalOutput ?? observed?.text ?? '') === ''}
                    onClick={() => {
                      void copy(output?.text ?? detail?.finalOutput ?? observed?.text ?? '').then((done) => { if (done) flashCopied('output') })
                    }}
                  >
                    {copied === 'output' ? t('action.copied') : t('action.copyOutput')}
                  </button>
                  <button
                    type="button"
                    className={CSS.button}
                    disabled={detail?.claudeSessionId === undefined}
                    title={t('detail.session.hint')}
                    onClick={() => {
                      void copy(detail?.claudeSessionId ?? '').then((done) => { if (done) flashCopied('session') })
                    }}
                  >
                    {copied === 'session' ? t('action.copied') : t('action.copySession')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {modalJob === undefined ? null : (
          <JobDetailModal
            job={modalJob}
            detail={meta[modalJob.id]}
            now={now}
            onClose={closeDetail}
            onCopySession={copySession}
            copyLabel={copied === 'session' ? t('action.copied') : t('action.copySession')}
          />
        )}
      </div>
    )
  }
}
