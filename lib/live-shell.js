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
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** MCP server name; the model addresses the tool as `mcp__dsh__shell`. */
export const LIVE_SHELL_SERVER = 'dsh';
/** Tool name inside that server. */
export const LIVE_SHELL_TOOL = 'shell';
/** Fully qualified tool id, as Claude Code names it (`mcp__<server>__<tool>`). */
export const LIVE_SHELL_TOOL_ID = `mcp__${LIVE_SHELL_SERVER}__${LIVE_SHELL_TOOL}`;
/** Default per-command wall clock; the SDK also has its own MCP call timeout. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
/** Longest result handed back to the model (the panel keeps the full stream). */
const MAX_RESULT_CHARS = 8000;
/** Flush a never-ending line once it grows past this, so the stream keeps moving. */
const MAX_PENDING_BYTES = 256 * 1024;
/**
 * Find the bash Claude Code itself would use. On Windows that is Git Bash, NOT
 * the `WindowsApps\bash.exe` WSL stub that `where bash` reports first — that one
 * cannot run `-lc` commands against Windows paths.
 */
export function resolveBash(configured) {
    const candidates = [];
    if (configured !== undefined && configured !== '')
        candidates.push(configured);
    const fromEnv = process.env['CLAUDE_CODE_GIT_BASH_PATH'];
    if (fromEnv !== undefined && fromEnv !== '')
        candidates.push(fromEnv);
    if (process.platform === 'win32') {
        // Any `…\Git\cmd` on PATH implies `…\Git\bin\bash.exe`.
        for (const dir of (process.env['PATH'] ?? '').split(';')) {
            if (dir === '' || !/[\\/]git[\\/]/i.test(dir))
                continue;
            candidates.push(join(dirname(dir), 'bin', 'bash.exe'));
        }
        candidates.push('C:\\Program Files\\Git\\bin\\bash.exe');
        candidates.push('C:\\Program Files (x86)\\Git\\bin\\bash.exe');
    }
    else {
        candidates.push('/bin/bash', '/usr/bin/bash', '/bin/sh');
    }
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}
/**
 * Decode one complete chunk of bytes. Windows commands on a Chinese console emit
 * GBK, so a strict UTF-8 read would turn every test failure message into `?` —
 * fall back only when UTF-8 proves wrong (U+FFFD), which is what makes this safe.
 */
function decodeBytes(bytes) {
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (!utf8.includes('\uFFFD'))
        return utf8;
    try {
        return new TextDecoder('gbk', { fatal: false }).decode(bytes);
    }
    catch {
        return utf8;
    }
}
/**
 * Split a byte buffer into complete lines, keeping the unterminated tail as
 * bytes (decoding first and re-encoding would corrupt a GBK line split across
 * chunk boundaries).
 */
function takeLines(pending, atEnd, emit) {
    let rest = pending;
    for (;;) {
        if (rest.length === 0)
            break;
        const end = atEnd ? rest.length : rest.lastIndexOf(0x0a);
        if (end < 0)
            break;
        const head = rest.subarray(0, end);
        rest = rest.subarray(end + 1);
        emit(decodeBytes(head).replace(/\r$/, ''));
        if (atEnd)
            break;
    }
    if (!atEnd && rest.length > MAX_PENDING_BYTES) {
        emit(decodeBytes(rest).replace(/\r$/, ''));
        return Buffer.alloc(0);
    }
    return rest;
}
function killTree(child) {
    if (child.pid === undefined)
        return;
    if (process.platform === 'win32') {
        // `child.kill()` would only kill bash and leave the command it spawned.
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        return;
    }
    try {
        process.kill(-child.pid, 'SIGKILL');
    }
    catch {
        child.kill('SIGKILL');
    }
}
const SHELL_DESCRIPTION = [
    '在委派工作目录里执行一条 shell 命令，并实时回传输出。',
    '预计超过 20 秒的命令（构建、测试、长脚本、批量处理）用它：输出会逐行进入 Claude Code 面板，',
    '你可以看到进度；它也带独立超时，长时间无输出时会被终止并告诉你原因。',
    '短命令、需要跨命令保持 shell 状态（cd / export）的命令，请改用内置 Bash 工具。',
].join('');
const SHELL_INSTRUCTIONS = [
    '本通道用于长命令：命令在你的工作目录里以 `bash -lc` 启动，stdout/stderr 会被逐行采集并显示在面板里。',
    '每次调用都是一个全新进程，不保留上一次的 cwd 或环境变量；需要连续状态时用内置 Bash。',
].join('');
/**
 * Build the MCP server. One instance per delegation, because the streaming
 * callback belongs to that run's event stream.
 */
export function createLiveShell(options) {
    const children = new Set();
    /** Run counter: the model may issue several commands in one turn (in
        parallel), and each one's lines must reach its own block in the panel. */
    let runSeq = 0;
    const server = createSdkMcpServer({
        name: LIVE_SHELL_SERVER,
        version: '1.0.0',
        instructions: SHELL_INSTRUCTIONS,
        /* Always in the prompt: a tool the model only discovers after a search is a
           tool it will not use for the long command we are trying to watch. */
        alwaysLoad: true,
        tools: [
            tool(LIVE_SHELL_TOOL, SHELL_DESCRIPTION, {
                command: z.string().describe('要执行的命令（按 bash 语法；默认 bash -lc 执行）。'),
                cwd: z.string().optional().describe('可选：命令的工作目录，默认用委派的工作目录。'),
                timeoutMs: z.number().int().positive().optional()
                    .describe('可选：本命令的超时毫秒数，默认 15 分钟；超时会终止命令并返回原因。'),
                purpose: z.string().optional().describe('可选：一句话说明这条命令在干什么，会显示在面板上。'),
            }, async (args) => {
                const command = String(args.command ?? '').trim();
                if (command === '') {
                    return { content: [{ type: 'text', text: 'command 不能为空。' }], isError: true };
                }
                const bash = resolveBash(options.shellPath);
                if (bash === null) {
                    return {
                        content: [{
                                type: 'text',
                                text: '找不到 bash（Windows 上需要 Git Bash）。请改用内置 Bash 工具执行这条命令。',
                            }],
                        isError: true,
                    };
                }
                const cwd = typeof args.cwd === 'string' && args.cwd !== '' ? args.cwd : options.cwd;
                const timeoutMs = args.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
                const purpose = typeof args.purpose === 'string' && args.purpose !== '' ? args.purpose : undefined;
                const started = Date.now();
                runSeq += 1;
                const run = `c${runSeq}`;
                let child;
                try {
                    child = spawn(bash, ['-lc', command], {
                        cwd,
                        env: { ...process.env, ...options.env },
                        windowsHide: true,
                        stdio: ['ignore', 'pipe', 'pipe'],
                    });
                }
                catch (error) {
                    return {
                        content: [{ type: 'text', text: `命令未能启动：${error instanceof Error ? error.message : String(error)}` }],
                        isError: true,
                    };
                }
                children.add(child);
                options.onStart?.({ pid: child.pid, command: purpose === undefined ? command : `${purpose} — ${command}`, run });
                return await new Promise((resolve) => {
                    let tail = '';
                    let stdoutPending = Buffer.alloc(0);
                    let stderrPending = Buffer.alloc(0);
                    let timedOut = false;
                    let spawnError = null;
                    let settled = false;
                    const collect = (line) => {
                        tail += `${line}\n`;
                        if (tail.length > MAX_RESULT_CHARS * 2)
                            tail = tail.slice(-MAX_RESULT_CHARS);
                    };
                    const push = (line, stream) => {
                        collect(stream === 'stderr' ? `[stderr] ${line}` : line);
                        options.onLine?.(line, stream, run);
                    };
                    const timer = setTimeout(() => {
                        timedOut = true;
                        killTree(child);
                    }, timeoutMs);
                    const finish = (exitCode, reason) => {
                        if (settled)
                            return;
                        settled = true;
                        clearTimeout(timer);
                        children.delete(child);
                        stdoutPending = takeLines(stdoutPending, true, (line) => push(line, 'stdout'));
                        stderrPending = takeLines(stderrPending, true, (line) => push(line, 'stderr'));
                        options.onEnd?.({ exitCode, durationMs: Date.now() - started, reason, run });
                        const body = tail.trimEnd();
                        const truncated = body.length >= MAX_RESULT_CHARS;
                        const shown = truncated ? body.slice(-MAX_RESULT_CHARS) : body;
                        const header = timedOut
                            ? `命令超时（${timeoutMs}ms），已终止。`
                            : reason === 'failed'
                                ? `命令未能执行：${spawnError ?? '未知原因'}`
                                : `exit ${exitCode}`;
                        const notes = [
                            header,
                            truncated ? `（输出过长，仅回传最后 ${MAX_RESULT_CHARS} 字符；完整输出见 Claude Code 面板）` : '',
                        ].filter((line) => line !== '');
                        const text = shown === '' ? notes.join('\n') : `${notes.join('\n')}\n\n${shown}`;
                        resolve({
                            content: [{ type: 'text', text }],
                            isError: timedOut || reason === 'failed',
                        });
                    };
                    child.stdout?.on('data', (chunk) => {
                        stdoutPending = takeLines(Buffer.concat([stdoutPending, chunk]), false, (line) => push(line, 'stdout'));
                    });
                    child.stderr?.on('data', (chunk) => {
                        stderrPending = takeLines(Buffer.concat([stderrPending, chunk]), false, (line) => push(line, 'stderr'));
                    });
                    child.on('error', (error) => {
                        spawnError = error instanceof Error ? error.message : String(error);
                        finish(-1, 'failed');
                    });
                    child.on('close', (code) => {
                        finish(code ?? -1, timedOut ? 'timeout' : 'exit');
                    });
                });
            }),
        ],
    });
    return {
        server,
        killAll: () => {
            for (const child of [...children])
                killTree(child);
            children.clear();
        },
    };
}
/** The rule appended to the delegate's system prompt when the channel is on. */
export const LIVE_SHELL_SYSTEM_RULE = [
    `长命令走 ${LIVE_SHELL_TOOL_ID}：预计超过 20 秒的命令（构建、测试、长脚本、批量处理）请用该工具执行，`,
    '它的输出会实时显示给用户，并且能单独超时/取消。短命令与需要保持 shell 状态的命令继续用 Bash。',
].join('');
