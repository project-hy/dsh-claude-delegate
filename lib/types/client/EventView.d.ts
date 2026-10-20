import type { ClaudeEvent, ReadOutputFileResult } from './types.js';
export interface EventViewProps {
    events: readonly ClaudeEvent[];
    /** True when the host already dropped the head of the event buffer. */
    truncated: boolean;
    /** Identity of the job being shown; changing it re-pins the view to the tail. */
    jobId: string;
    /** True while the job itself still runs; ticks a tool card whose result is pending. */
    live?: boolean;
    /** One window of a CLI-persisted output file, for the 「完整输出」 view. */
    readFile?: (filePath: string, fromOffset: number, limit: number) => Promise<ReadOutputFileResult>;
}
export declare function EventView({ events, truncated, jobId, live, readFile }: EventViewProps): import("react").JSX.Element;
