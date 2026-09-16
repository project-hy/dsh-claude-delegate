# DSH「任务管理」与「何时委派子 agent」规则提取报告

> 研究方法：直接读取本机 DSH Desktop 已安装的编译产物。
> 源码根：`C:\Program Files\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\`
> 说明：包名实际为 `@deepseek-ai/dsh-*`（不是提示中写的平铺 `dsh-*`）。编译后的 `lib/index.js` 可读，提示词原文以**字符串常量**形式存在。
> **诚实标注约定**：凡本机产物中确实不存在的规则，一律写「未见」，不做推测性补全。

---

## 0. 一个重要的结构性发现（先看这条，它决定了后面所有结论）

DSH 的 agent 提示词由三部分拼装，**「何时委派」的规则不在某一个「agent 指令文件」里，而是分散在：**

| 来源 | 机制 | 本机位置 |
|---|---|---|
| **① 工具 description** | 每个工具自带一段 description 字符串，写在 schema 里给模型看 | 各 `dsh-tool-*/lib/index.js` 的 `defineTool({ description })` |
| **② 提示词段（prompt section）** | 插件通过 `ctx.systemPrompt.section({ name, order, text })` 注册**独立于工具 schema 的**跨调用指导 | 例如 `dsh-tool-jobs` 注册 `tool:jobs`（order 106） |
| **③ 部署层 persona / 工作区指令** | `dsh-persona` 提供 persona 文本；`dsh-agent-instructions` 提供 AGENTS.md 型工作区指令 | `.dsh/.agent-presets/dev/agent.cordis.yml`、`dsh-agent-instructions` |

**关键点**：`dsh-agent-instructions` **并不包含委派规则**。它的全部产出是「工作区指令（AGENTS.md 类）」的装载与生效语义，原文只有 5 条字符串常量，例如：

- `dsh-agent-instructions\lib\index.js:112`
  > "The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions."
  > 译：以下工作区指令可能与你的工作相关。适用时作为指导使用。更具体的指令优先于更宽泛的指令。它们不覆盖 system、developer 或直接用户指令。
- `dsh-agent-instructions\lib\index.js:113`（**完整基线替换**语义）
  > "This complete workspace instruction baseline replaces all earlier workspace instruction baselines..."
  > 译：本完整工作区指令基线替换此前所有工作区指令基线。
- `dsh-agent-instructions\lib\index.js:218`（**热更新**语义）
  > "This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file."
  > 译：该文件在加载后发生了变更。请使用以下内容替代此前从该文件加载的指令。
- `dsh-agent-instructions\lib\index.js:114`
  > "This complete workspace instruction baseline replaces all earlier workspace instruction baselines. No workspace instructions are currently active."

**「何时委派」的原文，实际全部在 `dsh-tool-subagent`（工具 description + prompt 段）与 `dsh-tool-jobs` / `dsh-tool-workflow` / `dsh-tool-ralph`（工具 description + 提示词段）里。**

---

## 1. 「何时委派」的原始规则（英文原文 + 中文翻译）

### 1.1 源头：`subagent` 工具的 description（自包含委派）

出处：`@deepseek-ai\dsh-tool-subagent\lib\index.js:118`（`providerWording(false)` 返回值）

> **原文**：Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context. The subagent returns its result, not its intermediate steps. Give it a complete, standalone prompt: it does not see this conversation.
>
> **译**：把**自包含**任务委派给子 agent（在自己上下文中工作的独立 agent），用来卸载**聚焦、独立**的工作——调研、范围内的实现、分析——以免消耗本对话的上下文。子 agent 返回**它的结果，而不是中间步骤**。给它一个完整、独立的提示词：它**看不到本对话**。

**三个「该委派」的信号**：①任务自包含；②任务聚焦且独立；③**为了不污染主对话上下文**。
**两个硬约束**：子 agent 只回结果不回过程；提示词必须完整独立（因为它看不到对话）。

### 1.2 源头：`subagent_fork` 工具的 description（继承上下文委派）

出处：`@deepseek-ai\dsh-tool-subagent\lib\index.js:114`（`providerWording(true)` 返回值）

> **原文**：Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn). Use this when the subtask builds on this conversation's context — a follow-up analysis, a review, a continuation — without consuming this conversation's context for the work itself. You receive its result, not its intermediate steps.
>
> **译**：把任务委派给**继承本对话**的子 agent：用至今所有**已完成轮次**作为种子（它看不到当前进行中的那一轮）。当子任务**建立在本对话上下文之上**时使用——后续分析、评审、延续——从而不为工作本身消耗本对话上下文。你收到的是它的结果，而不是中间步骤。

**判据**：子任务**依赖对话上下文** → 用 `subagent_fork`；**不依赖** → 用 `subagent`。二者共同的收益都是「不消耗主对话上下文」。

### 1.3 源头：`subagent` 的 `prompt` 参数描述（委派时怎么写任务描述）

出处：`@deepseek-ai\dsh-tool-subagent\lib\index.js:119`

> **原文**：The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs.
>
> **译**：给子 agent 的**完整、自包含**任务。它不共享本对话上下文，所以**把它需要的一切都写进去**。

出处：`@deepseek-ai\dsh-tool-subagent\lib\index.js:115`（fork 版）

> **原文**：The task for the subagent. It already sees this conversation's completed turns, so build on them freely and state only what is new.
>
> **译**：给子 agent 的任务。它已经能看到本对话已完成轮次，所以可以自由地在其之上构建，**只陈述新增内容**。

出处：`@deepseek-ai\dsh-tool-subagent\lib\index.js:148`（`description` 参数）

> **原文**：A short (3-5 word) description of the delegated task, for display.
>
> **译**：被委派任务的简短描述（3–5 个词），**用于展示**。

出处：`@deepseek-ai\dsh-tool-subagent\lib\index.js:157`（`run_in_background` 参数）

> **原文**：Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.
>
> **译**：是否在后台运行并立即返回一个**持久**子 agent id。默认 true。当你的**下一步动作依赖该结果**时才设为 false 以等待结果。

### 1.4 源头：`subagent` 的提示词段（后台优先 + 并行批量启动）

出处：`@deepseek-ai\dsh-tool-subagent\lib\index.js:289-293`，注册为 section `tool:${toolName}`，**仅当 `backgroundEnabled && continuable` 时注册**（本机 dev/standard preset 均为 `backgroundMode: continuable`，故生效）。

> **原文**：Use `${toolName}` in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set `run_in_background: false` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.
>
> **译**：**默认在后台**使用 `${toolName}`。**在一条 assistant 消息里同时启动多个相互独立的委派**，并在它们运行期间继续做有用的工作。只有当你的**下一步动作依赖**该子 agent 结果时，才设 `run_in_background: false`。当后台运行结束时，运行时**会给你发一条通知**，包含其结果与最终 assistant 消息。

这是一条最接近「何时该委派 + 怎么并行」的通用规则文本。

### 1.5 源头：`subagent` description 的后台附加句（委派后如何得知结果）

出处：`@deepseek-ai\dsh-tool-subagent\lib\index.js:143`（continuable 分支拼接）

> **原文**：This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; `send_message` starts a later turn in the same child conversation. Set `run_in_background: false` only when your next action depends on receiving the result.
>
> **译**：该工具默认在后台运行，立即返回持久子 agent id，并保持子对话可用于后续轮次。运行结束时，运行时给父 agent 发一条通知，包含结果与该子 agent 的最终 assistant 消息；`send_message` 在同一个子对话里开启后续轮次。只有当你的下一步动作**依赖收到该结果**时，才设 `run_in_background: false`。

### 1.6 源头：子 agent 侧收到的注入（委派方与子方的边界）

出处：`@deepseek-ai\dsh-subagent\lib\index.js:547`

> **原文**：You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.
>
> **译**：你是一个被委派的子 agent：你的权限范围在启动时已固定，无法从本会话内部扩大——需要审批的操作会被自动拒绝。当任务需要超出该范围的访问时，**不要重试被拒绝的操作**；在回复中说明该限制，让委派方去处理。

### 1.7 源头：后台运行的结算通知文案（委派后如何向用户/父 agent 汇报）

出处：`@deepseek-ai\dsh-subagent\lib\index.js:684-697`，函数 `settlementSummary(childId, stopReason)`

> **原文 / 译**：
> - `"Background subagent ${childId} finished and will do no further work unless you send it more."`
>   后台子 agent `<id>` 已完成，除非你再给它发消息，否则它不会再做任何事。
> - `"... was stopped before it finished."` — 在完成前被停止。
> - `"... ran out of room before it finished."` — 在完成前用尽了空间（max-tokens）。
> - `"... declined the task."` — 拒绝了该任务（refusal）。
> - `"... failed before it finished."` — 在完成前失败。
> - `"... ended abnormally (${stopReason}) before it finished."` — 异常结束。

另有 `@deepseek-ai\dsh-subagent\lib\index.js:951`：`"Background subagent ${activation.childId} reported:"`（后台子 agent 主动汇报）。

### 1.8 源头：`report` 工具（子 agent 向上汇报的强制约定）

出处：`@deepseek-ai\dsh-tool-subagent-report\lib\index.js:39`

> **原文**：Report selected content to the agent that started you. Call this once before you finish, with a self-contained final result, and earlier for progress or findings that change what that agent does next. That agent shares your workspace but does not automatically receive your transcript, tool output, or reasoning, so finishing your work is not itself a result. Reporting does not end your turn or finish your work, and only your direct parent receives it. A failed call may still have arrived, so do not blindly repeat it.
>
> **译**：向启动你的 agent 汇报所选内容。**完成前调用一次**，给出自包含的最终结果；当**部分发现会改变该 agent 下一步动作**时，也应当**更早**汇报。该 agent 共享你的工作区，但**不会自动收到你的对话记录、工具输出或推理**，所以「工作做完」本身并不构成一个结果。汇报不会结束你的轮次、也不会完成你的工作，且只有你的直接父 agent 会收到。失败的调用可能已经送达，所以不要盲目重复。

配套的提示词段（`dsh-tool-subagent-report\lib\index.js:33`）：
> "Deliver your result with the report tool before you finish: call it once with a self-contained answer. The agent that started you shares your workspace but does not automatically receive your transcript, tool output, or reasoning, so a closing remark such as "done" leaves it nothing it can use."
> 译：完成前用 report 工具交付结果：用自包含答案调用一次。启动你的 agent 共享工作区，但不会自动收到你的对话记录、工具输出或推理，所以一句「done」这样的收尾对它是没有任何可用信息的。

### 1.9 源头：`job_output` 相关规则（不该 busy-poll）

出处：`@deepseek-ai\dsh-tool-jobs\lib\index.js:201-205`，注册为 section `tool:jobs`，order 106

> **原文**：Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job's work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.
>
> **译**：记录你启动的每一个后台 job id。job 完成时你会**在会话内收到通知**——**不要 busy-poll，也不要 sleep 等它**；继续做独立的步骤，且**不要重复一个正在运行的 job 的工作**。给出最终答复前，用 `job_output` 收齐每一个仍然相关的 job（**只有当你确实被它阻塞**时才设 `wait: true`），并 `job_kill` 掉那些已经不再重要的 job。

`job_output` 工具 description（`dsh-tool-jobs\lib\index.js:230`）：
> **原文**：Read a background job. Stream jobs return only output since the previous read; final-output jobs return their result after settlement. Every response ends with `[status: ...]`. Reads are non-blocking unless `wait: true`, which waits up to the configured cap.
>
> **译**：读取一个后台 job。流式 job 只返回自上次读取以来的输出；final-output job 在结算后返回其结果。每个响应都以 `[status: ...]` 结尾。除非 `wait: true`，读取是非阻塞的；`wait: true` 最多等待到配置上限。

`wait` 参数（`dsh-tool-jobs\lib\index.js:239`）：
> "Block until the job reaches a terminal status or the timeout expires. A timed-out wait returns [status: running] and leaves the job alive."
> 译：阻塞直到 job 到达终态或超时。超时的等待返回 `[status: running]`，且 job 仍存活。

### 1.10 源头：`job_kill` / `send_message` / `interrupt_agent`（委派后的控制）

`dsh-tool-jobs\lib\index.js:306`（job_kill）：
> "Request cancellation of a running background job by job id. Returns immediately; the job settles as killed once its work actually stops."
> 译：按 job id 请求取消正在运行的后台 job。立即返回；当工作真正停止后，job 结算为 killed。

`dsh-tool-subagent-control\lib\index.js:23`（send_message）：
> "Send a message to a background subagent by its subagent id, continuing the same conversation. It becomes the subagent's next turn: if it is still working, the message waits until its current turn finishes, so it cannot redirect work already underway. This call returns no answer from the subagent — only confirmation that the message was delivered — so use it to give it more work. A failure means the message was NOT delivered."
> 译：按子 agent id 给后台子 agent 发消息，延续同一对话。它会成为该子 agent 的下一轮：如果它还在工作，该消息会等到当前轮结束，因此**它无法改变已经在进行中的工作**。该调用**不返回子 agent 的回答**——只确认消息已送达——所以用它**派发更多工作**。失败意味着消息**没有**送达。

`dsh-tool-subagent-control\lib\index.js:69`（interrupt_agent）：
> "Request cancellation of a background agent's current turn by its agent id. The target may be your direct child or a deeper agent created under you. Only the current turn stops: messages already queued for the agent stay parked until a later send_message, agents it started keep running, and the agent itself stays available for follow-ups. This call returns as soon as the stop request is accepted, so the target may keep running briefly; interrupting an agent that already finished is an accepted no-op."
> 译：按 agent id 请求取消后台 agent 的当前轮次。目标可以是你的直接子 agent，也可以是你之下更深的 agent。**只有当前轮停止**：已排队给该 agent 的消息会停驻直到后续 `send_message`，它启动的 agent 继续运行，该 agent 本身仍可用于后续跟进。停止请求被接受即返回，因此目标可能短暂继续运行；中断一个已完成的 agent 是被接受的无操作。

### 1.11 源头：`workflow` —— 大规模扇出时才用

出处：`@deepseek-ai\dsh-tool-workflow\lib\index.js:94`（工具 description）

> **原文**（节选关键判据句）：Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification of findings — where you write the orchestration as a script instead of delegating turn by turn.
>
> **译**：运行一个 JavaScript workflow 脚本来**规模化编排**子 agent。用于**扇出到许多独立片段**的工作——多文件审计、迁移、多角度调研、对发现的对抗性验证——此时你把编排**写成脚本**，而不是一轮一轮地委派。

出处：`@deepseek-ai\dsh-tool-workflow\lib\index.js:141`（提示词段）

> **原文**：Use the `${toolName}` tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.
>
> **译**：**仅当**用户明确要求 workflow 或大规模多 agent 编排时才用该工具：你写一个 JavaScript 脚本（工具描述给出了确切格式），把工作扇出到许多子 agent，带 phase 与结构化结果。**只有一两次委派时，优先用普通的 subagent 调用。**

其它要点（同段 description）：
- `pipeline(items, ...stages)` — 每个 item 独立走各 stage，**阶段之间没有 barrier**；"prefer this for multi-stage work"（多阶段工作优先用这个）。
- `parallel(thunks)` — 并发运行并等待全部完成，**是一个 barrier**；"use only when a stage genuinely needs every prior result together"（仅当某阶段确实需要所有前序结果都到齐时才用）。
- `phase(title)` 开始一个进度阶段；`log(message)` **叙述进度**。
- 误用 hook（坏参数、未知选项、不支持的 schema、超限）**总是抛错杀死脚本**，不会退化成 per-item 的 `null`。
- 约束：并发与 agent 总数有上限；**脚本本身没有文件系统、网络、定时器或 Node API**——agent 干活，脚本只做编排。该运行是**前台**的：调用在整个脚本跑完才返回。

### 1.12 源头：`ralph` —— 仅当人明确要求时才用

出处：`@deepseek-ai\dsh-tool-ralph\lib\index.js:124`（description）

> **原文**：Run a foreground fresh-agent Ralph loop toward one immutable objective. Use only when the direct human explicitly asks for Ralph or fresh-agent iteration. Each round opens a new child with no parent conversation or prior child session; the shared workspace is long-term memory, and only a bounded structured report crosses rounds. The call returns when a worker reports completion or a concrete blocker, or at the round limit. Ordinary long-running same-session work belongs to goal tools.
>
> **译**：朝一个**不可变目标**运行前台 fresh-agent Ralph 循环。**仅当直接人类明确要求** Ralph 或 fresh-agent 迭代时使用。每一轮开一个新的子 agent，**没有父对话也没有此前的子会话**；**共享工作区即长期记忆**，轮次间只传递**有界的结构化报告**。当 worker 报告完成、报告一个具体阻塞、或到达轮次上限时返回。**普通的同会话长任务属于 goal 工具。**

出处：`@deepseek-ai\dsh-tool-ralph\lib\index.js:298`（提示词段）

> **原文**：Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution. Each Ralph round starts a fresh child with no conversation seed and uses the shared workspace as durable memory. Completion and blockers are worker reports, not independent evaluation. Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.
>
> **译**：**仅当**直接人类明确要求 Ralph 循环或 fresh-agent 迭代执行时才用 ralph 工具。每轮启动一个无对话种子的新子 agent，用共享工作区作为持久记忆。**完成与阻塞都是 worker 的报告，不是独立评估。** 普通的长期目标用同会话 goal 工具；**有界的委派与扇出用普通 subagent 或 workflow。**

Ralph 每轮报告 schema（`dsh-tool-ralph\lib\index.js:36` 起的 workflow 脚本体，可作为「子 agent 回报结构」的模板）：

```js
const reportSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['continue', 'complete', 'blocked'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
    blocker: { type: 'string' },
  },
  required: ['status', 'summary', 'evidence', 'nextSteps', 'blocker'],
  additionalProperties: false,
}
```
校验规则（同处）：
- `continue` → 必须有非空 `nextSteps` 且 `blocker` 为空；
- `complete` → 必须有 `evidence`、`nextSteps` 为空、`blocker` 为空；
- `blocked` → 必须有非空 `blocker`；
- 序列化后不得超过 `maxHandoffChars`。

每轮注入给 worker 的提示词原文（同处）：
> - "You are one fresh worker in a foreground Ralph loop. You receive no parent conversation and no prior child session. Do not call the ralph tool: this round already is its worker."
>   你是一个前台 Ralph 循环中的 fresh worker。你没有父对话，也没有此前的子会话。不要调用 ralph 工具：本轮已经就是它的 worker。
> - "Immutable objective:" / "Ralph round: N of M."
> - "The shared workspace and its current working tree are the long-term memory and source of truth. Inspect them before acting, preserve existing work, perform concrete in-scope work, and verify what you change. Treat the previous report only as a bounded handoff; confirm it against the workspace."
>   共享工作区及其当前工作树是长期记忆与事实来源。行动前先检查，保留已有工作，做具体范围内的工作，并验证你的改动。把上一份报告只当作有界的交接；**对照工作区核实它**。
> - "Return one report with exact normalized strings. Use status continue with at least one nextSteps entry while useful work remains; complete only with concrete evidence and no nextSteps; blocked only when no meaningful progress is possible without human input or an external-state change. blocker must be empty unless blocked."

### 1.13 「什么情况**不该**委派」—— 原文依据

DSH **没有**一条形如 "do not delegate when…" 的集中规则（**未见**）。可从原文反推出三条硬边界：

1. **不该为了一两次委派就用重型编排**（`dsh-tool-workflow\lib\index.js:141`）：
   > "For one or two delegations, prefer plain subagent calls."
   > 一两次委派时，优先用普通 subagent 调用。
2. **不带 `subagent_in_background: false` 时才该同步等待**（`dsh-tool-subagent\lib\index.js:292`）：
   > "Set `run_in_background: false` only when your next action depends on that subagent's result."
   > 只有当你的下一步动作依赖该子 agent 的结果时才设 `run_in_background: false`。—— 反过来：**下一步不依赖，就不该同步等**。
3. **不是人类明确要求，就不要用 ralph**（`dsh-tool-ralph\lib\index.js:298`）：
   > "Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop…"
   > —— 以及 goal 侧（`dsh-tool-goal\lib\index.js:117`）：
   > "Do not use this for trivial single-turn work."（不要把它用于琐碎的单轮工作。）

另有一条**部署层**的规则（本机 `dev` preset，非 DSH 自带），限制「用当前会话 shell 裸起后台任务」：
出处：`C:\Users\Administrator\.dsh\.agent-presets\dev\agent.cordis.yml:32-35`
> 「长任务规范（必须遵守）：凡是你自己（当前模型/本会话）需要跑超过 1 分钟的任务——包括 Monitor 监视器、后台轮询、长命令——禁止用当前会话的 shell 直接起后台任务……必须二选一：1. 一次性长任务 → 用 claude_code 工具委派，run_in_background: true，结果必须写文件落盘；2. 常驻监视器 → 用 Start-Process 起独立进程……判断标准：任务运行期间，必须能从磁盘文件或 jobs 登记处读到它的进度。」

---

## 2. 任务管理机制（`todo_write`）

### 2.1 完整工具 description（本机按配置拼接而成）

出处：`@deepseek-ai\dsh-tool-todo\lib\index.js:21-33`。description 由 **head + 一个可变的活动状态子句 + tail** 拼成，唯一变量是 `allowParallel`：

**Head（恒定）** `:21`
> **原文**：Record and update a structured task list for the current work. Send the ENTIRE list every call — it REPLACES the previous list (there are no partial updates, no per-item edits). Use it to plan multi-step work and show progress: add one todo per concrete step before you start.
>
> **译**：为当前工作记录并更新一个结构化任务列表。**每次调用都要发完整列表**——它**替换**先前的列表（没有部分更新，没有单项编辑）。用它来规划多步工作并**展示进度**：**开始前**为每个具体步骤加一条 todo。

**活动状态子句（二选一）**
- 并行模式（本机 `dev`/`standard` preset 为 `allowParallelInProgress: true`）`:22`
  > **原文**：Mark every todo being actively worked on `in_progress` — several at once when work genuinely runs in parallel (e.g. concurrent subagents or background commands), one for sequential work; while work remains, at least one task should be `in_progress`.
  >
  > **译**：把**每一个正在推进**的 todo 标为 `in_progress`——当工作确实并行进行时（例如**并发的 subagent 或后台命令**）可以同时多个，顺序工作时只有一个；只要还有工作剩余，**至少应有一个**任务是 `in_progress`。
- 串行模式（`allowParallelInProgress: false`）`:23`
  > **原文**：Keep AT MOST ONE todo `in_progress` at a time; while work remains, exactly one active task should be `in_progress`.
  >
  > **译**：**同一时刻最多一个** todo 处于 `in_progress`；只要还有工作剩余，**恰好一个**活动任务应为 `in_progress`。

**Tail（恒定）** `:24`
> **原文**：Mark a todo `completed` the moment it is done (do not batch completions), and allow no `in_progress` item only once all work is complete. Skip the list for trivial single-step tasks. Statuses: `pending` (not started), `in_progress` (being worked on now), `completed` (finished).
>
> **译**：任务一完成就**立即**标 `completed`（**不要批量补标**）；只有在**所有工作都完成**时才允许没有 `in_progress` 项。**琐碎的单步任务跳过该列表。** 状态：`pending`（未开始）、`in_progress`（正在做）、`completed`（已完成）。

### 2.2 状态枚举与校验（不是模型自由发挥，是硬约束）

- 状态枚举固定三项：`dsh-tool-todo\lib\index.js:14-18` → `["pending","in_progress","completed"]`。
- **空 content 被拒**：`:51` → ``throw new Error("invalid todo: `content` must be a non-empty string")``
- **重复 content 被拒**：`:52` → ``throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`)``
- **并行开关联动硬校验**：`:60` → `if (!allowParallel && active > 1) throw new Error('invalid todos: at most one task may be in_progress (got ${active})')`
- **形状最小且拒绝扩展**：条目只允许 `content` + `status`；`additionalProperties: false`，`id`、嵌套等扩展字段**明确报错而不是被静默压平**（README.zh.md:25 原文）：
  > 「扩展条目形状（id、嵌套）会明确报错而不是被静默压平，保证落日志的快照与模型自认为写入的内容一致」
- **单一所有者 scope**（README.zh.md:15）：
  > 「该列表属于调用工具的唯一 agent 会话。不存在 subagent／共享／swarm scope：非 agent 调用方（没有 `exec.agent`）无处写入列表，因此会被拒绝。这是有意设置的 scope 限制」
  > → 即：**子 agent 不共享父 agent 的 todo 列表**，各自独立。

### 2.3 与「用户可见任务板」的关系（有持久化，也有 UI）

出处：`dsh-tool-todo\README.zh.md:9, 29, 33`

- 每次调用向会话日志追加 **`todo/write` 事件**（完整列表快照）。**当前列表 = 最新的该类事件**（回放时后写覆盖先写）。
- 规范结果为 `{ todos, counts: { pending, inProgress, completed } }`。
- **UI 自行渲染该持久列表**：
  > 「UI 订阅事件流，并自行渲染该持久化列表：web 客户端基于当前有效计划（其后没有更晚 `turn/start` 的最近一次 `todo/write`）显示**计划条**和专属工具行」
- **会话投影**：注册 `todos` 投影单元——`init = null`（尚无写入）、`apply` 从每个 `todo/write` 取整表、**每个 `turn/start` 清为 `null`**（当前有效计划）、`turn/end` 保留刚完成的清单、`view` 恒等、`stateVersion = 2`。
  → 即：**任务板在下一个用户轮次开始时自动清空**，只在「本轮」内作为可见计划存在。

### 2.4 与 plan mode 的关系（一条明确的「不要用 todo 跟踪计划」规则）

出处：`C:\Program Files\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh\config\agent-presets\standard\agent.cordis.yml:118`（本机 dev preset 同文，:125）

> **原文**：Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.
>
> **译**：**不要**用 `todo_write` 跟踪这个规划阶段：它跟踪的是**计划获批之后**的实现，而计划本身属于 `exit_plan_mode`。

### 2.5 是否存在「跨会话持久任务板」？

- **未见** DSH 原生提供跨会话/跨 agent 的共享任务板。`todo_write` 明确是**单 agent 会话、单轮次**作用域的（见 2.2 单一所有者、2.3 turn/start 清空）。
- 本机另有 `task_create/task_update/task_list` 等**工作区任务板**工具（本会话可用），但**本次未在 `@deepseek-ai/dsh-*` 包中找到其实现**——这些来自本机另行安装的插件，不在 DSH 自带实现范围内（**标注：未在指定源码位置找到**）。

---

## 3. 技能（skill）机制

### 3.1 定义格式：`SKILL.md` + YAML frontmatter

出处：`@deepseek-ai\dsh-skill-filesystem\lib\index.js:664-703`（`parseSkillFile`）、`README.zh.md:55-59`

**Frontmatter 字段白名单（`name` 与 `description` 必填）：**

| 字段 | 必填 | 类型 | 语义 |
|---|---|---|---|
| `name` | ✅ | string | 必须是 **kebab-case**（`:685` `isSkillName(name)` 校验；不合法则整个 skill 被忽略并告警） |
| `description` | ✅ | string | 目录里显示的唯一摘要；也是模型路由的唯一依据 |
| `whenToUse` | ❌ | string | 可选的「何时使用」元数据。**注意：目录中不渲染它**（见 3.4 限制） |
| `metadata` | ❌ | object | 开放元数据对象（`:871-875`） |
| `disable-model-invocation` | ❌ | bool | `true` → 从**面向模型的目录和 loader** 中排除该 skill |
| `user-invocable` | ❌ | bool | `false` → 从**面向用户的命令**中排除该 skill |

**布尔解析宽容度**（`:855-870`）：接受 YAML 布尔，以及不分大小写的 `true/false`、`yes/no`、`on/off`、`1/0`。
**失败即拒（fail-closed）**（`README.zh.md:57`）：若使用**驼峰拼写**（`disableModelInvocation` / `modelInvocable` / `userInvocable`）或提供**非布尔**调用值，会记录警告并**把整个 skill 从发现结果中排除**，而不是只丢该字段或回退到宽松默认。原文报错（`:853`）：
> `frontmatter field "${legacy}" is unsupported; use "${canonical}"`

**忽略条件**（会告警并跳过，`:672/676/682`）：
- `invalid YAML frontmatter`
- `missing YAML frontmatter`
- `frontmatter requires name and description`

### 3.2 发现与加载（渐进式披露，两层生命周期）

出处：`dsh-skill-filesystem\README.zh.md:55, 59, 71`；`dsh-tool-skill\README.zh.md:11, 25, 27, 31`

- **文件形态**：单层目录 bundle `<name>/SKILL.md`，或平铺 Markdown 文件 `<name>.md`。**刻意不支持**嵌套的 `**/SKILL.md`（发现深度只有一层）。
- **扫描根**（按 rank 顺序）：项目根（含 `.git` 的最近祖先，否则用 cwd）→ `customSkillDirs` → 用户 DSH 根（`$DSH_HOME` 或 `~/.dsh` 下的 `skills`；**跳过其 `.system` 子目录**）→ `$DSH_AGENTS_HOME` 或 `~/.agents`。
- **渐进式有两层，且生命周期独立**（`README.zh.md:59` 原文）：
  > 「目录与正文具有独立的生命周期。发现阶段解析 frontmatter 以生成概述。**每次 `skill(name)` 加载都会重新读取并解析当前文件**，因此正文编辑不需要 hash、修订号、缓存失效或主动通知模型。」
- **热更新靠 watcher**：Chokidar 监视根目录，观察 bundle 目录的增删、平铺 `.md` 的增删、以及直接 `SKILL.md` 的增删改；`change` 事件用于**重新发现 `name`、`description` 等目录 frontmatter**。`references/`、`scripts/`、`assets/` 下的变更**不会**使目录失效。
- **无正文修订协议**（`README.zh.md:75`）：已加载正文只是普通工具历史；后续编辑影响后续调用，**不会改写旧结果、也不会通知正文已变化**。

### 3.3 工具侧如何暴露：目录（catalog）+ loader

**目录注入时机**（`dsh-tool-skill\README.zh.md:11`）：每次符合条件的 `agent/pre-step`，用调用会话的 cwd 调 `ctx.skills.snapshot()`，按 `name` + `description` 渲染条目。**目录只含这些摘要；skill 正文、路径、来源、提供方和 `whenToUse` 提示都留在目录之外。**

**目录模板原文**（`dsh-tool-skill\lib\index.js:222-229`，等价于 `README.zh.md:44-53`）：
```markdown
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `<name>`: <normalized-and-capped-description>
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```
关键三句译文：
- 「**如果用户点名了某个 skill，或者任务明显匹配某个 skill 的 description，那么在采取任务动作之前，用确切的 skill 名调用 `skill` 工具。加载所有适用的 skill，然后遵循它们的完整指令。**」
- 「**本目录只包含摘要；在加载之前，不要推断或遵循某个 skill 的指令。**」（防止模型凭摘要幻觉规则）
- 「用户也可能直接调用 skill；它的 `<skill_content>` 块会出现在本对话中。遵循它，不要再为它调用 `skill` 工具。」（**防双重加载**）

**目录变更时**（`lib/index.js:247`）：
> "The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:"
> 译：可用 skill 目录已变更。本完整目录替换本会话中此前所有的可用 skill 列表。

**清空目录时**（`lib/index.js:241`）：
> "No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs."
> 译：`skill` 工具当前没有可用 skill。**不要使用来自更早目录的名字。**

**`skill` 工具 description**（`lib/index.js:39`）：
> "Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches that skill."
> 译：加载某个可用 skill 的完整指令。当任务点名或明显匹配某 skill 时，在行动前用会话 skill 目录中的**确切 skill 名**调用它。

**成功结果形状**（`README.zh.md:25`）：`{ name, provider, resourceBase?, content }`；原生渲染为包含 `<skill_content name="...">`、`<skill_resources>`、`<skill_instructions>` 的文本结果。
**资源是「指引」而非附件**（`README.zh.md:27, 166`）：工具只报告 base 目录/URL，**不列举也不代为获取**被引用的文件；脚本、参考资料按需加载。
**不添加合成上下文**（`README.zh.md:31`）：工具执行不追加合成消息，新加载结果作为工具结果记录，下一步即生效。

### 3.4 一个技能文件里通常写什么（结构）

从本机实际技能文件（`~/.dsh/skills/*/SKILL.md`、DSH 自带 `dsh\config\agent-presets\cordis\skills\*`）归纳出的稳定结构：

1. **frontmatter**：`name`（kebab-case）、`description`（**一句「Use when…」式的触发条件**，因为它就是路由依据）。示例（DSH 自带，`cordis\skills\editing-cordis-compositions\SKILL.md:1-4`）：
   ```yaml
   ---
   name: editing-cordis-compositions
   description: Use when creating, changing, or validating a Cordis composition for this harness — writing or editing an agent preset, adding or removing a plugin row, ...
   ---
   ```
2. **正文**：无固定 schema（`content = parsed.body.trim()`，`skill-filesystem\lib\index.js:702`），是自由 Markdown。实际常见分节：**「Off-limits（禁区）」→「先决定 plane / 环境事实」→ 逐步操作流程 → 校验方法**。
3. **可选资源**：`references/`、`scripts/`、`assets/` 子目录（`README.zh.md:47` 提到这些路径的变更**不**影响目录；`README.zh.md:27` 说明它们按需加载）。

**已知限制**（`dsh-tool-skill\README.zh.md:164-169`，值得借鉴的两条）：
- 目录**省略 `whenToUse`、来源和提供方元数据**——路由只基于名称和有长度上限的描述（默认 `catalogDescriptionMaxLength = 500`）。
- **已加载指令正文没有大小上限**：「提供方可返回足以占用大量下一步上下文的 skill；只有目录描述会被截断。」

---

## 4. 防呆与体验机制

### 4.1 `dsh-repeat-tool-reminder`：仅建议的循环中断器

出处：`@deepseek-ai\dsh-repeat-tool-reminder\lib\index.js:193, 196`；`README.zh.md:5, 9-16, 25-35`

**它是什么**（`README.zh.md:5` 原文）：
> 「这是一个**仅提供建议的循环中断器，而非面向模型的工具**：它不会出现在工具列表中，不会否决或改写调用，只增加一种行为。它监视每个 agent 的工具调用流，统计以**完全相同的规范化参数**连续调用同一工具的次数；达到所配置的连续次数时，它会**注入逐级增强的提示**，要求模型停止重复、重新阅读上一次结果，并改用其他方案或结束任务。」

**配置**（`README.zh.md:9-17`）：
```yaml
- id: repeat-tool-reminder
  name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    thresholds: [3, 5, 8]        # 默认；触发提醒的连续次数
    include: []                  # 要跟踪的工具名模式；空 ⇒ 全部工具
    exclude: [todo_write]        # 对链透明的工具名模式
    argumentsPreviewChars: 500   # 默认；详细提醒中引用参数的长度上限
```
**加载时快速失败**：`thresholds` 为空、非整数、小于 2、或重复 → 抛错，**绝不静默回退默认值**（`:242`）；`argumentsPreviewChars` 只接受 ≥1 的整数（`:264`）。

**触发条件与链语义**（`README.zh.md:25-31`）：
- **链键 = `(tool name, canonical arguments)`**。规范化对键深度排序后 `JSON.stringify`，因此**仅属性顺序不同**的参数对象视为相同。
- 与上一条受跟踪调用相同 → 计数 +1；换成另一条受跟踪调用 → 重置为 1。
- **不受跟踪的调用对链透明**：既不递增也不重置。因此 `grep X → todo_write → grep X` 仍算连续两次 `grep X`。
- **被拒绝的调用也计数**：检测位于 `tools/post-execute`，即便调用被 `pre-execute` 拒绝该事件也会运行。「模型反复尝试被拒绝的调用，恰恰是需要打断的循环。」
- **忽略没有 agent 的调用**。
- **按 agent 分键**（`WeakMap<Agent, Chain>`）：一个 agent 的重复调用**绝不会**触发另一个 agent 的提醒。用户提示词（`agent/pre-step`）会重置该 agent 的链。
- **仅驻留内存**：恢复的会话从全新链开始。

**第一阈值文案**（`lib/index.js:193`，简短通用版）：
> **原文**：You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.
>
> **译**：你在用完全相同的参数重复调用同一个工具。**再次调用之前，仔细分析上一次的结果**：如果任务还没完成，换一种做法或换一组参数，而不是重复这个调用。

**后续阈值文案**（`lib/index.js:196`，详细版）：
```
Repeated tool call detected:
- tool: <toolName>
- consecutive_calls: <count>
- arguments: <canonicalArguments>
The repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.
```
> **译**：检测到重复的工具调用：……这些重复调用**没有取得进展**。不要再用这些完全相同的参数调用该工具。检查最新结果，选择不同的动作、不同的参数，或者如果已经收集到足够证据就结束任务。

**提醒如何送达**（`README.zh.md:35`）：通过 post-execute 决策的 `additionalContexts`（来源 `{kind:'plugin', plugin:'repeat-tool-reminder'}`）传递，**绝不替换 `content`**；用于审计的 `tool/result` 事件仍保留工具自己的输出。提醒对模型可见、带来源归属，且无需新增会话事件即可从日志重建。

**已知限制**（`README.zh.md:85-90`）：仅检测精确匹配（近似变体可绕过）；压缩不会重置链；**仅建议**（未实现高阈值升级为 block，但 `PostToolDecision` 已支持阻止）；**subagent 之间不共享链**；合理幂等轮询超阈值仍会收到提醒（可用 `thresholds`/`exclude` 缓解）；超过最高阈值后不再提醒。

### 4.2 「长时间任务给用户反馈」的规则 / progress / heartbeat

**诚实结论：DSH 自带提示词里「未见」针对「向最终用户播报进度」的通用规则。** 对 `heartbeat` / `long-running` / `no progress` 的全量 grep 结果，只有下列实际命中，没有一条是「长任务要主动给用户发进度」：

| 命中 | 原文要点 | 它其实是 |
|---|---|---|
| `dsh-llm\lib\index.js:219`、`dsh-client-connection\lib\client.js:293` | "Empty deltas (**heartbeats**, empty tool-call frames) do not count" | 流式协议的**心跳帧**，属于传输层，与用户反馈无关 |
| `dsh-tool-pwsh\lib\index.js:142` / `dsh-tool-bash\lib\index.js:126` | "Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`." | **长命令 → 转后台 job** 的规则（原文：对长命令设 `run_in_background: true`：调用立即返回 job id；用 `job_output` 读输出、`job_kill` 停止） |
| `dsh-tool-goal\lib\index.js:117` | "Create one persisted same-session completion goal when the current direct human request is a **long-running objective** that should continue across autonomous goal rounds." | **长任务 → 建 goal**（把长任务变成可跨自动轮次推进的持久目标） |
| `dsh-tool-jobs\lib\index.js:201` | 见 §1.9 | 后台 job **完成时会话内通知**（不是「定期向用户播报」） |
| `dsh-tool-workflow\lib\index.js:94` | "`phase(title)` — start a progress phase; `log(message)` — narrate progress" | workflow **内部的**进度分组与叙述，不是给用户的 |

**唯一带「向用户交付/收尾」语气的原文**，来自 goal 的收尾注入（`@deepseek-ai\dsh-tool-goal\lib\index.js:90`）：

> **原文**（goal 完成时）：The goal is marked complete and this autonomous run is ending. **Write the closing message to the user now**: state the outcome, summarize what was done and how it was verified, and point to the concrete results (files, commits, or other artifacts). Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it. Note anything the user should review or do next. **Address the user directly.** Do not call any more tools in this run; further work waits for the user's next instruction.
>
> **译**：目标已标记完成，本次自主运行即将结束。**现在就写给用户的收尾消息**：说明结果，概述做了什么以及如何验证的，并指向具体产出（文件、commit 或其他工件）。**只报告本轮之前轮次和工具结果在本会话中真实确立的内容**；某个细节不在会话中时，就如实说明而不是编造。说明用户接下来应当审阅或执行的事项。**直接对用户说话。** 本次运行不要再调用任何工具；后续工作等待用户的下一条指令。

> **原文**（goal 阻塞时，同处）：...state what has been completed so far, describe the concrete blocking condition and what you tried, and say exactly what you need from the user to continue...
> **译**：说明目前已完成什么，描述具体的阻塞条件以及你尝试了什么，并**明确说出你需要用户做什么才能继续**。

### 4.3 `dsh-goal`：长任务的「正式机制」（比 todo 更强的长任务承载）

出处：`@deepseek-ai\dsh-tool-goal\lib\index.js:117-118, 190, 297`；`README.zh.md`（goal 是 `dsh-goal` 包，模型侧只有 `dsh-tool-goal`）

**create_goal description**（`:117`）：
> **原文**：Create one persisted same-session completion goal when the current direct human request is a long-running objective that should continue across autonomous goal rounds. You may infer that intent without requiring the user to say "create a goal". Do not use this for trivial single-turn work. Execution rejects non-human and subagent authority.
>
> **译**：当当前**直接人类请求**是一个应当跨自动 goal 轮次继续推进的**长期目标**时，创建一个**持久化的同会话完成目标**。你可以**推断**该意图，而无需用户说出「create a goal」。**不要把它的用于琐碎的单轮工作。** 执行会拒绝非人类和子 agent 的授权。

**get_goal description**（`:118`）：
> "Read the current same-session goal, including its exact id/revision, objective, phase, completed continuation rounds, round limit, blocker reason when present, and whether another continuation is armed. **Call this before updating a goal.**"
> 译：读取当前同会话目标，包括其确切的 id/revision、目标、阶段、已完成的续推轮数、轮数上限、阻塞原因（若存在），以及是否已武装下一次续推。**更新目标前先调用它。**

**提示词段**（`:190`，order 由 goal 工具控制）：
> **原文**：Use goal tools for one long-running completion objective in the current session. `create_goal` may infer goal intent from a direct human request in any language; do not create a goal for routine single-turn work. **Call `get_goal` before `update_goal` and copy its exact `goal_id` and revision.** After session resume or fork, an active goal is **disarmed**: when a human asks to continue or resume in any wording or language, use `update_goal` action `resume` to rearm it. **Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists for at least ${blockedAfter} consecutive goal rounds**, and report that concrete condition in `blocked_reason`; **difficulty, uncertainty, or useful remaining work is not blocked.**
>
> **译**：用 goal 工具在当前会话中承载**一个**长期完成目标。`create_goal` 可以从任何语言的直接人类请求中推断目标意图；不要为日常单轮工作创建 goal。**在 `update_goal` 之前调用 `get_goal`，并复制其确切的 `goal_id` 和 revision。** 会话恢复或 fork 后，活动 goal 会**被解除武装**：当人类以任何措辞或语言要求继续/恢复时，用 `update_goal` 的 `resume` 动作重新武装它。**只有目标真正达成时才标记 complete。只有在同一阻塞条件连续持续至少 N 轮 goal 之后才标记 blocked**，并在 `blocked_reason` 中报告该具体条件；**困难、不确定、或还有有用的剩余工作都不算 blocked。**

**update_goal 的授权边界**（`:297`）：
> "edit, pause, and resume require a direct top-level human request. During an automatic continuation of the current goal, complete and blocked are also allowed. blocked is rejected before the configured minimum round count..."
> 译：`edit`、`pause`、`resume` 需要**直接顶层人类请求**。在当前 goal 的**自动续推**期间，`complete` 和 `blocked` 也被允许。`blocked` 在达到配置的最小轮数前会被拒绝。

**硬校验原文**（`:352`）：`"blocked requires at least ${...} consecutive goal rounds; current round is ${...}"`

**goal 是持久化的**：本机可见 `C:\Users\Administrator\.dsh\storages\dsh-session-goal\goal.json`（跨会话存盘）。

---

## 5. 可借鉴清单（针对「微信助手 agent：判断何时把长任务委派给子 agent + 在微信里给用户反馈」）

> 场景前提：微信是**异步、低带宽、用户不一定在线**的信道；「回复」本身就是用户可见的产物。
> 每条给出**可落地的动作**与**DSH 原文依据**。

| # | 建议（一句话） | 依据 |
|---|---|---|
| 1 | **给「该委派」定三条硬判据并写进系统提示词**：任务自包含、任务聚焦独立、且跑完会污染主对话上下文——三条同时成立才委派。 | `dsh-tool-subagent\lib\index.js:118`："Delegate a self-contained task ... to offload focused, independent work ... so it does not consume this conversation's context." 译：把自包含任务委派出去以卸载聚焦、独立的工作，以免消耗本对话上下文。 |
| 2 | **区分「继承上下文」与「全新上下文」两条委派路径**：依赖聊天上下文的后续分析/评审走 fork 式（带上已完成轮次）；不依赖的走全新式（必须自带全部资料）。 | `:114`（fork）："Use this when the subtask builds on this conversation's context ..."；`:118`（全新）："... Give it a complete, standalone prompt: it does not see this conversation." |
| 3 | **委派提示词必须自包含到「不需要再问人」**，并明确写清交付物与验证方式——因为子 agent 只回结果不回过程。 | `:119`："... include everything it needs."；`:114`/`:118`："You receive its result, not its intermediate steps."（你收到的是结果，不是中间步骤） |
| 4 | **默认后台委派**：只有「下一步动作确实依赖该结果」时才同步等待；否则立刻给用户回一句「已在办」，然后继续别的活。 | `dsh-tool-subagent\lib\index.js:292`："Use ... in the background by default. ... Set `run_in_background: false` only when your next action depends on that subagent's result." |
| 5 | **在一条消息里批量启动多个互不依赖的委派**，而不是串行一轮一问。 | `:292`："**Start independent delegations together in one assistant message** and continue useful work while they run." |
| 6 | **把「一条消息里发多个独立委派」同时反映到任务清单**：并行时允许多个任务同时 `in_progress`，并明确把「并发 subagent / 后台命令」列为合法并行源。 | `dsh-tool-todo\lib\index.js:22`："Mark every todo being actively worked on `in_progress` — several at once when work genuinely runs in parallel (**e.g. concurrent subagents or background commands**) ..." |
| 7 | **微信里的「反馈」用「完成即通知」而不是「定期播报」**：实现一张 job 登记表，任务结算时由运行时主动推一条**带结束原因**的消息给用户的会话。DSH 明确反对 busy-poll。 | `dsh-tool-jobs\lib\index.js:201`："You are notified in-session when a job finishes — **do not busy-poll or sleep on one** ..."；结算文案模板见 `dsh-subagent\lib\index.js:684-697`（完成/被停/超长/拒绝/失败/异常 六种，各自一句）。**注意：DSH 自带未见「定期 heartbeat 播报」规则，本条是按完成事件推送，不是轮询。** |
| 8 | **给「难产」的任务加 per-agent 的重复动作打断器**：同一动作+同一参数连续 N 次就注入一句「没有进展，换做法或收尾」，且**纯建议、不否决**，并按会话/用户分键以免互相干扰。 | `dsh-repeat-tool-reminder\lib\index.js:193, 196`（两段提醒原文）；`:196`："The repeated calls are not making progress. Do not call this tool with these exact arguments again."；链按 agent 分键见 `README.zh.md:30`。 |
| 9 | **长任务（>1 分钟）一律落成「有盘上痕迹」的持久目标或持久 job**，并在收尾时按固定模板对用户讲清：结果、如何验证、指向哪个产物、下一步要人做什么。判断标准：任务期间必须能从磁盘文件或 job 登记处读到进度。 | goal 收尾模板 `dsh-tool-goal\lib\index.js:90`："Write the closing message to the user now: state the outcome, summarize what was done and how it was verified, and point to the concrete results ... Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it."；持久化证据 `~/.dsh/storages/dsh-session-goal/goal.json`；本机 dev preset 的长任务规范 `agent.cordis.yml:32-35`（「必须能从磁盘文件或 jobs 登记处读到它的进度」）。 |
| 10 | **把「怎么做某类微信操作」写成 skill，而不是写进主提示词**：frontmatter 只写「name + 一句 Use when…触发条件」，正文自由；目录只暴露摘要，模型确认匹配后才加载正文，从而在多技能时省 token 且减少幻觉。 | 目录模板 `dsh-tool-skill\lib\index.js:228`："... This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded."（本目录只含摘要；加载前不要推断或遵循其指令）；frontmatter 字段见 `dsh-skill-filesystem\lib\index.js:679-700` 与 `README.zh.md:55`。 |

### 附：三条「DSH 没说、但值得自己补」的空缺（诚实标注）

1. **「向用户主动播报长任务进度」的通用规则，DSH 自带提示词中未见。** 只有「job 完成 → 会话内通知」「goal 结束 → 写收尾消息」两种事件驱动形态。要在微信里做「进行中」的阶段性反馈，**必须自己设计**（DSH 没有可抄的原文）。
2. **「什么情况不该委派」没有集中原文**（未见）。只有三条可反推的边界：一两次委派别上 workflow；下一步不依赖就别同步等；非人类明确要求别用 ralph。
3. **跨会话/跨 agent 的共享任务板，DSH 自带实现中未见。** `todo_write` 被明确限制为「单 agent 会话 + 单轮次」（`turn/start` 即清空）。若微信助手需要跨天、跨用户可见的持久任务板，需要另建存储。

---

## 附：本次核对到的关键坐标速查

| 主题 | 文件:行 |
|---|---|
| 自包含委派 description | `@deepseek-ai/dsh-tool-subagent/lib/index.js:118` |
| fork 委派 description | `@deepseek-ai/dsh-tool-subagent/lib/index.js:114` |
| 委派 prompt 参数写法 | `@deepseek-ai/dsh-tool-subagent/lib/index.js:115,119` |
| 后台优先 + 批量启动提示词段 | `@deepseek-ai/dsh-tool-subagent/lib/index.js:289-293` |
| 子 agent 权限只读注入 | `@deepseek-ai/dsh-subagent/lib/index.js:547` |
| 后台结算通知文案（6 种） | `@deepseek-ai/dsh-subagent/lib/index.js:684-697` |
| report 工具约定 | `@deepseek-ai/dsh-tool-subagent-report/lib/index.js:33,39` |
| 后台 job 使用纪律（勿 busy-poll） | `@deepseek-ai/dsh-tool-jobs/lib/index.js:201-205` |
| workflow 判据 + pipeline/parallel 取舍 | `@deepseek-ai/dsh-tool-workflow/lib/index.js:94,141` |
| ralph 判据 | `@deepseek-ai/dsh-tool-ralph/lib/index.js:124,298` |
| Ralph 报告 schema / 每轮提示词 | `@deepseek-ai/dsh-tool-ralph/lib/index.js:36` 起 |
| todo_write 完整 description（三段拼接） | `@deepseek-ai/dsh-tool-todo/lib/index.js:21-33` |
| todo 状态枚举与校验 | `@deepseek-ai/dsh-tool-todo/lib/index.js:14-18,51,52,60` |
| todo 单一所有者 / UI / 投影 / 清空 | `@deepseek-ai/dsh-tool-todo/README.zh.md:9,15,25,29,33` |
| plan mode 禁用 todo 跟踪计划 | `dsh/config/agent-presets/standard/agent.cordis.yml:118` |
| skill frontmatter 解析 | `@deepseek-ai/dsh-skill-filesystem/lib/index.js:664-703,841-875` |
| skill 发现/加载生命周期 | `@deepseek-ai/dsh-skill-filesystem/README.zh.md:55,59,71` |
| skill 目录模板 + 防双重加载 | `@deepseek-ai/dsh-tool-skill/lib/index.js:222-229,241,247` |
| skill 工具 description | `@deepseek-ai/dsh-tool-skill/lib/index.js:39` |
| repeat-tool-reminder 两段提醒文案 | `@deepseek-ai/dsh-repeat-tool-reminder/lib/index.js:193,196` |
| repeat-tool-reminder 链语义与限制 | `@deepseek-ai/dsh-repeat-tool-reminder/README.zh.md:5,9-16,25-35,85-90` |
| goal 创建判据 + 更新前先 get_goal | `@deepseek-ai/dsh-tool-goal/lib/index.js:117,118,190` |
| goal 收尾/阻塞消息模板 | `@deepseek-ai/dsh-tool-goal/lib/index.js:90` |
| 系统提示词段 order 区间与渲染规则 | `@deepseek-ai/dsh-system-prompt/README.zh.md:36,38,57` |
| 本机生效 preset（persona 长任务规范等） | `C:\Users\Administrator\.dsh\.agent-presets\dev\agent.cordis.yml:24-40,181-256` |
| DSH 自带 preset 全量（含 delegation 组） | `node_modules\@deepseek-ai\dsh\config\agent-presets\standard\agent.cordis.yml` |
