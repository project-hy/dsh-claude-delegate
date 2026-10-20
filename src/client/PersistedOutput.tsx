/**
 * Read-back view of an output file Claude Code persisted itself.
 *
 * A command whose output exceeds the CLI's inline budget is written to a file and
 * named in the result the model sees; the panel shows the capped tail inline and
 * this component is where the whole thing can be read. It loads the END first — a
 * log states its verdict on the last line — and pages backwards in fixed windows,
 * so opening a 200 MB log costs one `read()` per window, never a download.
 *
 * The path is not free-form: the host only serves files that arrived in this
 * session's own event stream, so a path that never came from a run is refused.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { CSS } from './styles.js'
import { t } from './locales.js'
import type { ReadOutputFileResult } from './types.js'

/** Bytes per fetch: large enough that paging a log is rare, small enough to be cheap. */
const WINDOW_BYTES = 200_000

export interface PersistedOutputProps {
  /** Absolute path the CLI named in the result (already allow-listed host-side). */
  filePath: string
  /** One window fetch; a negative offset counts back from the end of the file. */
  read: (filePath: string, fromOffset: number, limit: number) => Promise<ReadOutputFileResult>
}

/** `812 B` / `14.3 KB` / `2.1 MB` — the reader only needs the order of magnitude. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function PersistedOutput({ filePath, read }: PersistedOutputProps) {
  const [text, setText] = useState('')
  const [start, setStart] = useState(0)
  const [totalBytes, setTotalBytes] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // The reader is a fresh closure on every parent render; holding it in a ref keeps
  // that from re-running the initial load (the effect depends on the path alone).
  const reader = useRef(read)
  reader.current = read

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    reader.current(filePath, -WINDOW_BYTES, WINDOW_BYTES)
      .then((window) => {
        if (cancelled) return
        setText(window.text)
        setStart(window.offset)
        setTotalBytes(window.totalBytes)
        setError('')
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(`${t('events.persistedFailed')}: ${describe(cause)}`)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [filePath])

  const loadEarlier = useCallback(() => {
    if (start <= 0 || loading) return
    setLoading(true)
    // Ask for exactly the bytes before the earliest one already held: a window that
    // merely overlapped would print the seam twice.
    const from = Math.max(0, start - WINDOW_BYTES)
    reader.current(filePath, from, start - from)
      .then((window) => {
        setText((current) => window.text + current)
        setStart(window.offset)
        setTotalBytes(window.totalBytes)
        setError('')
      })
      .catch((cause: unknown) => { setError(`${t('events.persistedFailed')}: ${describe(cause)}`) })
      .finally(() => { setLoading(false) })
  }, [filePath, loading, start])

  return (
    <div className={CSS.evPersisted}>
      <div className={CSS.evPersistedHead}>
        {t('events.persistedHead')} · {formatBytes(totalBytes)}
      </div>
      {start > 0 ? (
        <button type="button" className={CSS.evMore} disabled={loading} onClick={loadEarlier}>
          {loading ? t('events.persistedLoading') : `${t('events.persistedEarlier')} (${formatBytes(start)})`}
        </button>
      ) : null}
      {error !== '' ? <div className={CSS.evWarning}>{error}</div> : null}
      <pre className={CSS.evPersistedBody}>{text}</pre>
    </div>
  )
}
