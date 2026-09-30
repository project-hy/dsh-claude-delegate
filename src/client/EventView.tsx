/**
 * Native-style rendering of one delegation's structured event stream.
 *
 * The host emits text both as partial deltas (the panel paints while the block
 * is still being written) and, for whatever the deltas missed, as the finished
 * block; thinking / tool_use / tool_result / result follow per block. This
 * component turns that flat, append-only list into the shape a Claude Code
 * terminal shows: plain text, collapsed thinking, and a tool card that owns the
 * result it produced. Grouping is by `tool_use_id`, so parallel tool calls still
 * land under their own card, and adjacent text events merge into one node.
 *
 * Everything long is collapsed by default — parameters to one line, results to
 * a few hundred characters — because a delegation easily emits megabytes and
 * the reader is scanning for what the agent is doing, not reading file dumps.
 * Auto-scroll follows the tail and pauses the moment the reader scrolls up,
 * exactly like the text pane it sits next to.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CSS, toolToneClass } from './styles.js'
import { Markdown } from './md.js'
import { t } from './locales.js'
import type { ClaudeEvent } from './types.js'

/** DOM cap: only the newest events stay in the tree. */
const MAX_RENDER_EVENTS = 1000
/** Collapsed length of a tool_use parameter line. */
const PARAM_PREVIEW = 200
/** Collapsed length of a tool_result body. */
const RESULT_PREVIEW = 800
/** Console lines kept per block in the DOM (the stream itself keeps them all). */
const MAX_CONSOLE_LINES = 400
/** Our own shell tool: its result is the same text the console group streamed. */
const SHELL_TOOL = 'mcp__dsh__shell'
/** How close to the bottom still counts as "following the tail". */
const STICKY_SLACK_PX = 24

interface ResultNode {
  content: string
  isError: boolean
}

interface ConsoleLine {
  text: string
  err: boolean
}

type Node =
  | { kind: 'text', key: string, text: string }
  | { kind: 'thinking', key: string, thinking: string }
  | { kind: 'tool', key: string, name: string, preview: string, full: string, results: ResultNode[], progress?: number }
  | { kind: 'console', key: string, lines: ConsoleLine[], footer?: string }
  | { kind: 'meta', key: string, text: string }
  | { kind: 'orphanResult', key: string, result: ResultNode }
  | { kind: 'result', key: string, summary: string, isError: boolean }
  | { kind: 'warning', key: string, text: string }

export interface EventViewProps {
  events: readonly ClaudeEvent[]
  /** True when the host already dropped the head of the event buffer. */
  truncated: boolean
  /** Identity of the job being shown; changing it re-pins the view to the tail. */
  jobId: string
  /** True while the job itself still runs; ticks a tool card whose result is pending. */
  live?: boolean
}

/** One-line preview plus the pretty-printed full form of a tool's parameters. */
function formatInput(input: unknown): { preview: string, full: string } {
  if (input === undefined || input === null) return { preview: '', full: '' }
  if (typeof input === 'string') return { preview: input, full: input }
  let compact: string
  let full: string
  try {
    compact = JSON.stringify(input) ?? String(input)
    full = JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    compact = String(input)
    full = compact
  }
  return { preview: compact, full }
}

/**
 * Our shell tool's parameters, read as a sentence instead of JSON: the card then
 * reads `面板实时输出验证 — echo "tick-1" …` rather than a quoted blob, and the
 * command is not repeated a second time in the terminal block below it.
 */
function shellParams(input: unknown): { preview: string, full: string } {
  const formatted = formatInput(input)
  if (input === null || typeof input !== 'object') return formatted
  const record = input as Record<string, unknown>
  const command = typeof record['command'] === 'string' ? record['command'] : ''
  if (command === '') return formatted
  const purpose = typeof record['purpose'] === 'string' ? record['purpose'] : ''
  return { preview: purpose === '' ? command : `${purpose} — ${command}`, full: formatted.full }
}

/** `3m20s` / `12s`, matching the detail line the jobs seam prints. */
function formatDuration(durationMs: number): string {
  const total = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`
}

/** `✅ 完成 · $0.13 · 12 turns · 3m20s`, skipping whatever the run did not report. */
function resultSummary(event: Extract<ClaudeEvent, { type: 'result' }>): string {
  const parts = [event.isError === true ? `❌ ${t('status.failed')}` : `✅ ${t('events.result')}`]
  if (typeof event.costUsd === 'number') parts.push(`$${event.costUsd.toFixed(2)}`)
  if (typeof event.numTurns === 'number') parts.push(`${event.numTurns} turns`)
  if (typeof event.durationMs === 'number') parts.push(formatDuration(event.durationMs))
  return parts.join(' · ')
}

/** Fold the flat event list into render nodes, attaching results to their call. */
function toNodes(events: readonly ClaudeEvent[]): Node[] {
  const nodes: Node[] = []
  /** tool_use_id → index of its card in `nodes`. */
  const byToolUse = new Map<string, number>()
  /** Index of the console block still collecting lines, if any. */
  let openConsole: number | undefined
  /** run id → index of that command's console block (parallel commands). */
  const byRun = new Map<string, number>()

  events.forEach((event, index) => {
    const key = `e${index}`
    switch (event.type) {
      case 'text': {
        if (event.text.trim() === '') break
        // Text arrives both as partial deltas and (for what they missed) as the
        // finished block, so one node per run keeps Markdown parsing and the raw
        // toggle per paragraph instead of per token.
        const last = nodes[nodes.length - 1]
        if (last !== undefined && last.kind === 'text') last.text += event.text
        else nodes.push({ kind: 'text', key, text: event.text })
        break
      }
      case 'thinking': {
        nodes.push({ kind: 'thinking', key, thinking: event.thinking })
        break
      }
      case 'tool_use': {
        const { preview, full } = event.name === SHELL_TOOL ? shellParams(event.input) : formatInput(event.input)
        nodes.push({ kind: 'tool', key, name: event.name, preview, full, results: [] })
        if (event.id !== undefined) byToolUse.set(event.id, nodes.length - 1)
        break
      }
      case 'tool_progress': {
        // The CLI reports the running clock of a long tool; the card ticks with
        // it, so a Bash call that takes minutes is visibly alive, not frozen.
        const at = byToolUse.get(event.tool_use_id)
        const owner = at === undefined ? undefined : nodes[at]
        if (owner !== undefined && owner.kind === 'tool') owner.progress = event.elapsedSeconds
        break
      }
      case 'console': {
        // The channel writes one event per line, framed by `meta` start/end
        // events that carry the run id. All of a command's output folds into ONE
        // node, keyed by that id, so a second command running in the same turn
        // cannot have its lines land in the first one's block.
        if (event.text === '') break
        const run = event.run
        const known = run === undefined ? undefined : byRun.get(run)
        const at = known ?? openConsole
        const open = at === undefined ? undefined : nodes[at]
        if (event.stream === 'meta') {
          if (event.phase === 'start' || (event.phase === undefined && event.text.startsWith('$ '))) {
            nodes.push({ kind: 'console', key, lines: [] })
            const index = nodes.length - 1
            if (run !== undefined) byRun.set(run, index)
            openConsole = index
            break
          }
          if (open !== undefined && open.kind === 'console' && open.footer === undefined) {
            open.footer = event.text
            if (run !== undefined) byRun.delete(run)
            if (at === openConsole) openConsole = undefined
            break
          }
          nodes.push({ kind: 'meta', key, text: event.text })
          break
        }
        const err = event.stream === 'stderr'
        if (open !== undefined && open.kind === 'console' && open.footer === undefined) open.lines.push({ text: event.text, err })
        else {
          nodes.push({ kind: 'console', key, lines: [{ text: event.text, err }] })
          const index = nodes.length - 1
          if (run !== undefined) byRun.set(run, index)
          openConsole = index
        }
        break
      }
      case 'tool_result': {
        const at = event.tool_use_id === null ? undefined : byToolUse.get(event.tool_use_id)
        const owner = at === undefined ? undefined : nodes[at]
        // A succeeded channel command already streamed every line into its own
        // terminal block; repeating the same text as a tool result made the
        // panel show the output twice. Failures (timeout / spawn / no bash) keep
        // their result, because those never produced a console block.
        if (owner !== undefined && owner.kind === 'tool' && owner.name === SHELL_TOOL
          && event.content.trimStart().startsWith('exit ')) break
        const result: ResultNode = { content: event.content, isError: event.isError === true }
        if (owner !== undefined && owner.kind === 'tool') owner.results.push(result)
        else nodes.push({ kind: 'orphanResult', key, result })
        break
      }
      case 'result': {
        nodes.push({ kind: 'result', key, summary: resultSummary(event), isError: event.isError === true })
        break
      }
      case 'warning': {
        nodes.push({ kind: 'warning', key, text: event.text })
        break
      }
    }
  })

  return nodes
}

export function EventView({ events, truncated, jobId, live = false }: EventViewProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [following, setFollowing] = useState(true)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  const clipped = events.length > MAX_RENDER_EVENTS
  const visible = useMemo(
    () => (clipped ? events.slice(events.length - MAX_RENDER_EVENTS) : events),
    [events, clipped],
  )
  const nodes = useMemo(() => toNodes(visible), [visible])

  // A different job is a different stream: forget expansions, re-pin to the tail.
  useEffect(() => {
    setFollowing(true)
    setExpanded(new Set())
  }, [jobId])

  // Scroll before paint so appended events never show a one-frame jump.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || !following) return
    body.scrollTop = body.scrollHeight
  }, [nodes, following])

  const onScroll = () => {
    const body = bodyRef.current
    if (!body) return
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight <= STICKY_SLACK_PX
    setFollowing(atBottom)
  }

  const backToBottom = () => {
    const body = bodyRef.current
    if (body) body.scrollTop = body.scrollHeight
    setFollowing(true)
  }

  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** A result body: collapsed to a preview with an inline expander. */
  const renderResult = (key: string, result: ResultNode) => {
    const open = expanded.has(key)
    const long = result.content.length > RESULT_PREVIEW
    const body = open || !long ? result.content : `${result.content.slice(0, RESULT_PREVIEW)}…`
    return (
      <div key={key} className={CSS.evToolResult}>
        <div className={result.isError ? `${CSS.evToolResultHead} ${CSS.evToolError}` : CSS.evToolResultHead}>
          {result.isError ? t('events.toolError') : t('events.toolResult')}
        </div>
        <pre className={result.isError ? `${CSS.evToolResultBody} ${CSS.evToolError}` : CSS.evToolResultBody}>{body}</pre>
        {long ? (
          <button type="button" className={CSS.evMore} onClick={() => { toggle(key) }}>
            {open ? t('output.collapse') : t('output.expand')}
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className={CSS.events}>
      <div ref={bodyRef} className={CSS.eventsBody} onScroll={onScroll} role="log" aria-label={t('events.title')}>
        {(truncated || clipped) ? <div className={CSS.outputNotice}>{t('events.truncated')}</div> : null}
        {nodes.length === 0 ? <div className={CSS.outputNotice}>{t('events.empty')}</div> : null}

        {nodes.map((node) => {
          if (node.kind === 'text') {
            // Rendered Markdown by default; the toggle falls back to the source
            // for anything the small parser gets wrong (or for copying).
            const rawKey = `${node.key}:raw`
            const raw = expanded.has(rawKey)
            return (
              <div key={node.key} className={CSS.evText}>
                {raw ? <pre className={CSS.evTextRaw}>{node.text}</pre> : <Markdown text={node.text} />}
                <button type="button" className={CSS.evMore} onClick={() => { toggle(rawKey) }}>
                  {raw ? t('output.preview') : t('output.raw')}
                </button>
              </div>
            )
          }

          if (node.kind === 'thinking') {
            const open = expanded.has(node.key)
            return (
              <div key={node.key} className={CSS.evThinking}>
                <button
                  type="button"
                  className={CSS.evThinkingHead}
                  aria-expanded={open}
                  onClick={() => { toggle(node.key) }}
                >
                  {open ? `💭 ${t('events.thinkingLabel')}（${t('output.collapse')}）` : t('events.thinking')}
                </button>
                {open ? <pre className={CSS.evThinkingBody}>{node.thinking}</pre> : null}
              </div>
            )
          }

          if (node.kind === 'orphanResult') {
            return renderResult(`${node.key}:r0`, node.result)
          }

          if (node.kind === 'console') {
            // One command = one terminal block: every line the channel streamed,
            // in order, stderr tinted; `exit …` closes it as a dim footer.
            const shown = node.lines.length > MAX_CONSOLE_LINES ? node.lines.slice(-MAX_CONSOLE_LINES) : node.lines
            const cut = shown.length < node.lines.length
            const failed = node.footer !== undefined && !/^exit 0\b/.test(node.footer)
            return (
              <div key={node.key} className={CSS.evConsole}>
                <div className={CSS.evConsoleHead}>
                  {t('events.shellOut')}
                  {cut ? ` · ${t('events.truncated')}` : ''}
                </div>
                <pre className={CSS.evConsoleBody}>
                  {shown.map((line, at) => (
                    <span key={at} className={line.err ? CSS.evConsoleErr : undefined}>
                      {line.text}
                      {'\n'}
                    </span>
                  ))}
                </pre>
                {node.footer === undefined ? null : (
                  <div className={failed ? `${CSS.evConsoleMeta} ${CSS.evConsoleErr}` : CSS.evConsoleMeta}>{node.footer}</div>
                )}
              </div>
            )
          }

          if (node.kind === 'meta') {
            return <div key={node.key} className={CSS.evConsoleMeta}>{node.text}</div>
          }

          if (node.kind === 'result') {
            return (
              <div key={node.key} className={node.isError ? `${CSS.evResult} ${CSS.evToolError}` : CSS.evResult}>
                {node.summary}
              </div>
            )
          }

          if (node.kind === 'warning') {
            return (
              <div key={node.key} role="status" className={CSS.evWarning}>
                {node.text}
              </div>
            )
          }

          const paramsKey = `${node.key}:p`
          const open = expanded.has(paramsKey)
          const long = node.preview.length > PARAM_PREVIEW
          return (
            <div key={node.key} className={CSS.evTool}>
              <button
                type="button"
                className={CSS.evToolHead}
                aria-expanded={open}
                onClick={() => { toggle(paramsKey) }}
              >
                <span className={`${CSS.evToolBadge} ${toolToneClass(node.name)}`}>[{node.name}]</span>
                {open ? null : (
                  <span className={CSS.evToolParams}>
                    {long ? `${node.preview.slice(0, PARAM_PREVIEW)}…` : node.preview}
                  </span>
                )}
                {node.results.length === 0 && (node.progress !== undefined || live) ? (
                  <span className={CSS.evToolParams}>
                    ⏳ {t('events.toolRunning')}{node.progress !== undefined ? ` ${formatDuration(node.progress * 1000)}` : ''}…
                  </span>
                ) : null}
              </button>
              {open && node.full !== '' ? <pre className={CSS.evToolParamsFull}>{node.full}</pre> : null}
              {node.results.map((result, index) => renderResult(`${node.key}:r${index}`, result))}
            </div>
          )
        })}
      </div>
      {following ? null : (
        <button type="button" className={CSS.follow} onClick={backToBottom}>
          {t('output.follow')}
        </button>
      )}
    </div>
  )
}
