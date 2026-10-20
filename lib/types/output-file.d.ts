/** Largest window one read may return, in characters. */
export declare const MAX_OUTPUT_WINDOW = 200000;
/** One window of a persisted output file. */
export interface OutputWindow {
    /** The bytes at `start`, decoded as UTF-8. */
    text: string;
    /** Absolute byte offset this window starts at. */
    start: number;
    /** Offset to request when scrolling further back; `start` once at the head. */
    prevOffset: number;
    /** Size of the whole file in bytes. */
    totalBytes: number;
    /** True when anything exists before this window. */
    hasMoreBefore: boolean;
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
export declare function readOutputWindow(filePath: string, offset: number, limit: number): Promise<OutputWindow>;
