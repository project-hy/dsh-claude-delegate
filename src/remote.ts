/**
 * Host→Client RPC surface of the monitor panel.
 *
 * The harness ships no Client→Host channel for background jobs (the official
 * job list is read-only), so the panel talks to this service instead. It is a
 * plain `TypertRemoteService`: the api-gateway discovers `@Remote` methods by
 * reflecting over live services (its SRC mode), which needs no typert codegen.
 * Wire endpoints are `claudeCode/<method>` on the gateway's `/api` channel, and
 * the gateway's `trusted-host` authority already fences them.
 *
 * SRC dispatch derives wire field names from the METHOD PARAMETER NAMES, so
 * every parameter below must stay a plain identifier (no destructuring, no
 * defaults, no rest) and must not collide with a typert lookup parameter
 * (`session`, `agent`) — `sessionId` / `jobId` / `fromOffset` are plain JSON.
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { toJobInfo, type ClaudeEvent, type JobInfo, type JobTracker, type TrackedStatus } from './tracker.js'
import { readOutputWindow } from './output-file.js'
import { SessionStore, type WorkstreamInfo } from './session-store.js'

/**
 * `claudeCode/listJobs` row. Identical to the tracker's {@link JobInfo} except
 * for `model`, which is always present: the api-gateway refuses to encode an
 * `undefined` value, so a run with no recorded model spells it `null`.
 */
export interface JobInfoWire extends Omit<JobInfo, 'model'> {
  model: string | null
}

/** One incremental output read as the panel sees it. */
export interface ReadOutputResult {
  text: string
  nextOffset: number
  truncated: boolean
  status: TrackedStatus
}

/** One incremental read of the structured event stream. */
export interface ReadEventsResult {
  events: ClaudeEvent[]
  nextOffset: number
  truncated: boolean
  status: TrackedStatus
}

/** Cancellation outcome (mirrors the jobs seam's own vocabulary). */
export type CancelOutcome = 'requested' | 'already-finished'

/** One window of an output file the CLI persisted, as the panel reads it back. */
export interface ReadOutputFileResult {
  text: string
  /** Absolute byte offset this window starts at. */
  offset: number
  /** Offset to request when scrolling further back; 0 once at the head. */
  prevOffset: number
  /** Size of the whole file in bytes, so the panel can say how much there is. */
  totalBytes: number
  /** True when anything exists before this window. */
  hasMoreBefore: boolean
}

/**
 * One row of the workstream register as the panel sees it: the stored fields
 * plus the same one-line summary the tool result prints (`· name — what it is
 * about (N runs, last <age>)`), so both surfaces read alike.
 */
export interface WorkstreamWire extends WorkstreamInfo {
  /** Pre-formatted label; relative ages are computed host-side, once. */
  summary: string
}

/** `ctx.claudeCode` — the monitor panel's own remote service. */
export class ClaudeCodeRemote extends TypertRemoteService {
  private tracker!: JobTracker

  private sessions!: SessionStore

  constructor(ctx: Context, tracker: JobTracker, sessions: SessionStore) {
    super(ctx, 'claudeCode')
    this.tracker = tracker
    this.sessions = sessions
  }

  /**
   * The workstream register: which conversation id belongs to which declared
   * workstream, what it is about, and when it last ran. Read-only — the plugin
   * itself writes it when a delegation settles — and deliberately not scoped to
   * one directory, because seeing another directory's line is how a caller spots
   * that it is about to start a duplicate.
   */
  @Remote
  async listWorkstreams(): Promise<WorkstreamWire[]> {
    return this.sessions.lines().map((row) => ({ ...row, summary: SessionStore.describe(row) }))
  }

  /**
   * Every claude-code delegation owned by one session, with the metadata the
   * jobs mirror does not carry (cost, turns, claude session id, final text).
   */
  @Remote
  async listJobs(sessionId: string): Promise<JobInfoWire[]> {
    return this.tracker.list(sessionId).map((job) => ({ ...toJobInfo(job), model: job.model ?? null }))
  }

  /**
   * Incremental output from an absolute offset. There is no server-side cursor,
   * so any number of panels (or windows) can read the same job independently.
   */
  @Remote
  async readOutput(sessionId: string, jobId: string, fromOffset: number): Promise<ReadOutputResult> {
    const job = this.tracker.require(sessionId, jobId)
    const offset = Number.isSafeInteger(fromOffset) && fromOffset > 0 ? fromOffset : 0
    const chunk = job.read(offset)
    return {
      text: chunk.text,
      nextOffset: chunk.nextOffset,
      truncated: chunk.truncated,
      status: job.status,
    }
  }

  /**
   * Incremental structured events from an absolute offset — the same run the
   * text stream describes, but block-shaped so the panel can render tool cards,
   * thinking and results natively. Cursor-free like `readOutput`, so reading
   * here never costs the model's `job_output` bytes.
   */
  @Remote
  async readEvents(sessionId: string, jobId: string, fromOffset: number): Promise<ReadEventsResult> {
    const job = this.tracker.require(sessionId, jobId)
    const offset = Number.isSafeInteger(fromOffset) && fromOffset > 0 ? fromOffset : 0
    const chunk = job.readEvents(offset)
    return {
      events: chunk.events,
      nextOffset: chunk.nextOffset,
      truncated: chunk.truncated,
      status: job.status,
    }
  }

  /**
   * One window of an output file the CLI persisted for this session's run.
   *
   * The path is not free-form: it must have arrived in this session's own event
   * stream (`tracker.allowOutputPath`), so the panel cannot ask the host to read
   * an arbitrary file. `fromOffset` is absolute, and a negative one counts back
   * from the end — the panel loads the tail first and pages backwards.
   */
  @Remote
  async readOutputFile(sessionId: string, filePath: string, fromOffset: number, limit: number): Promise<ReadOutputFileResult> {
    const allowed = this.tracker.requireOutputPath(sessionId, filePath)
    const window = await readOutputWindow(allowed, fromOffset, limit)
    return {
      text: window.text,
      offset: window.start,
      prevOffset: window.prevOffset,
      totalBytes: window.totalBytes,
      hasMoreBefore: window.hasMoreBefore,
    }
  }

  /**
   * Cancel from the UI. This goes through the plugin's own AbortController, so
   * the job still settles as `killed` and the model still gets its completion
   * notification (which `ctx.jobs.kill()` would have swallowed).
   */
  @Remote
  async cancel(sessionId: string, jobId: string): Promise<CancelOutcome> {
    const job = this.tracker.require(sessionId, jobId)
    return job.cancelFromUi() ? 'requested' : 'already-finished'
  }
}
