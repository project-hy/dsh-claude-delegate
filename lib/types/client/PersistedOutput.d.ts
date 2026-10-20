import type { ReadOutputFileResult } from './types.js';
export interface PersistedOutputProps {
    /** Absolute path the CLI named in the result (already allow-listed host-side). */
    filePath: string;
    /** One window fetch; a negative offset counts back from the end of the file. */
    read: (filePath: string, fromOffset: number, limit: number) => Promise<ReadOutputFileResult>;
}
export declare function PersistedOutput({ filePath, read }: PersistedOutputProps): import("react").JSX.Element;
