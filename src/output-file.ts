/**
 * Read-back of output files the CLI persisted itself.
 *
 * Claude Code caps how much of a command's output it hands the model inline
 * (`bashOutputMaxChars`, 30000 by default, 4000-128000 clamped) and writes the
 * rest to a file, naming that file in the message the model receives — the same
 * mechanism behind `Output truncated (NKB total). Full output saved to: <path>`.
 * That file is the only complete copy of a long command's output, so the panel
 * reads it back through an explicitly allow-listed path: a path must have arrived
 * in the owning session's own event stream first (`JobTracker.allowOutputPath`),
 * which is what keeps this from becoming an arbitrary-file-read endpoint for the
 * browser side.
 *
 * Reads are plain windows over the bytes — no parsing, no polling — so a 200 MB
 * log costs one `read()` per window and never enters the event buffer.
 */
import { open, stat } from 'node:fs/promises'

/** Largest window one read may return, in characters. */
export const MAX_OUTPUT_WINDOW = 200_000

/** One window of a persisted output file. */
export interface OutputWindow {
  /** The bytes at `start`, decoded as UTF-8. */
  text: string
  /** Absolute byte offset this window starts at. */
  start: number
  /** Offset to request when scrolling further back; `start` once at the head. */
  prevOffset: number
  /** Size of the whole file in bytes. */
  totalBytes: number
  /** True when anything exists before this window. */
  hasMoreBefore: boolean
}

/**
 * Read one window of a persisted output file.
 *
 * `offset` is an ABSOLUTE byte offset; a negative value counts back from the end,
 * which is how the panel asks for the tail first — a log's verdict is on its last
 * line. A window may split a multi-byte character at either edge; the replacement
 * character that produces is harmless here, because the panel only ever appends
 * windows requested from the same fixed offsets.
 */
export async function readOutputWindow(filePath: string, offset: number, limit: number): Promise<OutputWindow> {
  const info = await stat(filePath)
  if (!info.isFile()) throw new Error(`not a file: ${filePath}`)
  const totalBytes = info.size
  const window = Math.max(
    1,
    Math.min(Math.floor(Number.isFinite(limit) ? limit : MAX_OUTPUT_WINDOW), MAX_OUTPUT_WINDOW),
  )
  const requested = Number.isFinite(offset) ? Math.floor(offset) : -window
  const end = requested < 0 ? totalBytes + requested : requested
  const start = Math.max(0, Math.min(end, totalBytes))
  const length = Math.max(0, Math.min(window, totalBytes - start))
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      start,
      prevOffset: Math.max(0, start - window),
      totalBytes,
      hasMoreBefore: start > 0,
    }
  } finally {
    await handle.close()
  }
}
