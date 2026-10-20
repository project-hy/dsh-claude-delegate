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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClaudeCodeApi } from './api.js'
import type { ClaudeEvent, JobInfo, JobStatus, JobView, JobsClient, ViewProps, WorkstreamView } from './types.js'
import { EventView } from './EventView.js'
import { OutputView } from './OutputView.js'
import { JobDetailModal } from './JobDetailModal.js'
import { formatDuration, statusLabel } from './format.js'
import { CSS } from './styles.js'
import { t, tf } from './locales.js'

/** Stable empty list so a session with no jobs keeps one array identity. */
const NO_JOBS: readonly JobView[] = []
const NO_LINES: readonly WorkstreamView[] = []

/** This plugin's own delegations; every row it tracks carries this kind. */
const JOB_KIND = 'claude-code'

/**
 * Kinds the panel lists: our own delegations plus the harness's `subagent` jobs.
 * A native subagent run is an ordinary background job, so it is worth seeing
 * here too — its output is read through the harness `observe` stream, not
 * through our tracker.
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
    // Only our own rows carry a conversation; it is what folds them together.
    ...(job.claudeSessionId !== undefined ? { claudeSessionId: job.claudeSessionId } : {}),
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
  /**
   * Last known row list. A tab switch unmounts the view and the rosters do not
   * necessarily hand back settled jobs on re-subscribe, so without this the tab
   * strip could come back blank while the jobs were still there on the host.
   */
  rows?: readonly JobView[]
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

/** One Claude conversation: every run that shares a session id, oldest first. */
interface JobGroup {
  /** Conversation id when there is one, otherwise the single run's job id. */
  key: string
  jobs: JobView[]
}

/**
 * Fold one conversation's runs into one tab.
 *
 * The host records one job per delegation call, so a continued conversation
 * arrived as claude-code-2, claude-code-3, … and the strip grew one tab per
 * call even though the Claude session never changed. Rows without a session id
 * (the harness's own `subagent` jobs, runs that failed before reporting one)
 * stay single-run groups.
 */
function groupsOf(rows: readonly JobView[]): JobGroup[] {
  const byKey = new Map<string, JobGroup>()
  for (const job of rows) {
    const key = job.claudeSessionId ?? job.id
    const group = byKey.get(key)
    if (group === undefined) byKey.set(key, { key, jobs: [job] })
    else group.jobs.push(job)
  }
  for (const group of byKey.values()) {
    group.jobs.sort((left, right) => left.startedAt - right.startedAt)
  }
  return [...byKey.values()]
}

/** The run a group's tab reports on: the live one, else the newest. */
function headOf(group: JobGroup): JobView | undefined {
  const live = group.jobs.filter(isLive)
  return live[live.length - 1] ?? group.jobs[group.jobs.length - 1]
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

/** Pick the conversation the panel should show when the current choice is gone. */
function defaultSelection(groups: readonly JobGroup[]): string | undefined {
  const running = groups.filter((group) => group.jobs.some(isLive))
  if (running.length) return running[running.length - 1]?.key
  return groups[0]?.key
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
    const panel = panelOf(sessionId)
    const [tracked, setTracked] = useState<readonly JobView[]>(() => panel.rows ?? NO_JOBS)
    // Merged, not either/or: the plugin's own tracker list is the one source
    // that cannot lag a job's start, so a running delegation is listed — and its
    // live reads begin — within one poll even when the harness roster is empty
    // or late.
    const rows = useMemo(
      () => ordered(mergeRows(native ?? NO_JOBS, mirrored, tracked).filter((job) => PANEL_KINDS.includes(job.kind))),
      [native, mirrored, tracked],
    )

    // Stable identity matters: the persisted-output reader holds this in a ref so
    // one load survives re-renders, and a fresh closure each time would restart it.
    const readFile = useCallback(
      (filePath: string, fromOffset: number, limit: number) =>
        api.readOutputFile(sessionId, filePath, fromOffset, limit),
      [api, sessionId],
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
          (list) => {
            if (!alive) return
            const mapped = list.map(trackedRow)
            setTracked(mapped)
            panel.rows = mapped
          },
          // Never swallow this: an empty tab strip is exactly what a failing
          // list RPC looks like, and silence made it undiagnosable.
          (failure: unknown) => {
            if (!alive) return
            setError(`${t('error.prefix')}: ${failure instanceof Error ? failure.message : String(failure)}`)
          },
        )
      }
      load()
      const timer = setInterval(load, TRACKED_POLL_MS)
      return () => { alive = false; clearInterval(timer) }
    }, [api, native, sessionId])

    // Remember what the tab strip showed, so a later mount paints the same rows
    // instead of an empty strip if both rosters are quiet at that moment.
    useEffect(() => {
      if (rows.length > 0) panel.rows = rows
    }, [rows, panel])

    // One tab per conversation, not per call: every run that continues a Claude
    // session lands in the tab of that session and accumulates there.
    const groups = useMemo(() => groupsOf(rows), [rows])


    // Seeded from the cached choice (tab switch) or the default pick, so the
    // first paint already shows a job instead of the "pick one" placeholder.
    const [selected, setSelected] = useState<string | undefined>(() => panel.selected ?? defaultSelection(groups))
    const [meta, setMeta] = useState<Record<string, JobInfo>>({})
    // The host's workstream register: which conversation belongs to which named
    // line, what it is about, how much it has run. Read-only here — the plugin
    // writes it when a run settles — and the answer to "what is this tab?".
    const [register, setRegister] = useState<readonly WorkstreamView[]>(NO_LINES)
    const [registerOpen, setRegisterOpen] = useState(false)
    // Register lookup by conversation id: a group key IS the Claude session id
    // whenever the run knew it, so a named line labels its own tab.
    const lineOf = useMemo(() => {
      const map = new Map<string, WorkstreamView>()
      for (const row of register) map.set(row.sessionId, row)
      return map
    }, [register])
    const [error, setError] = useState<string | null>(null)
    const [now, setNow] = useState(() => Date.now())
    const [copied, setCopied] = useState<string | null>(null)
    // Job whose detail modal is open, or undefined when none is.
    const [detailFor, setDetailFor] = useState<string | undefined>(undefined)
    // Module-level output cache mutates in place; this counter republishes it.
    const [revision, setRevision] = useState(0)
    const bumpRef = useRef(() => { setRevision((value) => value + 1) })
    // The pane is the conversation's scroller once a group holds several runs.
    const paneRef = useRef<HTMLDivElement | null>(null)
    // False once the reader scrolls up: new output must not yank the view back.
    const panePinnedRef = useRef(true)

    // Keep the selection valid as jobs appear, settle and age out.
    useEffect(() => {
      const stillThere = selected !== undefined && groups.some((group) => group.key === selected)
      const next = stillThere ? selected : defaultSelection(groups)
      if (next !== selected) setSelected(next)
      panel.selected = next
    }, [groups, selected, panel])

    const current = groups.find((group) => group.key === selected)
    // The conversation's runs, oldest first; the head is the one the tab reports on.
    const currentJobs: readonly JobView[] = current?.jobs ?? NO_JOBS
    const currentLine = current === undefined ? undefined : lineOf.get(current.key)
    const currentJob = current === undefined ? undefined : headOf(current)
    const currentId = currentJob?.id
    const currentStatus = currentJob?.status
    // Rows we did not run ourselves (the harness's own `subagent` jobs) have no
    // tracker entry: their output is read through the harness `observe` stream,
    // and our own RPCs would only fail on them.
    const ours = currentJob === undefined || currentJob.kind === JOB_KIND
    const observed = (jobs?.state ?? NO_ROSTER)((state) => (ours || currentId === undefined ? undefined : state.observed?.[currentId]))

    useEffect(() => {
      if (jobs?.observe === undefined || ours || currentId === undefined) return undefined
      return jobs.observe(sessionId, currentId)
    }, [jobs, ours, sessionId, currentId])

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
      // Fetched on the same tick: the register decides what a tab is CALLED, so
      // it must not lag a settled run by a poll interval. Its own failure is
      // swallowed — a register is a convenience, never worth a panel error.
      api.listWorkstreams(abort.signal).then(
        (lines) => { setRegister(lines) },
        () => { /* keep the previous register */ },
      )
      return () => { abort.abort() }
    }, [sessionId, lifecycle])

    // Live output: one immediate read, then a 1s poll only while it runs. The
    // status is a dependency, so settling triggers exactly one final read.
    // Two independent absolute cursors advance per tick: the structured event
    // stream the panel renders, and the raw text stream kept as a fallback and
    // as the source for "copy output".
    useEffect(() => {
      if (current === undefined || !ours) return
      const runIds = currentJobs.map((job) => job.id)
      const abort = new AbortController()
      let timer: ReturnType<typeof setInterval> | undefined

      const onFailure = (failure: unknown) => {
        if (abort.signal.aborted) return
        setError(`${t('error.prefix')}: ${failure instanceof Error ? failure.message : String(failure)}`)
      }

      const pullText = (jobId: string) => {
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

      const pullEvents = (jobId: string) => {
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

      // Every run of the conversation is pulled, not just the head one: that is
      // what makes an accumulating tab show its earlier runs as well as the live one.
      const pull = () => {
        for (const jobId of runIds) {
          pullEvents(jobId)
          pullText(jobId)
        }
      }

      pull()
      if (currentJobs.some(isLive)) {
        timer = setInterval(pull, POLL_MS)
      }
      return () => {
        abort.abort()
        if (timer !== undefined) clearInterval(timer)
      }
    }, [sessionId, current, currentJobs, currentStatus, panel, ours])

    // Is the reader at the bottom of the conversation scroller? Re-armed whenever
    // the tab changes, so a freshly opened conversation starts pinned.
    useEffect(() => {
      const pane = paneRef.current
      panePinnedRef.current = true
      if (pane === null) return undefined
      const onScroll = () => {
        panePinnedRef.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48
      }
      pane.addEventListener('scroll', onScroll, { passive: true })
      return () => { pane.removeEventListener('scroll', onScroll) }
    }, [selected])

    // Keep a live conversation pinned to its newest content, the way the main
    // chat does — but never fight a reader who scrolled up.
    useEffect(() => {
      const pane = paneRef.current
      if (pane === null || !panePinnedRef.current) return
      pane.scrollTop = pane.scrollHeight
    }, [revision, currentJobs, currentStatus, selected])

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

    // The head run is what the pane header reports on; every run of the group
    // still gets its own body below, so an accumulated tab shows its history.
    const detail = currentId === undefined ? undefined : meta[currentId]
    // "Copy output" copies the whole conversation in run order, not just the head.
    const copyText = ours
      ? currentJobs
          .map((job) => panel.outputs.get(job.id)?.text ?? meta[job.id]?.finalOutput ?? '')
          .filter((text) => text !== '')
          .join('\n\n')
      : (observed?.text ?? '')
    // A grouped tab's key IS the Claude session; a single-run tab reads it off
    // the tracker metadata (the host only learns it once the run settles).
    const copySessionId = current !== undefined && current.key !== currentJob?.id
      ? current.key
      : meta[currentId ?? '']?.claudeSessionId

    // One run's body: its structured stream when it has events, else raw text.
    const renderRun = (job: JobView) => {
      const runEvents = panel.events.get(job.id)
      const runOutput = panel.outputs.get(job.id)
      const runDetail = meta[job.id]
      if (runEvents !== undefined && runEvents.list.length > 0) {
        return (
          <EventView
            jobId={job.id}
            events={runEvents.list}
            truncated={runEvents.truncated}
            live={isLive(job)}
            readFile={readFile}
          />
        )
      }
      return (
        <OutputView
          jobId={job.id}
          text={runOutput?.text ?? (runDetail?.finalOutput ?? '')}
          truncated={runOutput?.truncated ?? false}
        />
      )
    }
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
          {/* One tab per Claude conversation, single line each; the strip scrolls
              horizontally rather than wrapping into a second row. A conversation
              that ran several times keeps one tab and shows a run count. */}
          {/* The workstream register. This is what makes "which conversation is
              this, and what has it been doing?" answerable instead of remembered. */}
          <div className={CSS.registerBar}>
            <button
              type="button"
              className={CSS.registerToggle}
              aria-expanded={registerOpen}
              onClick={() => { setRegisterOpen((open) => !open) }}
            >
              {`${registerOpen ? '▾' : '▸'} ${t('register.title')} · ${register.length}`}
            </button>
          </div>
          {registerOpen
            ? (register.length === 0
                ? <div className={CSS.registerEmpty}>{t('register.empty')}</div>
                : (
                  <div className={CSS.registerList}>
                    {register.map((row) => <div key={row.key} className={CSS.registerRow}>{row.summary}</div>)}
                  </div>
                ))
            : null}

          <div className={CSS.tabs} role="tablist" aria-label={t('list.title')}>
            {groups.map((group) => {
              const head = headOf(group)
              if (head === undefined) return null
              const active = group.key === selected
              const count = group.jobs.length
              const runs = tf('group.runs', String(count))
              // A named line labels its own tab; an unnamed run keeps its label.
              const line = lineOf.get(group.key)
              const label = line?.name === undefined ? head.label : line.name
              return (
                <div key={group.key} role="presentation" className={active ? `${CSS.tab} ${CSS.tabActive}` : CSS.tab}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={CSS.tabMain}
                    title={line === undefined
                      ? (count > 1 ? `${label} · ${runs}` : label)
                      : `${label} · ${line.summary.replace(/^· /, '')}`}
                    onClick={() => { setSelected(group.key); panel.selected = group.key }}
                  >
                    <span className={dotClass(head.status)} />
                    <span className={CSS.tabLabel}>{clip(label)}</span>
                    {count > 1 ? <span className={CSS.tabCount}>{count}</span> : null}
                  </button>
                  {/* Opening the detail must not also switch tabs. */}
                  <button
                    type="button"
                    className={CSS.tabInfo}
                    title={t('detail.open')}
                    aria-label={t('detail.open')}
                    onClick={(event) => { event.stopPropagation(); setDetailFor(head.id) }}
                  >
                    ⓘ
                  </button>
                </div>
              )
            })}
          </div>

          <div ref={paneRef} className={currentJobs.length > 1 ? `${CSS.pane} ${CSS.paneMulti}` : CSS.pane}>
            {current === undefined ? (
              <div className={CSS.empty}>
                {t('select.empty')}
                {/* Row sources, so "nothing listed" is diagnosable at a glance. */}
                <div className={CSS.emptyTitle}>
                  {`${t('select.sources')}: roster ${native?.length ?? 0} · tracker ${tracked.length}`}
                </div>
              </div>
            ) : (
              <>
                <div className={CSS.paneHead}>
                  <div className={CSS.stats}>
                    {currentLine?.name === undefined
                      ? null
                      : <span className={CSS.stat}>{t('register.line')}: {currentLine.name}</span>}
                    <span className={CSS.stat}>{t('detail.job')}: <span className={CSS.mono}>{currentId ?? '—'}</span></span>
                    <span className={CSS.stat}>{statusLabel(currentJob?.status ?? 'completed')}</span>
                    {currentJobs.length > 1 ? <span className={CSS.stat}>{tf('group.runs', String(currentJobs.length))}</span> : null}
                    {detail?.numTurns !== undefined ? <span className={CSS.stat}>{detail.numTurns} {t('stats.turns')}</span> : null}
                    {detail?.costUsd !== undefined ? <span className={CSS.stat}>{t('stats.cost')} ${detail.costUsd.toFixed(4)}</span> : null}
                    <span className={CSS.stat}>
                      {t('stats.duration')} {currentJob === undefined ? '—' : formatDuration(isLive(currentJob) ? now - currentJob.startedAt : (currentJob.finishedAt ?? currentJob.startedAt) - currentJob.startedAt)}
                    </span>
                    {currentJob?.detail !== undefined ? <span className={CSS.stat}>{currentJob.detail}</span> : null}
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
                    <OutputView jobId={currentId ?? ''} text={observed?.text ?? ''} truncated={false} />
                  </>
                ) : (
                  currentJobs.map((job, index) => (
                    <Fragment key={job.id}>
                      {currentJobs.length > 1 ? (
                        <div className={CSS.groupHead}>
                          {`${tf('group.run', String(index + 1))} · ${statusLabel(job.status)}`}
                        </div>
                      ) : null}
                      {/* What was sent to it in this run, drawn like a user turn of
                          the main chat — otherwise a continued tab shows replies
                          with no record of the prompt that produced them. */}
                      <div className={CSS.userRow} aria-label={t('prompt.head')}>
                        <div className={CSS.userStack}>
                          <div className={CSS.bubble}>{meta[job.id]?.task ?? job.label}</div>
                        </div>
                      </div>
                      {renderRun(job)}
                    </Fragment>
                  ))
                )}

                <div className={CSS.actions}>
                  {currentJob !== undefined && isLive(currentJob) ? (
                    <button type="button" className={`${CSS.button} ${CSS.danger}`} onClick={() => { onCancel(currentJob.id) }}>
                      {t('action.cancel')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={CSS.button}
                    disabled={copyText === ''}
                    onClick={() => {
                      void copy(copyText).then((done) => { if (done) flashCopied('output') })
                    }}
                  >
                    {copied === 'output' ? t('action.copied') : t('action.copyOutput')}
                  </button>
                  <button
                    type="button"
                    className={CSS.button}
                    disabled={copySessionId === undefined}
                    title={t('detail.session.hint')}
                    onClick={() => {
                      void copy(copySessionId ?? '').then((done) => { if (done) flashCopied('session') })
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
