/**
 * The live shell channel: a shell tool this plugin owns, for long commands.
 *
 * Why it exists: the Agent SDK never forwards a tool's stdout. Its message union
 * has no tool-output frame — only `tool_progress` heartbeats — because the CLI
 * keeps the Bash subprocess pipes to itself. So a build that prints for three
 * minutes shows a ticking card and nothing else. This module hands the delegate
 * a shell tool whose command WE spawn: the output is ours byte for byte, every
 * line is pushed into the same event stream the panel renders, and the exit code
 * and a per-command timeout are ours too.
 *
 * The built-in Bash tool stays available on purpose — Claude Code's Bash keeps a
 * persistent shell session (`cd`/`export` carry across calls) that a fresh child
 * process cannot reproduce. The injected system prompt therefore routes only
 * long commands here; short and stateful ones stay native.
 */
import { type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
/** MCP server name; the model addresses the tool as `mcp__dsh__shell`. */
export declare const LIVE_SHELL_SERVER = "dsh";
/** Tool name inside that server. */
export declare const LIVE_SHELL_TOOL = "shell";
/** Fully qualified tool id, as Claude Code names it (`mcp__<server>__<tool>`). */
export declare const LIVE_SHELL_TOOL_ID = "mcp__dsh__shell";
export type LiveShellStream = 'stdout' | 'stderr';
export interface LiveShellOptions {
    /** Working directory for the command (the delegation's cwd). */
    cwd: string;
    /** Extra environment (the same env the CLI child gets, e.g. proxy settings). */
    env?: Record<string, string>;
    /** Per-command timeout; defaults to 15 minutes. */
    timeoutMs?: number;
    /** Explicit bash path; falls back to env/PATH/well-known locations. */
    shellPath?: string;
    /** One line of output, as the command produced it. */
    onLine?: (line: string, stream: LiveShellStream, run: string) => void;
    /** The command started (useful for the panel's "running" marker). */
    onStart?: (info: {
        pid: number | undefined;
        command: string;
        run: string;
    }) => void;
    /** The command finished (exit code, wall clock, whether we killed it). */
    onEnd?: (info: {
        exitCode: number;
        durationMs: number;
        reason: 'exit' | 'timeout' | 'failed';
        run: string;
    }) => void;
}
export interface LiveShell {
    server: McpSdkServerConfigWithInstance;
    /** Kill every command still running (used when the delegation is aborted). */
    killAll: () => void;
}
/**
 * Find the bash Claude Code itself would use. On Windows that is Git Bash, NOT
 * the `WindowsApps\bash.exe` WSL stub that `where bash` reports first — that one
 * cannot run `-lc` commands against Windows paths.
 */
export declare function resolveBash(configured?: string): string | null;
/**
 * Build the MCP server. One instance per delegation, because the streaming
 * callback belongs to that run's event stream.
 */
export declare function createLiveShell(options: LiveShellOptions): LiveShell;
/** The rule appended to the delegate's system prompt when the channel is on. */
export declare const LIVE_SHELL_SYSTEM_RULE: string;
