import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDefinition, Options } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { JobTracker, createEventBuffer, type ClaudeEvent, type EventBuffer, type TrackedSettlement } from './tracker.js'
import { ClaudeCodeRemote } from './remote.js'
import { SessionStore, type ResumePlan } from './session-store.js'
import { DELEGATION_SKILL } from './delegation-skill.js'
import {
  createLiveShell, LIVE_SHELL_SERVER, LIVE_SHELL_SYSTEM_RULE, LIVE_SHELL_TOOL_ID, type LiveShell,
} from './live-shell.js'
import { delegateModelFor, delegateEffortFor, EFFORT_LEVELS } from './delegate-model.js'

export { delegateModelFor, delegateEffortFor }

export const name = 'claude-code'
// NOTE: this cordis (@deepseek-ai/cordis 4.x) has NO optional-inject concept —
// every name declared in `inject` blocks activation until the service exists
// (the `{required, optional}` object form is treated as literal service names
// "required"/"optional" and deadlocks the fiber; see CHANGELOG 0.4.1).
// sessionProjections is therefore read lazily via `ctx.get()` at call time,
// which bypasses the inject requirement and returns undefined when absent.
export const inject = ['tools', 'skills']

const CLIENT_APP = 'dsh-claude-delegate/0.8.1'

/**
 * Panel-side id counter for foreground delegations.
 *
 * Background runs take the harness's own job id; a foreground call has none, so it
 * gets a plugin-local one to be listed by the monitor panel like any other run.
 */
let foregroundJobSeq = 0

/** Cap for the live-output buffers kept per background job. */
const MAX_LIVE_BUFFER = 500_000

/**
 * Cap for one tool_result / result payload carried on the event stream.
 *
 * Deliberately larger than a chat reply: the SDK never forwards a tool's stdout
 * (only `tool_progress` heartbeats), so this stream is the panel's only access to
 * what a command printed. The CLI's own inline budget is `bashOutputMaxChars`
 * (30000 by default), and it writes the rest to a file it names in the result, so
 * this matches that default instead of second-guessing it — and the cap keeps the
 * TAIL, because that is where a log's verdict and that file pointer sit.
 */
const MAX_EVENT_TEXT = 30_000

const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] as const
const THINKING_MODES = ['adaptive', 'disabled'] as const

export interface SubagentConfig {
  description: string
  prompt: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  maxTurns?: number
  initialPrompt?: string
  background?: boolean
}

export interface Config {
  model: string
  followMainModel: boolean
  followMainEffort: boolean
  permissionMode: string
  maxTurns: number
  timeoutMs: number
  warnTimeoutMs: number
  warnIntervalMs: number
  cwd?: string
  allowedTools?: string[]
  pathToClaudeCodeExecutable?: string
  effort?: string
  maxThinkingTokens?: number
  thinkingMode?: 'adaptive' | 'disabled'
  maxBudgetUsd?: number
  appendSystemPrompt?: string
  allowDangerouslySkipPermissions: boolean
  shellChannel: boolean
  shellChannelOnly: boolean
  /** Continuity for unnamed calls: off means an unnamed call never joins a line (see session-store.ts). */
  continueUnnamed: boolean
  shellPath?: string
  shellTimeoutMs?: number
  autoBackgroundTimeoutMs?: number
  bashOutputMaxChars?: number
  proxy?: string
  subagents?: Record<string, SubagentConfig>
}

export const Config: z<Config> = z.object({
  model: z.string().description('Fallback Claude model alias (sonnet/opus/haiku) or full id, used when no dynamic default applies.').default('sonnet'),
  followMainModel: z.boolean()
    .description('Derive the delegation default from the CALLING session\'s current main model (fable→opus, opus→sonnet, sonnet→sonnet); an explicit model argument always wins. Off → always use `model`.')
    .default(true),
  followMainEffort: z.boolean()
    .description('Derive the delegation default thinking effort from the CALLING session\'s current reasoning-effort tier; an explicit effort argument always wins. Off → always use `effort`.')
    .default(true),
  permissionMode: z.string()
    .description("Claude Code permission mode: default, acceptEdits, bypassPermissions, plan, dontAsk, or auto. Note: delegated sessions are headless — dontAsk silently denies every confirmation prompt; prefer acceptEdits.")
    .default('acceptEdits'),
  maxTurns: z.number().description('Maximum Claude Code agentic turns per task.').default(100),
  timeoutMs: z.number().description('Hard timeout budget for one call (ms); background tasks are aborted once it is reached.').default(7200000),
  warnTimeoutMs: z.number().description('Emit a warning event (do NOT abort) after the task has run this long (ms); 0 disables.').default(3600000),
  warnIntervalMs: z.number().description('Repeat the warning every N ms while the task keeps running past warnTimeoutMs (ms); 0 disables repeats.').default(1800000),
  cwd: z.string().description("Working directory for Claude Code; defaults to the calling session's working directory."),
  allowedTools: z.array(z.string()).description('Claude Code built-in tools to allow.'),
  pathToClaudeCodeExecutable: z.string().description('Path to the claude executable; auto-detected when omitted.'),
  effort: z.string().description('Fallback thinking effort (low/medium/high/xhigh/max), used when no dynamic default applies (see followMainEffort).').default('high'),
  maxThinkingTokens: z.number().description('Optional thinking token budget per task (deprecated; prefer thinkingMode).'),
  thinkingMode: z.union([...THINKING_MODES])
    .description('Thinking mode: adaptive (Claude decides) or disabled. Unset keeps the SDK default.'),
  maxBudgetUsd: z.number().description('Hard USD budget per task; the run stops once it is reached.'),
  appendSystemPrompt: z.string().description("Instructions appended to Claude Code's default system prompt."),
  shellChannel: z.boolean()
    .description(
      'Expose mcp__dsh__shell — a shell tool this plugin owns, so a long command\'s output streams live into the ' +
      'Claude Code panel. The Agent SDK never forwards a tool\'s stdout (no such message exists; only tool_progress ' +
      'heartbeats), because the CLI keeps the Bash pipes to itself. The built-in Bash tool stays available for short ' +
      'and stateful commands; the injected system prompt routes long ones to the channel.',
    )
    .default(true),
  shellChannelOnly: z.boolean()
    .description(
      'Route every command through the live shell channel by denying the built-in Bash tool: 100% live output, at ' +
      'the cost of shell state (each command is a fresh process, so cd/export do not carry across calls).',
    )
    .default(false),
  continueUnnamed: z.boolean()
    .description(
      'Opt back into the removed default: an unnamed delegation continues this DSH session\'s own conversation in ' +
      'the same directory. Off means an unnamed call always starts a NEW conversation and never joins an existing ' +
      'one — the safe failure, because one directory can hold several workstreams (a deck and a weekly report) and ' +
      'joining the wrong one hands a task someone else\'s history with no warning. Only turn this on when one ' +
      'directory really is one workstream.',
    )
    .default(false),
  shellPath: z.string().description('bash executable for the live shell channel; auto-detected (CLAUDE_CODE_GIT_BASH_PATH, Git on PATH) when omitted.'),
  shellTimeoutMs: z.number().description('Per-command timeout for the live shell channel (ms); on expiry the whole process tree is killed.').default(900000),
  autoBackgroundTimeoutMs: z.number()
    .description(
      'Injected as CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS: a command still running after this many ms is moved to ' +
      'the background by Claude Code itself, which persists its output to a file the panel can read back in full. ' +
      'Default 0 leaves the CLI default alone. This DOES change model behaviour — the model then polls TaskOutput ' +
      'for the result instead of receiving it inline — so it stays off unless you ask for it.',
    )
    .default(0),
  bashOutputMaxChars: z.number()
    .description(
      'Passed to Claude Code as the `bashOutputMaxChars` setting (via --settings): how many characters of a command\'s ' +
      'output the DELEGATED MODEL receives inline. The CLI default is 30000 and values clamp to 4000-128000; output ' +
      'past it is written to a file and named in the result. The panel reads that file, so raising this spends the ' +
      'delegated model\'s context, not the panel\'s. Default 0 leaves the CLI default alone.',
    )
    .default(0),
  allowDangerouslySkipPermissions: z.boolean()
    .description('Deliberate safety switch required before permissionMode bypassPermissions is accepted.')
    .default(false),
  proxy: z.string().description(
    'HTTP proxy for the claude subprocess (e.g. http://127.0.0.1:7897). ' +
    'Sets HTTPS_PROXY/HTTP_PROXY/ALL_PROXY for the spawned claude; useful when the machine outbound IP is a ' +
    'datacenter IP and Anthropic rejects requests (403) without a proxy. NO_PROXY keeps localhost direct.',
  ),
  subagents: z.dict(z.object({
    description: z.string().description('When Claude Code should invoke this subagent.').required(),
    prompt: z.string().description("The subagent's system prompt.").required(),
    tools: z.array(z.string()).description('Tools the subagent may use; inherits all tools when omitted.'),
    disallowedTools: z.array(z.string()).description('Tools explicitly denied to the subagent.'),
    model: z.string().description("Model alias for the subagent; inherits the main model when omitted."),
    maxTurns: z.number().description('Maximum agentic turns for the subagent.'),
    initialPrompt: z.string().description('Auto-submitted first user turn for the subagent.'),
    background: z.boolean().description('Run this subagent as a background task when invoked.'),
  })).description('Custom subagents exposed to Claude Code via its Agent tool, keyed by subagent name.'),
})

/** The CALLING session's current selection (model + reasoning-effort tier). */
interface MainSelection { model?: string; reasoningEffort?: string }

/**
 * The CALLING session's current main-model selection. Authoritative source is
 * the durable `modelSelection` session projection (pending ?? lastUsed), which
 * tracks mid-session model/effort switches and carries `reasoningEffort`
 * alongside `model`; `agent.options.model` is only the creation-time value and
 * is used as the fallback when the projection service or state is unavailable
 * (creation-time options carry no effort, so effort is simply absent there).
 */
function currentMainSelection(ctx: Context, agent: unknown): MainSelection {
  const a = agent as { session?: unknown; options?: { model?: string } } | undefined
  if (a === undefined) return {}
  try {
    // ctx.get() reads a service WITHOUT the inject requirement (cordis
    // reflect.get mixin) — returns undefined when the service is absent,
    // instead of blocking plugin activation like an inject declaration would.
    const projections = (ctx as unknown as { get?: (name: string) => unknown })
      .get?.('sessionProjections') as {
        stateOf?: (session: unknown, key: string) =>
          { pending?: MainSelection | null; lastUsed?: MainSelection | null } | undefined
      } | undefined
    if (a.session !== undefined && typeof projections?.stateOf === 'function') {
      const state = projections.stateOf(a.session, 'modelSelection')
      const selected = state?.pending ?? state?.lastUsed
      if (selected?.model) return selected
    }
  } catch {
    // projection not registered in this profile — creation-time fallback below
  }
  return { model: a.options?.model }
}

/**
 * The CALLING session's working directory. On DSH 0.2.x the live value is
 * `agent.session.header.cwd` — the same field the bundled tools read
 * (dsh-tool-fs, dsh-tool-bash, dsh-tools all use `exec.agent?.session.header.cwd`).
 * The older `session.meta.cwd` / creation-time `options.cwd` lookups stay as
 * fallbacks. Before this, an omitted cwd fell through to process.cwd(), i.e. the
 * desktop profile directory, which is almost never where the user's files are.
 */
function sessionCwd(agent: unknown): string | undefined {
  const a = agent as
    | {
        session?: { header?: { cwd?: string }; meta?: { cwd?: string } }
        options?: { cwd?: string }
      }
    | undefined
  const cwd = a?.session?.header?.cwd ?? a?.session?.meta?.cwd ?? a?.options?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * The CALLING session's id — the namespace automatic continuation remembers under.
 * This is the same value the jobs seam takes as an owner (it resolves it through
 * `agents.get(id)`), so a job and its resume key always agree on who "this task" is.
 */
function sessionOwnerId(agent: unknown): string | undefined {
  const a = agent as { id?: string; session?: { id?: string } } | undefined
  // `agent.session.id` is the live form on DSH 0.2.x (see dsh-agent's own guard);
  // `agent.id` is kept as the fallback.
  const id = a?.session?.id ?? a?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

const PARALLEL_DEV_SKILL: SkillRegistration = {
  name: 'parallel-dev',
  description:
    '并行开发编排：把多个开发任务自动编排成并行执行——判断是否需要用 git worktree、自动建分支与目录、并行分派给 claude_code、完成后集成。用户只需要说"并行开发 A 和 B"，不需要懂任何 git 细节。',
  whenToUse:
    '用户要求并行/同时开发多个模块或任务（"一起做""并行""同时推进""分开做"）；或用户列出多个开发目标且明显希望加快整体进度；或单个大任务需要拆分并行。',
  source: 'runtime' as const,
  content: [
    '# 并行开发编排 SOP（parallel-dev）',
    '',
    'DSH 是编排者：把"并行开发多个模块"这件事自动落地，用户只提需求、不问技术细节（包括是否用 worktree）。',
    '',
    '## 何时用 / 何时不用',
    '- 用：用户要求并行/同时开发多个模块或任务；多个任务互不依赖或依赖关系已明确；大任务可拆成多个自包含子任务。',
    '- 不用：单一任务、串行即可满足（默认）；任务之间强依赖且无法并行（先做 A 才能做 B）；用户没有表达并行意图。',
    '',
    '## 决策树（先想清楚，再动手）',
    '1. 并行任务数 ≥ 2 且都涉及写代码？否 → 串行顺序做，不建 worktree，不打扰用户。',
    '2. 任务改的是同一个仓库？否 → 各自独立目录，直接并行，不建 worktree。',
    '3. 改动文件可能重叠？已确认完全不重叠 → 可共享工作区并行；否则/不确定 → 用 worktree 隔离。',
    '4. 用 worktree：每个任务一个分支（feat/<模块名>）+ 一个独立目录（../proj-<模块名>），互不踩文件。',
    '',
    '## 确认边界（只问业务，绝不问技术）',
    '- 明确说"并行/一起/同时/分开做" → 直接执行，不确认。',
    '- 没提并行 → 默认串行，不确认，按合理顺序逐个做。',
    '- 暗示了并行但没说清（如"这两个都很急""两个都做完"）→ 确认一次，只问业务："A 和 B 要并行推进，还是先后做？"',
    '- 永远不要问用户"要不要开 worktree / 用哪个分支"——那是编排层的职责。',
    '',
    '## worktree 操作（命令模板，用户不可见，直接执行）',
    '- 查看现有：git worktree list',
    '- 建 worktree：git worktree add ../proj-<模块名> feat/<模块名>（从 main 拉出）',
    '- 注意：同一分支不能 checkout 到两个 worktree；main 只保留一个集成用 worktree。',
    '',
    '## 并行分派',
    '- 每个任务用 claude_code 委派，cwd 指向对应 worktree 目录，建议 run_in_background: true 并行跑。',
    '- 任务书照 claude-code-delegation SOP：目标 / 相关文件绝对路径 / 约束（构建验证命令、禁止事项）/ 验收。',
    '- 依赖模块之间：先定接口契约（把接口定义写进各自任务书），或让下游任务引用上游分支的提交。',
    '- 派完不要空等：用 job_output 增量读进展，各自 review 产出，不满意带反馈再派一轮（resume 传 sessionId）。',
    '',
    '## 集成与收尾',
    '- 每个模块完成：在其 worktree 里跑构建/测试验证通过后提交（git -C ../proj-<名> commit）。',
    '- 全部完成后：回主 worktree（main），逐个 merge 各分支，跑一次整体构建/测试。',
    '- 清理：git worktree remove ../proj-<模块名>（保留分支或删除均可）。',
    '- 集成冲突：按模块边界解决；小步提交（每模块一个可编译增量）能显著减少冲突。',
    '',
    '## 注意',
    '- 每个 worktree 独立装依赖/构建（node_modules 各自一份，磁盘占用翻倍是并行的正常代价）。',
    '- 不要跨 worktree 同时 push 同一个分支；push 统一走 main 集成后的提交。',
    '- 用户关心的是结果：并行方案、分支名、worktree 目录都不需要汇报细节，只汇报"哪些模块已完成/进行中/阻塞"。',
  ].join("\n"),
}

const CLAUDE_MISSING =
  'claude executable not found — install it with: npm install -g @anthropic-ai/claude-code'

/** Positive PATH probes are cached; a negative result is re-probed so a later install is picked up. */
let claudeOnPath = false

function hasClaudeOnPath(): boolean {
  if (claudeOnPath) return true
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    const result = spawnSync(probe, ['claude'], { stdio: 'ignore', windowsHide: true })
    claudeOnPath = result.status === 0
  } catch {
    claudeOnPath = false
  }
  return claudeOnPath
}

/** Fast, synchronous checks that turn the common misconfigurations into actionable errors. */
function preflight(opts: {
  cwd: string
  pathToClaudeCodeExecutable?: string
  permissionMode: string
  allowDangerouslySkipPermissions: boolean
}) {
  let isDirectory = false
  try {
    isDirectory = statSync(opts.cwd).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) throw new Error(`cwd does not exist or is not a directory: ${opts.cwd}`)

  if (opts.pathToClaudeCodeExecutable) {
    if (!existsSync(opts.pathToClaudeCodeExecutable)) {
      throw new Error(`${CLAUDE_MISSING} (configured pathToClaudeCodeExecutable does not exist: ${opts.pathToClaudeCodeExecutable})`)
    }
  } else if (!hasClaudeOnPath()) {
    throw new Error(CLAUDE_MISSING)
  }

  if (opts.permissionMode === 'bypassPermissions' && !opts.allowDangerouslySkipPermissions) {
    throw new Error(
      'permissionMode "bypassPermissions" 会让 Claude Code 跳过全部权限确认，属于有意的安全开关：' +
      '请在插件配置里显式设置 allowDangerouslySkipPermissions: true，或改用 acceptEdits / auto。',
    )
  }
}

/**
 * A resume whose conversation is gone (cleaned up, or a wiped `~/.claude`).
 *
 * Used twice on purpose: to explain the failure to the caller, and to let an
 * AUTOMATIC continuation fall back to a fresh conversation. A continuation the
 * caller never asked for by hand must not turn into a failed task.
 */
const RESUME_GONE = /no conversation found|could not find session|session .{0,40}not found|failed to resume|resume.{0,40}(failed|not found)/i

const ERROR_HINTS: { match: RegExp, hint: string }[] = [
  {
    match: /error_max_budget_usd|max_budget|budget_exhausted/i,
    hint: '达到 maxBudgetUsd 预算上限，任务被中止 — 调高 maxBudgetUsd 或缩小任务范围 (max USD budget reached)',
  },
  {
    match: /authentication_failed|not authenticated|invalid api key|unauthorized|\b401\b|oauth/i,
    hint: 'Claude Code 认证失败 — 请先在终端运行一次 `claude` 完成登录 (authentication failed; run `claude` once to log in)',
  },
  {
    match: /billing|payment|credit balance|insufficient/i,
    hint: '订阅计费问题 — 请检查你的 Claude 订阅状态 (billing error; check your Claude subscription)',
  },
  {
    match: /rate_?limit|overloaded|too many requests|\b429\b|\b529\b/i,
    hint: '暂时限流或服务过载 — 稍后重试 (rate limited / overloaded; retry later)',
  },
  {
    match: /\b403\b|forbidden/i,
    hint: 'Anthropic 拒绝了请求（常见于数据中心出网 IP）— 给 DSH 进程设置 HTTPS_PROXY / HTTP_PROXY 后重启再试 (403; set a proxy for the DSH process)',
  },
  {
    match: /model_not_found|unknown model|invalid model|model.*not found/i,
    hint: 'model 参数无效 — 使用 sonnet / opus / haiku 或一个有效的完整模型 id (invalid model)',
  },
  {
    match: RESUME_GONE,
    hint: 'resume 的会话不存在或已被清理 — 去掉 resume 重新发起一次任务 (resume session gone; retry without resume)',
  },
  {
    match: /enoent|not found.*claude|spawn.*claude/i,
    hint: CLAUDE_MISSING,
  },
]

/** Map a raw SDK/CLI failure onto an actionable message, keeping the original detail. */
function describeFailure(raw: string): string {
  const detail = raw.trim() || 'unknown error'
  for (const { match, hint } of ERROR_HINTS) {
    if (match.test(detail)) return `claude_code failed: ${hint} — ${detail}`
  }
  return `claude_code failed: ${detail}`
}

/**
 * The one line that makes `resume` usable: without it the session handle stays
 * inside the structured payload and the model never sees it, so every follow-up
 * iteration silently starts from zero.
 */
function sessionLine(sessionId: unknown): string {
  return typeof sessionId === 'string' && sessionId !== ''
    ? `\nsession: ${sessionId} — this conversation is remembered for the task; pass it back as \`resume\` to pin it`
    : ''
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function toAgentDefinitions(subagents?: Record<string, SubagentConfig>): Record<string, AgentDefinition> | undefined {
  if (!subagents) return undefined
  const agents: Record<string, AgentDefinition> = {}
  for (const [agentName, def] of Object.entries(subagents)) {
    if (!def || typeof def.description !== 'string' || typeof def.prompt !== 'string') continue
    const agent: AgentDefinition = { description: def.description, prompt: def.prompt }
    if (def.tools?.length) agent.tools = def.tools
    if (def.disallowedTools?.length) agent.disallowedTools = def.disallowedTools
    if (def.model) agent.model = def.model
    if (typeof def.maxTurns === 'number') agent.maxTurns = def.maxTurns
    if (def.initialPrompt) agent.initialPrompt = def.initialPrompt
    if (def.background) agent.background = true
    agents[agentName] = agent
  }
  return Object.keys(agents).length ? agents : undefined
}

/** JSON or nothing — used for values that only ever travel over the wire. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** One payload after the panel cap: what survived, and what the cap dropped. */
interface CappedText {
  text: string
  /** Length before the cap. */
  totalChars: number
  /** Characters dropped from the head; 0 when nothing was dropped. */
  omittedChars: number
}

/**
 * Cap one event payload, keeping the TAIL.
 *
 * A head-keeping cut is the wrong end here twice over: a log or a test run states
 * its verdict on the last line, and the CLI has already truncated the head itself
 * (it appends `Full output saved to: <path>` at the end, which is the pointer the
 * panel needs to fetch the rest). The embedded marker keeps that fact inside the
 * text, so a copied payload still says what happened.
 */
function capTailText(text: string): CappedText {
  if (text.length <= MAX_EVENT_TEXT) return { text, totalChars: text.length, omittedChars: 0 }
  const omitted = text.length - MAX_EVENT_TEXT
  return {
    text: `…[omitted ${omitted} chars from the head]\n${text.slice(omitted)}`,
    totalChars: text.length,
    omittedChars: omitted,
  }
}

/**
 * `Full output saved to: <path>` — how the CLI points at output it could not hand
 * over inline (its `bashOutputMaxChars` budget, or a background task's file). On a
 * resumed session the same sentence arrives wrapped in parentheses.
 */
const PERSISTED_OUTPUT = /Full output saved to:\s*([^\r\n]+?)\s*$/gm

/** Strip the quoting and the closing bracket a `Full output saved to:` line adds. */
function cleanPath(raw: string): string {
  let path = raw.trim().replace(/^["'`]/, '').replace(/["'`]$/, '')
  if (path.endsWith(')') && !path.includes('(')) path = path.slice(0, -1).trim()
  return path
}

/**
 * Paths, in order of appearance, that the CLI said it persisted output to.
 *
 * Only absolute paths survive: a relative one would be resolved against this
 * process's cwd rather than the directory the CLI wrote it in.
 */
function persistedOutputPaths(text: string): string[] {
  const paths: string[] = []
  for (const match of text.matchAll(PERSISTED_OUTPUT)) {
    const path = cleanPath(match[1] ?? '')
    if (/^(?:[A-Za-z]:[\\/]|\/)/.test(path)) paths.push(path)
  }
  return paths
}

/** Keep a tool_use input only when it survives a JSON round trip. */
function toEventInput(input: unknown): unknown {
  try {
    JSON.stringify(input)
    return input
  } catch {
    return String(input)
  }
}

/**
 * Flatten a `tool_result` payload into one plain string: the SDK hands it over
 * as a bare string or as a block array (text / image / anything a tool emits).
 */
function toResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === undefined || content === null) return ''
  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object') {
        if (typeof part.text === 'string') return part.text
        if (part.type === 'image') return '[image]'
      }
      return safeJson(part)
    }).join('\n')
  }
  return safeJson(content)
}

interface RunRequest {
  task: string
  cwd: string
  model: string
  permissionMode: string
  maxTurns: number
  timeoutMs: number
  warnTimeoutMs: number
  warnIntervalMs: number
  allowedTools?: string[]
  pathToClaudeCodeExecutable?: string
  resume?: string
  effort?: string
  maxThinkingTokens?: number
  thinkingMode?: 'adaptive' | 'disabled'
  maxBudgetUsd?: number
  appendSystemPrompt?: string
  outputSchema?: Record<string, unknown>
  proxy?: string
  agents?: Record<string, AgentDefinition>
  allowDangerouslySkipPermissions: boolean
  shellChannel: boolean
  shellChannelOnly: boolean
  shellPath?: string
  shellTimeoutMs?: number
  /** CLI auto-background threshold in ms; 0/undefined leaves the CLI default alone. */
  autoBackgroundTimeoutMs?: number
  /** CLI `bashOutputMaxChars` setting; 0/undefined leaves the CLI default alone. */
  bashOutputMaxChars?: number
}

interface RunOutcome {
  output: string
  sessionId: string
  costUsd: number
  inputTokens: number
  outputTokens: number
  toolsUsed: string[]
  durationMs: number
  numTurns: number
  structuredOutput?: unknown
}

function buildQueryOptions(req: RunRequest, abort: AbortController, shell?: LiveShell): Options {
  // The live shell is pre-approved alongside whatever the caller allowed: an MCP
  // tool that still needs a permission prompt is a tool that never runs, since a
  // delegated session is headless and cannot answer one.
  const allowed = req.allowedTools === undefined ? [] : [...req.allowedTools]
  if (shell !== undefined && !allowed.includes(LIVE_SHELL_TOOL_ID)) allowed.push(LIVE_SHELL_TOOL_ID)
  // Typed as a plain record on purpose: spreading `process.env` (an index-signature
  // type) into an object literal would otherwise leave the literal with only the
  // keys written here, and every assignment below would fail to typecheck.
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[name] = value
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = CLIENT_APP
  if (req.proxy) {
    env.HTTPS_PROXY = req.proxy
    env.HTTP_PROXY = req.proxy
    env.ALL_PROXY = req.proxy
    env.NO_PROXY = process.env.NO_PROXY ?? 'localhost,127.0.0.1'
  }
  // The CLI reads this threshold from the environment (it is not a settings key):
  // past it, a still-running command is moved to the background and its output is
  // persisted to a file. That file is the one the panel reads back in full, so this
  // knob is what makes "see the whole output" possible for very long commands.
  if (typeof req.autoBackgroundTimeoutMs === 'number' && req.autoBackgroundTimeoutMs > 0) {
    env.CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS = String(Math.floor(req.autoBackgroundTimeoutMs))
  }
  const options: Options = {
    cwd: req.cwd,
    model: req.model,
    permissionMode: req.permissionMode as Options['permissionMode'],
    maxTurns: req.maxTurns,
    allowedTools: allowed.length > 0 ? allowed : undefined,
    pathToClaudeCodeExecutable: req.pathToClaudeCodeExecutable,
    resume: req.resume,
    effort: req.effort as Options['effort'],
    abortController: abort,
    includePartialMessages: true,
    env,
  }
  if (req.allowDangerouslySkipPermissions) options.allowDangerouslySkipPermissions = true
  if (req.thinkingMode) options.thinking = { type: req.thinkingMode }
  else if (typeof req.maxThinkingTokens === 'number') options.maxThinkingTokens = req.maxThinkingTokens
  if (typeof req.maxBudgetUsd === 'number') options.maxBudgetUsd = req.maxBudgetUsd
  if (shell !== undefined) {
    options.mcpServers = { [LIVE_SHELL_SERVER]: shell.server }
    const disallowed = req.shellChannelOnly ? ['Bash'] : []
    if (disallowed.length > 0) options.disallowedTools = disallowed
  }
  const appended = [
    req.appendSystemPrompt,
    shell === undefined ? undefined : LIVE_SHELL_SYSTEM_RULE,
  ].filter((part): part is string => part !== undefined && part !== '')
  if (appended.length > 0) {
    options.systemPrompt = { type: 'preset', preset: 'claude_code', append: appended.join('\n\n') }
  }
  if (req.agents) options.agents = req.agents
  // `bashOutputMaxChars` has no environment variable — it is a settings key, and
  // the SDK hands `settings` to the CLI as `--settings <json>`, which the CLI
  // loads as ADDITIONAL settings on top of the user's own file (where the relay
  // endpoint lives), so only this one key is overridden. The CLI clamps to
  // 4000-128000 by itself; the clamp here keeps an accidental small number from
  // asking for a one-character budget.
  if (typeof req.bashOutputMaxChars === 'number' && req.bashOutputMaxChars > 0) {
    const wanted = Math.max(4000, Math.min(128_000, Math.floor(req.bashOutputMaxChars)))
    options.settings = JSON.stringify({ bashOutputMaxChars: wanted })
  }
  if (req.outputSchema) options.outputFormat = { type: 'json_schema', schema: req.outputSchema }
  return options
}

/**
 * Run one delegation.
 *
 * Two independent observers may follow it. `onDelta` is the TEXT stream the
 * model's `job_output` consumes — token-level, append-only, unchanged since
 * 0.2.0. `onEvent` is the STRUCTURED stream the monitor panel renders: one
 * event per completed content block, in arrival order. Partial deltas are
 * deliberately not mirrored into events, so the panel paints whole blocks
 * instead of flickering character by character.
 */
async function runClaude(
  req: RunRequest,
  abort: AbortController,
  onDelta?: (text: string) => void,
  onEvent?: (event: ClaudeEvent) => void,
): Promise<RunOutcome> {
  let output = ''
  let sessionId = ''
  let costUsd = 0
  let inputTokens = 0
  let outputTokens = 0
  let durationMs = 0
  let numTurns = 0
  let structuredOutput: unknown
  const toolsUsed = new Set<string>()
  let failure: string | undefined

  // The live shell channel: a shell tool WE own, so a long command's output
  // reaches the panel as it is produced. The SDK cannot do this for the built-in
  // Bash tool — it never forwards tool stdout (see live-shell.ts).
  const live = req.shellChannel
    ? createLiveShell({
      cwd: req.cwd,
      shellPath: req.shellPath,
      timeoutMs: req.shellTimeoutMs,
      ...(req.proxy
        ? {
          env: {
            HTTPS_PROXY: req.proxy,
            HTTP_PROXY: req.proxy,
            ALL_PROXY: req.proxy,
            NO_PROXY: process.env.NO_PROXY ?? 'localhost,127.0.0.1',
          },
        }
        : {}),
      onLine: (line, stream, run) => onEvent?.({ type: 'console', stream, text: line, run }),
      onStart: (info) => onEvent?.({
        type: 'console',
        stream: 'meta',
        text: `$ ${info.command}`,
        run: info.run,
        phase: 'start',
      }),
      onEnd: (info) => onEvent?.({
        type: 'console',
        stream: 'meta',
        text: `exit ${info.exitCode} · ${(info.durationMs / 1000).toFixed(1)}s${info.reason === 'timeout' ? ' · 超时终止' : ''}`,
        run: info.run,
        phase: 'end',
      }),
    })
    : undefined
  const killChildren = (): void => live?.killAll()
  abort.signal.addEventListener('abort', killChildren, { once: true })

  const stream = query({ prompt: req.task, options: buildQueryOptions(req, abort, live) })
  // Text already streamed to the panel as partial deltas, so the finished block
  // is not emitted a second time.
  let deltaText = ''

  try {
    for await (const msg of stream) {
      if (msg.type === 'assistant') {
        sessionId = msg.session_id
        if (msg.error) failure = msg.error
        for (const block of msg.message.content as any[]) {
          if (block.type === 'text') {
            output += block.text
            // Partial deltas already painted this text; emit only whatever the
            // stream did not cover, so the panel never shows it twice.
            const covered = deltaText.length > 0 && block.text.startsWith(deltaText)
            const rest = covered ? block.text.slice(deltaText.length) : block.text
            if (rest) onEvent?.({ type: 'text', text: rest })
            deltaText = ''
          } else if (block.type === 'thinking') {
            const thinking = typeof block.thinking === 'string' ? block.thinking : ''
            if (thinking) {
              onEvent?.({
                type: 'thinking',
                thinking,
                ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
              })
            }
          } else if (block.type === 'tool_use') {
            toolsUsed.add(block.name)
            onDelta?.(`\n[tool] ${block.name}\n`)
            onEvent?.({
              type: 'tool_use',
              ...(typeof block.id === 'string' ? { id: block.id } : {}),
              name: String(block.name),
              input: toEventInput(block.input),
            })
          }
        }
        // A message with no text block still closes the delta run.
        deltaText = ''
      } else if (msg.type === 'user') {
        // Tool results come back as a user turn. Replays (a resumed session
        // re-emitting its history) would duplicate the panel's stream.
        const raw = msg as any
        const content = raw.message?.content
        if (raw.isReplay !== true && Array.isArray(content)) {
          for (const block of content as any[]) {
            if (block?.type !== 'tool_result') continue
            const full = toResultText(block.content)
            const capped = capTailText(full)
            const persisted = persistedOutputPaths(full)
            onEvent?.({
              type: 'tool_result',
              tool_use_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
              content: capped.text,
              ...(capped.omittedChars > 0
                ? { totalChars: capped.totalChars, omittedChars: capped.omittedChars }
                : {}),
              ...(persisted.length > 0 ? { outputPath: persisted[persisted.length - 1] } : {}),
              ...(block.is_error === true ? { isError: true } : {}),
            })
          }
        }
      } else if (msg.type === 'stream_event') {
        const event = msg.event as any
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const text = event.delta.text
          if (typeof text === 'string' && text) {
            onDelta?.(text)
            // Same text, second observer: the panel renders it as it arrives so
            // a long block grows in place instead of landing when it finishes.
            onEvent?.({ type: 'text', text })
            deltaText += text
          }
        }
      } else if (msg.type === 'tool_progress') {
        // A tool that runs for minutes reports its own clock; the panel ticks the
        // card with it, so a long Bash call is visibly alive instead of frozen.
        onEvent?.({
          type: 'tool_progress',
          tool_use_id: msg.tool_use_id,
          tool_name: msg.tool_name,
          elapsedSeconds: Number(msg.elapsed_time_seconds ?? 0),
        })
      } else if (msg.type === 'result') {
        sessionId = msg.session_id
        numTurns = Number(msg.num_turns ?? 0)
        durationMs = Number(msg.duration_ms ?? 0)
        let resultText = ''
        if (msg.subtype === 'success') {
          costUsd = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : 0
          const usage = msg.usage as any
          if (usage) {
            inputTokens = Number(usage.input_tokens ?? 0)
            outputTokens = Number(usage.output_tokens ?? 0)
          }
          if (msg.structured_output !== undefined) structuredOutput = msg.structured_output
          if (typeof msg.result === 'string') resultText = msg.result
          if (!output.trim() && typeof msg.result === 'string') output = msg.result
        } else {
          const raw = msg as any
          const detail = raw.result ?? raw.error ?? (Array.isArray(raw.errors) && raw.errors.length ? raw.errors.join('; ') : undefined)
          const text = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : ''
          failure = text ? `${msg.subtype}: ${text}` : msg.subtype
          resultText = failure
        }
        const cappedResult = capTailText(resultText)
        onEvent?.({
          type: 'result',
          text: cappedResult.text,
          costUsd,
          numTurns,
          durationMs,
          ...(cappedResult.omittedChars > 0
            ? { totalChars: cappedResult.totalChars, omittedChars: cappedResult.omittedChars }
            : {}),
          ...(msg.subtype === 'success' ? {} : { isError: true }),
        })
      }
    }
  } catch (err) {
    throw new Error(describeFailure(errorText(err)))
  } finally {
    abort.signal.removeEventListener('abort', killChildren)
    killChildren()
  }

  // An aborted query can end its stream without throwing. Treat that as a
  // failure so background jobs report killed/timed-out instead of completed.
  if (abort.signal.aborted) {
    const reason = typeof abort.signal.reason === 'string' && abort.signal.reason
      ? abort.signal.reason
      : 'aborted'
    throw new Error(`claude_code ${reason}`)
  }

  if (failure) throw new Error(describeFailure(failure))

  if (!output.trim() && structuredOutput !== undefined) {
    output = JSON.stringify(structuredOutput, null, 2)
  }
  if (!output.trim()) throw new Error('claude_code returned no output')

  return {
    output: output.trim(),
    sessionId,
    costUsd,
    inputTokens,
    outputTokens,
    toolsUsed: [...toolsUsed],
    durationMs,
    numTurns,
    structuredOutput,
  }
}

/**
 * Run one delegation under a resume plan.
 *
 * Everything here is about the seam around `runClaude`: a conversation this run
 * continued is written back so the NEXT run finds it (that write-back is the whole
 * feature — the CLI cannot remember across processes), and a remembered
 * conversation that no longer exists is retried once as a fresh one.
 */
async function runWithSession(
  req: RunRequest,
  abort: AbortController,
  sessions: SessionStore,
  plan: ResumePlan,
  onDelta?: (text: string) => void,
  onEvent?: (event: ClaudeEvent) => void,
): Promise<RunOutcome> {
  try {
    const outcome = await runClaude(req, abort, onDelta, onEvent)
    sessions.remember(plan.key, outcome.sessionId, req.cwd, {
      ...(plan.name === undefined ? {} : { name: plan.name }),
      task: req.task,
    })
    return outcome
  } catch (err) {
    if (plan.mode !== 'continued' || !RESUME_GONE.test(errorText(err))) throw err
    req.resume = undefined
    const outcome = await runClaude(req, abort, onDelta, onEvent)
    plan.mode = 'new'
    plan.note = '[fresh] 上次的会话已不存在（过期或被清理），这次自动新开了一个'
    sessions.remember(plan.key, outcome.sessionId, req.cwd, {
      ...(plan.name === undefined ? {} : { name: plan.name }),
      task: req.task,
    })
    return outcome
  }
}

/**
 * Append-only text buffer that drops the oldest content once it exceeds the cap.
 *
 * Two independent cursors live on top of it: `drain()` is the model's
 * `job_output` cursor (read-and-clear), while `read(fromOffset)` answers the
 * monitor panel from an ABSOLUTE offset, so any number of UI readers can follow
 * the same job without ever stealing the model's bytes. `absoluteBase` is the
 * absolute index of the first character still held.
 */
function createBuffer() {
  let text = ''
  let dropped = false
  let absoluteBase = 0
  return {
    append(chunk: string) {
      text += chunk
      if (text.length > MAX_LIVE_BUFFER) {
        const excess = text.length - MAX_LIVE_BUFFER
        text = text.slice(excess)
        absoluteBase += excess
        dropped = true
      }
    },
    /** Read and clear; the caller sees only what arrived since the previous read. */
    drain() {
      const chunk = dropped ? `…[earlier output truncated]…\n${text}` : text
      absoluteBase += text.length
      text = ''
      dropped = false
      return chunk
    },
    snapshot() {
      return dropped ? `…[earlier output truncated]…\n${text}` : text
    },
    /** Absolute-offset read used by the monitor panel; leaves the buffer intact. */
    read(fromOffset: number) {
      const end = absoluteBase + text.length
      const requested = Math.max(0, Math.min(fromOffset, end))
      const truncated = requested < absoluteBase
      const start = truncated ? absoluteBase : requested
      return { text: text.slice(start - absoluteBase), nextOffset: end, truncated }
    },
  }
}

interface JobOutcome {
  status: 'completed' | 'failed' | 'killed'
  detail?: string
  /** 0.1.x jobs seam read this field. */
  output?: string
  /** 0.2 jobs seam stores `outcome.result` (`settle()`) and hands it to the model on the first terminal read. */
  result?: string
}

/** Everything the tracker needs from inside the job's `run()` closure. */
interface JobHandles {
  read(fromOffset: number): { text: string, nextOffset: number, truncated: boolean }
  events: EventBuffer
  cancelFromUi(): boolean
  done: Promise<JobOutcome>
  settlement(): TrackedSettlement
}

function startBackgroundJob(
  jobs: any,
  req: RunRequest,
  ownerSessionId: string | undefined,
  tracker: JobTracker,
  sessions: SessionStore,
  plan: ResumePlan,
): string {
  const timeoutMs = req.timeoutMs
  const warnTimeoutMs = req.warnTimeoutMs
  const warnIntervalMs = req.warnIntervalMs
  const label = req.task.replace(/\s+/g, ' ').trim().slice(0, 60)
  // `run()` executes synchronously inside `jobs.start()`, so these handles are
  // set by the time the registry hands back the job id.
  let handles: JobHandles | undefined

  const jobId: string = jobs.start({
    kind: 'claude-code',
    label,
    // DSH 0.2 resolves this through `agents.get(owner)` and stores the live
    // Agent, so the spec takes the owning session's ID. Passing the Agent
    // object itself fails with `session "[object Object]" has no live agent
    // (background job owner must be live)`.
    owner: ownerSessionId,
    // DSH 0.2 streams only what the producer hands to `handle.append()` (or
    // lists as `spec.output` sources) into the ring behind the model's
    // `job_output`; the plugin's own buffers feed the monitor panel instead.
    run: (handle: { append?: (text: string, options?: unknown) => void }) => {
      const abort = new AbortController()
      const pending = createBuffer()
      const full = createBuffer()
      const events = createEventBuffer()
      let cancelled = false
      let cancelledFromUi = false
      let timedOut = false
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let settlement: TrackedSettlement = { status: 'failed' }
      // What actually reached the seam's ring: its `readBody()` concatenates the
      // streamed chunks with the settled `result`, so re-sending text the live
      // stream already delivered would duplicate it.
      let streamedIntoRing = ''

      const onDelta = (text: string) => {
        pending.append(text)
        full.append(text)
        if (handle?.append) {
          handle.append(text)
          // `[tool] …` markers are annotations only this plugin writes into the
          // text stream; `outcome.output` never contains them, so they must not
          // count towards the settled-result dedupe below.
          if (!text.startsWith('\n[tool] ')) streamedIntoRing += text
        }
      }

      const onEvent = (event: ClaudeEvent) => {
        events.append(event)
        // The CLI persists output it could not hand over inline and names the file
        // in the result. Registering that path here — from the run's own stream — is
        // what later lets THIS session's panel read the file back, and nothing else.
        if (event.type === 'tool_result' && event.outputPath !== undefined && ownerSessionId !== undefined) {
          tracker.allowOutputPath(ownerSessionId, event.outputPath)
        }
      }

      const cancel = (fromUi: boolean) => {
        if (settled || cancelled) return false
        cancelled = true
        cancelledFromUi = fromUi
        if (timer) clearTimeout(timer)
        abort.abort('cancelled')
        return true
      }

      const done: Promise<JobOutcome> = (async () => {
        try {
          const outcome = await runWithSession(req, abort, sessions, plan, onDelta, onEvent)
          // Resume needs the session handle, and a background job is read back
          // through the seam ring only — so it is appended here instead of being
          // left in the tracker for the panel alone.
          if (outcome.sessionId !== '' && handle?.append !== undefined) {
            handle.append(`\n[session] ${outcome.sessionId} — remembered for this task; pass it back as \`resume\` to pin it\n`)
          }
          // Whether this run continued a conversation, started one, or was forced
          // to start one — the caller reads it here, the same way it reads the id.
          if (plan.note !== '' && handle?.append !== undefined) handle.append(`\n${plan.note}\n`)
          const cost = typeof outcome.costUsd === 'number' ? `$${outcome.costUsd.toFixed(2)}` : '$0.00'
          const mins = Math.floor(outcome.durationMs / 60000)
          const secs = Math.floor((outcome.durationMs % 60000) / 1000)
          settlement = {
            status: 'completed',
            claudeSessionId: outcome.sessionId,
            costUsd: outcome.costUsd,
            numTurns: outcome.numTurns,
            durationMs: outcome.durationMs,
            finalOutput: outcome.output,
          }
          return {
            status: 'completed' as const,
            detail: `${cost} · ${outcome.numTurns} turns · ${mins}m${secs}s`,
            // `output` is the 0.1.x field name; 0.2's `settle()` stores
            // `outcome.result` and hands it to the model on the terminal read —
            // but only for text the live stream did not already deliver.
            output: outcome.output,
            ...(outcome.output !== undefined && !streamedIntoRing.includes(outcome.output)
              ? { result: outcome.output }
              : {}),
          }
        } catch (err) {
          if (cancelled) {
            // UI cancellation goes through this same path on purpose: the job
            // settles normally, so the model still receives its notification.
            const detail = cancelledFromUi ? 'cancelled by user (UI)' : 'cancelled'
            settlement = { status: 'killed', failureDetail: detail, finalOutput: full.snapshot() }
            return { status: 'killed' as const, detail }
          }
          const detail = timedOut ? `timed out after ${timeoutMs}ms` : errorText(err)
          const partial = full.snapshot()
          settlement = { status: 'failed', failureDetail: detail, finalOutput: partial }
          return {
            status: 'failed' as const,
            detail,
            output: partial,
            ...(!streamedIntoRing.includes(partial) ? { result: partial } : {}),
          }
        } finally {
          settled = true
          if (timer) clearTimeout(timer)
          // The key stops being busy only once the run is really over.
          sessions.end(plan.key)
        }
      })()

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true
          abort.abort('timed out')
        }, timeoutMs)
        timer.unref?.()
      }

      // Two-stage timeout: warn first (warnTimeoutMs), then keep reminding
      // every warnIntervalMs while the task still runs. Warnings go into the
      // structured event stream (the panel renders them prominently) and do
      // NOT abort the task — only the hard timeoutMs does.
      const startedAt = Date.now()
      if (warnTimeoutMs > 0 && (timeoutMs <= 0 || warnTimeoutMs < timeoutMs)) {
        const warnTimer = setTimeout(function tick() {
          const mins = Math.floor((Date.now() - startedAt) / 60000)
          const hard = timeoutMs > 0
            ? ` · 将于 ${Math.floor(timeoutMs / 60000)}m 后强制中止`
            : ''
          events.append({ type: 'warning', text: `⚠️ 任务已运行 ${mins}m${hard}` })
          if (!settled && warnIntervalMs > 0) {
            const next = setTimeout(tick, warnIntervalMs)
            next.unref?.()
          }
        }, warnTimeoutMs)
        warnTimer.unref?.()
      }

      handles = {
        read: (fromOffset: number) => full.read(fromOffset),
        events,
        cancelFromUi: () => cancel(true),
        done,
        settlement: () => settlement,
      }

      return {
        cancel: () => { cancel(false) },
        done,
        readOutput: () => pending.drain(),
      }
    },
  })

  if (handles) {
    const resolved = handles
    tracker.register({
      jobId,
      ...(ownerSessionId !== undefined ? { ownerSessionId } : {}),
      task: req.task,
      label,
      ...(req.model !== undefined ? { model: req.model } : {}),
      // Known up front for a continued run, so the panel folds it into that
      // conversation's tab while it runs; `settle` refines it to what ran.
      ...(req.resume !== undefined ? { claudeSessionId: req.resume } : {}),
      read: resolved.read,
      events: resolved.events,
      cancelFromUi: resolved.cancelFromUi,
    })
    resolved.done.then(
      () => tracker.settle(jobId, resolved.settlement()),
      (err: unknown) => tracker.settle(jobId, { status: 'failed', failureDetail: errorText(err) }),
    )
  }

  return jobId
}

export function apply(ctx: Context, config: Config) {
  ctx.skills.register(DELEGATION_SKILL)
  ctx.skills.register(PARALLEL_DEV_SKILL)

  // Plugin-owned mirror of this session's delegations, plus the RPC surface the
  // monitor panel (client half) reads it through. Both are process-local and go
  // away with the plugin's fiber.
  const tracker = new JobTracker()
  // Which Claude Code conversation each task is on. Process-local tracker, but
  // this mapping is on disk on purpose: continuity must survive a DSH restart.
  const sessions = new SessionStore()
  new ClaudeCodeRemote(ctx, tracker, sessions)


  ctx.tools.register(defineTool({
    name: 'claude_code',
    description:
      "Delegate one self-contained coding task to your local Claude Code (running on your Claude subscription) " +
      "and return its final result text. Use it for a well-scoped subtask that benefits from Claude Code's own " +
      "agent loop and tools; give it everything it needs (goal, files, constraints) in the task string. " +
      "Send one task per call. For a follow-up on the same task (next step, adjust the requirement, fix what it " +
      "just wrote, question its own conclusion) pass no resume and no fresh: consecutive delegations from the same " +
      "session in the same directory continue one Claude Code conversation, so it already remembers the previous " +
      "work. Pass fresh: true only when switching topic or when you want a clean second opinion, and " +
      "ALWAYS pass conversation: <name> to state which workstream the task belongs to — one name per workstream, " +
      "reused on every call of it, because one directory usually holds several (a deck and a weekly report). " +
      "A call without it does NOT join anything: it starts a new conversation and its result lists the " +
      "workstreams already registered for that directory, so the next call can reuse one of those exact names. " +
      "Override the Claude model (model) and thinking effort (effort: low/medium/high/xhigh/max) per call. " +
      "For long tasks pass run_in_background: true — the call returns a jobId immediately and you stream its live " +
      "output with job_output, cancel with job_kill, and get a notification when it finishes. " +
      "This is a slow, expensive call; prefer it only when the work is genuinely self-contained.",
    parameters: {
      task: {
        type: 'string',
        description: 'Complete, self-contained task description for Claude Code (goal, context, files, constraints).',
        required: true,
      },
      cwd: { type: 'string', description: "Working directory for Claude Code; defaults to the calling session's working directory (configured cwd takes precedence)." },
      model: { type: 'string', description: 'Override the Claude model alias/id for this call. Default follows the current main model (fable→opus, opus→sonnet, sonnet→sonnet), else the configured fallback.' },
      permissionMode: {
        type: 'string',
        enum: [...PERMISSION_MODES],
        description: "Override Claude Code permission mode for this call (acceptEdits is the default; auto lets a classifier approve or deny prompts). WARNING: delegated sessions are headless, so dontAsk silently DENIES every confirmation prompt — the task will fail unless paired with an allowedTools whitelist; prefer acceptEdits.",
      },
      maxTurns: { type: 'integer', description: 'Override the maximum number of Claude Code agentic turns for this call.' },
      allowedTools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override the Claude Code built-in tools to allow (e.g. Read, Edit, Bash, Grep, Glob).',
      },
      resume: {
        type: 'string',
        description: 'Force a specific Claude Code session id. Rarely needed: the same task in the same directory continues its previous conversation automatically. Omit to accept that automatic choice.',
      },
      fresh: {
        type: 'boolean',
        description: 'Start a brand-new Claude Code conversation even though this task remembers one. Use it when switching topic, or when the carried-over history would only cost tokens.',
      },
      conversation: {
        type: 'string',
        description: 'Which workstream this task belongs to (e.g. "周报", "ppt", "api-refactor"). The same name in the same directory continues one Claude Code conversation; the first call registers the name together with this task as its description. Omit it only when you deliberately want a fresh conversation — an unnamed call never joins an existing line and returns the registry of names already used in that directory.',
      },
      effort: {
        type: 'string',
        enum: [...EFFORT_LEVELS],
        description: "Override Claude Code thinking effort for this call (default follows the calling session's effort tier, else 'high').",
      },
      maxThinkingTokens: {
        type: 'integer',
        description: 'Override the thinking token budget for this call (legacy; thinkingMode takes precedence).',
      },
      thinkingMode: {
        type: 'string',
        enum: [...THINKING_MODES],
        description: "Thinking mode for this call: adaptive (Claude decides how much to think) or disabled (no extended thinking).",
      },
      maxBudgetUsd: {
        type: 'number',
        description: 'Hard USD cost ceiling for this call; Claude Code stops once it is reached.',
      },
      appendSystemPrompt: {
        type: 'string',
        description: "Extra instructions appended to Claude Code's default system prompt for this call (conventions, prohibitions).",
      },
      outputSchema: {
        type: 'json',
        description: 'JSON Schema object; when given, Claude Code produces a structured result matching it, returned as structuredOutput.',
      },
      proxy: {
        type: 'string',
        description: 'HTTP proxy for this call (e.g. http://127.0.0.1:7897); overrides the plugin proxy config. Sets HTTPS_PROXY/HTTP_PROXY for the spawned claude.',
      },
      shellChannelOnly: {
        type: 'boolean',
        description: 'Deny the built-in Bash tool for this call so every command goes through the live shell channel (mcp__dsh__shell): 100% live output, but each command is a fresh process and cannot keep shell state (cd/export).',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run the delegation as a DSH background job and return a jobId immediately; read live output with job_output, cancel with job_kill.',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Hard timeout in ms for this call (background tasks are aborted once reached); overrides the plugin config.',
      },
      warnTimeoutMs: {
        type: 'integer',
        description: 'Emit a warning event (no abort) after the task has run this long (ms); overrides the plugin config; 0 disables.',
      },
      warnIntervalMs: {
        type: 'integer',
        description: 'Repeat the warning every N ms while the task keeps running past warnTimeoutMs; overrides the plugin config; 0 disables repeats.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: 'True when the foreground delegation completed successfully.' },
          output: { type: 'string', description: 'Final result text from Claude Code.' },
          sessionId: { type: 'string', description: 'Claude Code session id; pass it back as resume to pin this conversation.' },
          resumeNote: { type: 'string', description: 'Which conversation this run continued or started, when that is not obvious.' },
          costUsd: { type: 'number', description: 'Estimated cost of this delegation in USD.' },
          inputTokens: { type: 'integer', description: 'Input tokens used by the main agent loop.' },
          outputTokens: { type: 'integer', description: 'Output tokens used by the main agent loop.' },
          toolsUsed: { type: 'array', items: { type: 'string' }, description: 'Claude Code tools invoked during the run.' },
          durationMs: { type: 'integer', description: 'Wall-clock duration of the run in milliseconds.' },
          numTurns: { type: 'integer', description: 'Number of agentic turns Claude Code took.' },
          structuredOutput: { type: 'json', description: 'Structured result when outputSchema was supplied.' },
          kind: { type: 'string', enum: ['background'], description: 'Present only for background delegations.' },
          jobId: { type: 'string', description: 'Background job id; use it with job_output / job_kill.' },
        },
      },
      render: (_args: any, value: any) => {
        if (value.kind === 'background') {
          return [{
            type: 'text',
            text: `started background job ${value.jobId} — use job_output to stream output, job_kill to cancel; you will be notified when it finishes.`,
          }]
        }
        const stats = [
          `turns: ${value.numTurns ?? 0}`,
          `cost: $${Number(value.costUsd ?? 0).toFixed(4)}`,
          `tokens: ${value.inputTokens ?? 0} in / ${value.outputTokens ?? 0} out`,
        ].join(', ')
        let text = value.output ?? ''
        if (value.structuredOutput !== undefined) {
          text += `\n\nstructured output:\n${JSON.stringify(value.structuredOutput, null, 2)}`
        }
        const note = typeof value.resumeNote === 'string' && value.resumeNote !== '' ? `\n${value.resumeNote}` : ''
        return [{ type: 'text', text: `${text}\n\n(${stats})${sessionLine(value.sessionId)}${note}` }]
      },
    },
    timeoutMs: config.timeoutMs,
    async execute(args: any, exec) {
      const main = currentMainSelection(ctx, exec.agent)
      const req: RunRequest = {
        task: args.task,
        cwd: args.cwd ?? config.cwd ?? sessionCwd(exec.agent) ?? process.cwd(),
        // Explicit argument > follow-main-session default > configured fallback.
        model: args.model
          ?? (config.followMainModel !== false ? delegateModelFor(main.model) : undefined)
          ?? config.model,
        permissionMode: args.permissionMode ?? config.permissionMode,
        maxTurns: args.maxTurns ?? config.maxTurns,
        timeoutMs: args.timeoutMs ?? config.timeoutMs,
        warnTimeoutMs: args.warnTimeoutMs ?? config.warnTimeoutMs,
        warnIntervalMs: args.warnIntervalMs ?? config.warnIntervalMs,
        allowedTools: args.allowedTools ?? config.allowedTools,
        pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable,
        resume: args.resume,
        effort: args.effort
          ?? (config.followMainEffort !== false ? delegateEffortFor(main.reasoningEffort) : undefined)
          ?? config.effort,
        maxThinkingTokens: args.maxThinkingTokens ?? config.maxThinkingTokens,
        thinkingMode: args.thinkingMode ?? config.thinkingMode,
        maxBudgetUsd: args.maxBudgetUsd ?? config.maxBudgetUsd,
        appendSystemPrompt: args.appendSystemPrompt ?? config.appendSystemPrompt,
        outputSchema: args.outputSchema,
        proxy: args.proxy ?? config.proxy,
        agents: toAgentDefinitions(config.subagents),
        allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions === true,
        shellChannel: config.shellChannel !== false,
        shellChannelOnly: args.shellChannelOnly ?? config.shellChannelOnly === true,
        shellPath: config.shellPath,
        shellTimeoutMs: config.shellTimeoutMs,
        autoBackgroundTimeoutMs: config.autoBackgroundTimeoutMs,
        bashOutputMaxChars: config.bashOutputMaxChars,
      }

      preflight(req)

      // Session continuity, keyed by the workstream the caller declares: the same
      // `conversation: <name>` in the same directory continues the conversation that
      // line used, and the register in session-store.ts keeps name, description and
      // session id on disk. An explicit `resume` always wins, `fresh: true` opts out,
      // and an UNNAMED call starts a new conversation (returning the register for its
      // directory) instead of silently joining a line it cannot identify.
      const owner = sessionOwnerId(exec.agent)
      const plan = sessions.plan({
        cwd: req.cwd,
        ...(owner !== undefined ? { owner } : {}),
        ...(args.resume !== undefined ? { explicit: args.resume } : {}),
        ...(args.fresh === true ? { fresh: true } : {}),
        ...(args.conversation !== undefined ? { conversation: args.conversation } : {}),
        continueUnnamed: config.continueUnnamed === true,
      })
      if (plan.resume !== undefined) req.resume = plan.resume

      if (args.run_in_background) {
        const jobs = ctx.get('jobs')
        if (!jobs) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-tool-jobs')
        // Marked busy before the job starts: a second delegation for the same task
        // must not open the same conversation while this one is still writing it.
        sessions.begin(plan.key)
        try {
          const jobId = startBackgroundJob(jobs, req, owner, tracker, sessions, plan)
          return { kind: 'background' as const, jobId }
        } catch (err) {
          sessions.end(plan.key)
          throw err
        }
      }

      const abort = new AbortController()
      const onAbort = () => abort.abort()
      exec.signal.addEventListener('abort', onAbort, { once: true })
      // Foreground delegations get a panel row too. They have no harness job id, so
      // they carry a plugin-local one and settle the moment the call returns —
      // otherwise the panel would list only `run_in_background` runs and every
      // ordinary delegation would leave no trace at all.
      const jobId = `foreground-${++foregroundJobSeq}`
      const events = createEventBuffer()
      const full = createBuffer()
      const onDelta = (text: string) => {
        full.append(text)
      }
      const onEvent = (event: ClaudeEvent) => {
        events.append(event)
        // Same rule as the background path: only a path this run's own stream named
        // becomes readable by this session's panel.
        if (event.type === 'tool_result' && event.outputPath !== undefined && owner !== undefined) {
          tracker.allowOutputPath(owner, event.outputPath)
        }
      }
      tracker.register({
        jobId,
        ...(owner !== undefined ? { ownerSessionId: owner } : {}),
        task: req.task,
        label: req.task.replace(/\s+/g, ' ').trim().slice(0, 60),
        ...(req.model !== undefined ? { model: req.model } : {}),
        // Same rule as the background path: a continued run joins the tab of
        // the conversation it resumes, from its first frame on.
        ...(req.resume !== undefined ? { claudeSessionId: req.resume } : {}),
        read: (fromOffset: number) => full.read(fromOffset),
        events,
        cancelFromUi: () => {
          if (abort.signal.aborted) return false
          abort.abort('cancelled')
          return true
        },
      })
      try {
        sessions.begin(plan.key)
        const outcome = await runWithSession(req, abort, sessions, plan, onDelta, onEvent)
        tracker.settle(jobId, {
          status: 'completed',
          claudeSessionId: outcome.sessionId,
          costUsd: outcome.costUsd,
          numTurns: outcome.numTurns,
          durationMs: outcome.durationMs,
          finalOutput: outcome.output,
        })
        return {
          ok: true,
          output: outcome.output,
          sessionId: outcome.sessionId,
          costUsd: outcome.costUsd,
          inputTokens: outcome.inputTokens,
          outputTokens: outcome.outputTokens,
          toolsUsed: outcome.toolsUsed,
          durationMs: outcome.durationMs,
          numTurns: outcome.numTurns,
          ...(outcome.structuredOutput !== undefined ? { structuredOutput: outcome.structuredOutput as any } : {}),
          ...(plan.note !== '' ? { resumeNote: plan.note } : {}),
        }
      } catch (err) {
        const aborted = abort.signal.aborted
        tracker.settle(jobId, {
          status: aborted ? 'killed' : 'failed',
          failureDetail: aborted ? 'cancelled' : errorText(err),
          finalOutput: full.snapshot(),
        })
        throw err
      } finally {
        sessions.end(plan.key)
        exec.signal.removeEventListener('abort', onAbort)
      }
    },
    presentCall: (args: any) => ({
      card: 'generic',
      title: args.run_in_background ? 'Claude Code (background)' : 'Claude Code',
      kind: 'other',
      rawInput: { task: typeof args.task === 'string' ? args.task.slice(0, 200) : args.task },
    }),
  }))
}
