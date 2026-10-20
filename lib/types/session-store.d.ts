export interface StoredSession {
    sessionId: string;
    cwd: string;
    createdAt: string;
    updatedAt: string;
    runs: number;
    /** Workstream name of this line, when the caller declared one. */
    name?: string;
    /** What this line is about: the first task it ran, kept for the register. */
    description?: string;
    /** The most recent task, so the register stays honest about what it is doing. */
    lastTask?: string;
}
/** One row of the register, as handed to callers and to the panel. */
export interface WorkstreamInfo {
    key: string;
    sessionId: string;
    cwd: string;
    runs: number;
    createdAt: string;
    updatedAt: string;
    name?: string;
    description?: string;
    lastTask?: string;
}
/** `$DSH_HOME` when the host sets it, else the conventional location. */
export declare function defaultSessionFile(): string;
/** One line of a task, short enough to read in a register. */
export declare function excerpt(text: string, limit?: number): string;
/** Human age of a timestamp; relative is what makes a register scannable. */
export declare function ago(iso: string, now?: number): string;
export interface ResumePlan {
    /** Registry key for this task; '' when the call is not remembered at all. */
    key: string;
    /** Declared workstream name, when there was one. */
    name?: string;
    /** Session id handed to the CLI, or undefined to start a new conversation. */
    resume?: string;
    mode: 'explicit' | 'continued' | 'new';
    reason: 'explicit' | 'forced' | 'busy' | 'none' | 'unknown-owner' | 'unnamed';
    /** One line for the tool result saying what happened; '' when unremarkable. */
    note: string;
}
export interface PlanInput {
    /** The calling DSH session: the namespace used when `continueUnnamed` is on. */
    owner?: string;
    cwd: string;
    /** An explicit session id always wins and is never second-guessed. */
    explicit?: string;
    /** Start a new conversation even though one is remembered. */
    fresh?: boolean;
    /** Which workstream this task belongs to. The only reliable discriminator. */
    conversation?: string;
    /**
     * Opt back into the old default: continue this DSH session's own line even when
     * the caller named no workstream. Unsafe wherever one directory holds more than
     * one workstream, which is why it is off.
     */
    continueUnnamed?: boolean;
}
export declare class SessionStore {
    private readonly file;
    private readonly entries;
    /** Keys with a run in flight; two processes must never own one conversation. */
    private readonly active;
    private loaded;
    constructor(file?: string);
    private load;
    private save;
    /** One register row per line, newest first; optionally only one directory's. */
    lines(cwd?: string): WorkstreamInfo[];
    /** Which line owns this session id, when the register knows it. */
    findById(sessionId: string): WorkstreamInfo | undefined;
    /** How one register row reads in a tool result or a panel. */
    static describe(row: WorkstreamInfo, now?: number): string;
    private registerNote;
    /** Decide which conversation this run continues, and under which key. */
    plan(input: PlanInput): ResumePlan;
    /** Mark a key as busy for as long as a run is in flight. */
    begin(key: string): void;
    end(key: string): void;
    /**
     * Remember the conversation a finished run used, for the next one to continue.
     * The first task of a line becomes its description; every run refreshes lastTask.
     */
    remember(key: string, sessionId: string, cwd: string, info?: {
        name?: string;
        task?: string;
    }): void;
    /** Stored entry for a key; exposed for tests and diagnostics. */
    peek(key: string): StoredSession | undefined;
}
