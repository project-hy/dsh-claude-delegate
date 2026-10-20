/**
 * Thin client over the plugin's own `claudeCode/*` remote methods.
 *
 * The harness exposes no Client→Host channel for background jobs, so this goes
 * straight at the connection service's generic unary caller. The api-gateway
 * dispatches `/api/<namespace>/<method>` and requires the payload to be exactly
 * `{ args: { … } }`; it answers with `{ ok:true, value }` or `{ ok:false, error }`,
 * which is re-validated here rather than trusted.
 */
import type { ConnectionService, JobInfo, ReadEventsResult, ReadOutputFileResult, ReadOutputResult, WorkstreamView } from './types.js';
/** One wire failure, carrying the gateway's error code when it supplied one. */
export declare class ClaudeCodeApiError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** The panel's API surface, bound to one connection service. */
export interface ClaudeCodeApi {
    listJobs(sessionId: string, signal?: AbortSignal): Promise<JobInfo[]>;
    /** The workstream register: declared name → conversation id, with descriptions. */
    listWorkstreams(signal?: AbortSignal): Promise<WorkstreamView[]>;
    readOutput(sessionId: string, jobId: string, fromOffset: number, signal?: AbortSignal): Promise<ReadOutputResult>;
    readEvents(sessionId: string, jobId: string, fromOffset: number, signal?: AbortSignal): Promise<ReadEventsResult>;
    /**
     * One window of an output file the CLI persisted for this session's run.
     * A negative `fromOffset` counts back from the end.
     */
    readOutputFile(sessionId: string, filePath: string, fromOffset: number, limit: number, signal?: AbortSignal): Promise<ReadOutputFileResult>;
    cancel(sessionId: string, jobId: string): Promise<'requested' | 'already-finished'>;
}
/** Bind the API surface to the client runtime's connection service. */
export declare function createApi(connection: ConnectionService): ClaudeCodeApi;
