/**
 * Which Claude Code conversation belongs to which workstream — and the register
 * that lets anyone look that up instead of remembering it.
 *
 * `resume` was always supported, but the handle only ever existed in one place:
 * the tail of a tool result, waiting for the caller to carry it to the next call.
 * Nobody did, so every delegation silently started a new conversation — the
 * mechanism worked and the behaviour was still "no memory".
 *
 * This file removes the handle from the caller's hands and leaves it in charge of
 * the one thing only the caller can know: WHICH workstream a task belongs to. One
 * directory is not one workstream — the same folder holds a deck and a weekly
 * report, and the two must never share a conversation. So the key is the workstream
 * name the caller declares (`conversation: <name>`) plus the directory, and the
 * mapping outlives a DSH restart.
 *
 * Each line also carries a self-written description: the first task it ever ran
 * (refreshed as `lastTask` on every later run). That is what turns the file from a
 * private mapping into a readable register — an unnamed call gets the register for
 * its directory printed back into the tool result, so the next call can pick the
 * right name by reading instead of guessing. Names drift; a visible list does not.
 *
 * An unnamed delegation therefore starts a NEW conversation. That is the safe
 * failure: forgetting the name costs continuity, never correctness. Handing a task
 * another workstream's history is the one outcome worth refusing, because that
 * history is what lets a follow-up rewrite someone else's work with no warning.
 * `continueUnnamed` restores the old convenience for the single-workstream case.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
/**
 * Why the file has a ceiling: one entry per workstream directory accumulates
 * forever otherwise, and every entry is a live-looking session id. Only the newest
 * `MAX_ENTRIES` survive a rewrite.
 */
const MAX_ENTRIES = 200;
/** How many register rows an unnamed call prints back, longest list truncated. */
const LIST_LIMIT = 6;
/** `$DSH_HOME` when the host sets it, else the conventional location. */
export function defaultSessionFile() {
    const home = process.env.DSH_HOME && process.env.DSH_HOME !== ''
        ? process.env.DSH_HOME
        : join(homedir(), '.dsh');
    return join(home, 'claude-delegate-sessions.json');
}
/**
 * Windows treats `C:\Foo` and `c:\foo` as one directory, so a stored handle must
 * not be lost to capitalisation. POSIX keeps its case.
 */
function normalizeCwd(cwd) {
    const absolute = resolve(cwd);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
function keyFor(namespace, cwd) {
    return `${namespace}\u0000${normalizeCwd(cwd)}`;
}
/** One line of a task, short enough to read in a register. */
export function excerpt(text, limit = 72) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
/** Human age of a timestamp; relative is what makes a register scannable. */
export function ago(iso, now = Date.now()) {
    const then = Date.parse(iso);
    if (Number.isNaN(then))
        return '时间未知';
    const minutes = Math.floor((now - then) / 60_000);
    if (minutes < 1)
        return '刚刚';
    if (minutes < 60)
        return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    return days < 60 ? `${days} 天前` : `${Math.floor(days / 30)} 个月前`;
}
export class SessionStore {
    file;
    entries = new Map();
    /** Keys with a run in flight; two processes must never own one conversation. */
    active = new Set();
    loaded = false;
    constructor(file = defaultSessionFile()) {
        this.file = file;
    }
    load() {
        if (this.loaded)
            return;
        this.loaded = true;
        try {
            const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
            for (const [key, value] of Object.entries(parsed.sessions ?? {})) {
                if (value && typeof value.sessionId === 'string' && value.sessionId !== '') {
                    // Entries written before the register existed have no createdAt; their
                    // last write is the best available stand-in.
                    const entry = value.createdAt === undefined
                        ? { ...value, createdAt: value.updatedAt ?? new Date().toISOString() }
                        : value;
                    this.entries.set(key, entry);
                }
            }
        }
        catch {
            // Missing or corrupt is the normal first-run case, and a delegation must
            // never fail over a lost convenience.
        }
    }
    save() {
        const sessions = {};
        for (const [key, value] of this.entries)
            sessions[key] = value;
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            const temp = `${this.file}.tmp`;
            writeFileSync(temp, `${JSON.stringify({ version: 2, sessions }, null, 2)}\n`, 'utf8');
            // Rename, so a crash mid-write cannot leave a half-parsed registry behind.
            renameSync(temp, this.file);
        }
        catch {
            // Same reasoning as load(): remembering is best-effort by design.
        }
    }
    /** One register row per line, newest first; optionally only one directory's. */
    lines(cwd) {
        this.load();
        const wanted = cwd === undefined ? undefined : normalizeCwd(cwd);
        const rows = [];
        for (const [key, value] of this.entries) {
            if (wanted !== undefined && normalizeCwd(value.cwd) !== wanted)
                continue;
            rows.push({
                key,
                sessionId: value.sessionId,
                cwd: value.cwd,
                runs: value.runs ?? 0,
                createdAt: value.createdAt ?? value.updatedAt ?? '',
                updatedAt: value.updatedAt ?? '',
                ...(value.name === undefined ? {} : { name: value.name }),
                ...(value.description === undefined ? {} : { description: value.description }),
                ...(value.lastTask === undefined ? {} : { lastTask: value.lastTask }),
            });
        }
        return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    }
    /** Which line owns this session id, when the register knows it. */
    findById(sessionId) {
        return this.lines().find((row) => row.sessionId === sessionId);
    }
    /** How one register row reads in a tool result or a panel. */
    static describe(row, now = Date.now()) {
        const label = row.name === undefined ? '(未命名)' : row.name;
        const what = row.description ?? row.lastTask ?? '（还没有描述）';
        return `· ${label} — ${what}（${row.runs} 轮，最后 ${ago(row.updatedAt, now)}）`;
    }
    registerNote(cwd) {
        const rows = this.lines(cwd);
        if (rows.length === 0) {
            return '这个目录下还没有注册过工作流。要新建一条，下次带上 conversation: <工作流名> 即可。';
        }
        const head = rows.slice(0, LIST_LIMIT).map((row) => SessionStore.describe(row));
        const more = rows.length > LIST_LIMIT ? `\n…这个目录还有 ${rows.length - LIST_LIMIT} 条` : '';
        return (`这个目录下已注册的工作流（名字 — 描述 — 轮次）：\n${head.join('\n')}${more}\n` +
            '要接续其中一条，把它前面的名字原样作为 conversation 传进来；要新建一条，起个新名字传进来即可。');
    }
    /** Decide which conversation this run continues, and under which key. */
    plan(input) {
        const named = input.conversation?.trim() ?? '';
        const owner = input.owner ?? '';
        const name = named === '' ? undefined : named;
        this.load();
        // An explicit session id is the caller naming the exact conversation to
        // continue, so it outranks everything below — including the refusal to guess
        // a workstream. The register is only consulted to explain what that id is.
        if (input.explicit !== undefined && input.explicit !== '') {
            const belongs = this.findById(input.explicit);
            const where = belongs === undefined
                ? '（注册表里没有这个会话的记录）'
                : belongs.name === undefined
                    ? `（注册表里它是 ${belongs.cwd} 的一条未命名线）`
                    : `（注册表里它属于工作流「${belongs.name}」）`;
            const pinned = named !== ''
                ? keyFor(`name:${named}`, input.cwd)
                : owner === ''
                    ? ''
                    : keyFor(`session:${owner}`, input.cwd);
            return {
                key: pinned,
                ...(name === undefined ? {} : { name }),
                resume: input.explicit,
                mode: 'explicit',
                reason: 'explicit',
                note: `[resumed] 按指定会话 ${input.explicit} 继续${where}`,
            };
        }
        if (named === '' && input.continueUnnamed !== true) {
            // Without a name there is nothing that could tell this task from the deck the
            // last call was editing. Starting new costs one repeated explanation; joining
            // the wrong line silently rewrites another workstream's work. The register is
            // printed back so the next call can name the line by reading, not guessing.
            return {
                key: '',
                mode: 'new',
                reason: 'unnamed',
                note: `[fresh] 新开会话：这次没有指定 conversation，不接续任何历史。\n${this.registerNote(input.cwd)}`,
            };
        }
        if (named === '' && owner === '') {
            return {
                key: '',
                mode: 'new',
                reason: 'unknown-owner',
                note: '[fresh] 新开会话：拿不到调用方会话 id，这次委派无法被记住',
            };
        }
        const key = keyFor(named !== '' ? `name:${named}` : `session:${owner}`, input.cwd);
        const line = named !== '' ? `工作流「${named}」` : '同一任务';
        const withName = name === undefined ? {} : { name };
        if (input.fresh === true) {
            return {
                key,
                ...withName,
                mode: 'new',
                reason: 'forced',
                note: named === ''
                    ? '[fresh] 新开会话（fresh: true）'
                    : `[fresh] 新开会话（fresh: true）：这次的结果会成为${line}新的接续点`,
            };
        }
        const previous = this.entries.get(key);
        if (previous === undefined) {
            return {
                key,
                ...withName,
                mode: 'new',
                reason: 'none',
                note: named === ''
                    ? ''
                    : `[new] 第一次用到${line}，已把它注册进会话表（首轮任务会成为它的描述）`,
            };
        }
        if (this.active.has(key)) {
            return {
                key,
                ...withName,
                mode: 'new',
                reason: 'busy',
                note: `[fresh] 新开会话：${line}上已有一个委派在跑，两个进程不能写同一份会话记录`,
            };
        }
        if (named === '') {
            return {
                key,
                mode: 'continued',
                resume: previous.sessionId,
                reason: 'none',
                note: `[continued] 接续上次的 Claude 会话 ${previous.sessionId}（同一任务 + 同一目录自动找回）`,
            };
        }
        const runs = previous.runs ?? 0;
        const about = previous.description === undefined ? '' : ` · ${previous.description}`;
        return {
            key,
            ...withName,
            resume: previous.sessionId,
            mode: 'continued',
            reason: 'none',
            note: `[continued] 接续${line} · 第 ${runs + 1} 轮 · 会话 ${previous.sessionId}${about}`,
        };
    }
    /** Mark a key as busy for as long as a run is in flight. */
    begin(key) {
        if (key !== '')
            this.active.add(key);
    }
    end(key) {
        if (key !== '')
            this.active.delete(key);
    }
    /**
     * Remember the conversation a finished run used, for the next one to continue.
     * The first task of a line becomes its description; every run refreshes lastTask.
     */
    remember(key, sessionId, cwd, info = {}) {
        if (key === '' || sessionId === '')
            return;
        this.load();
        const previous = this.entries.get(key);
        const now = new Date().toISOString();
        const task = info.task === undefined ? undefined : excerpt(info.task);
        const name = info.name ?? previous?.name;
        this.entries.set(key, {
            sessionId,
            cwd: resolve(cwd),
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
            runs: (previous?.runs ?? 0) + 1,
            ...(name === undefined ? {} : { name }),
            ...(previous?.description === undefined
                ? (task === undefined ? {} : { description: task })
                : { description: previous.description }),
            ...(task === undefined ? {} : { lastTask: task }),
        });
        if (this.entries.size > MAX_ENTRIES) {
            const ordered = [...this.entries.entries()].sort((a, b) => (a[1].updatedAt < b[1].updatedAt ? 1 : -1));
            for (const [stale] of ordered.slice(MAX_ENTRIES))
                this.entries.delete(stale);
        }
        this.save();
    }
    /** Stored entry for a key; exposed for tests and diagnostics. */
    peek(key) {
        this.load();
        return this.entries.get(key);
    }
}
