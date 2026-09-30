import type { ClaudeEvent } from './types.js';
export interface EventViewProps {
    events: readonly ClaudeEvent[];
    /** True when the host already dropped the head of the event buffer. */
    truncated: boolean;
    /** Identity of the job being shown; changing it re-pins the view to the tail. */
    jobId: string;
    /** True while the job itself still runs; ticks a tool card whose result is pending. */
    live?: boolean;
}
export declare function EventView({ events, truncated, jobId, live }: EventViewProps): import("react").JSX.Element;
