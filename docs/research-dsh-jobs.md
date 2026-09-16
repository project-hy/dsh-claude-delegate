# DSH 后台 Job 系统与通知回流机制 — 源码研究报告

> 调研对象：本机 DSH Desktop（`C:\Program Files\DSH Desktop\resources\app.asar.unpacked`）
> 包版本：`@deepseek-ai/*` `0.1.1-rc.2`
> 证据形式：以下所有结论均来自**已发布的编译后 JS（`lib/index.js`）+ 包内 `README.zh.md` + 生效的装载配置 yml**。
> 路径简写：`§NM` = `C:\Program Files\DSH Desktop\resources\app.asar.unpacked\node_modules\`（含 `@deepseek-ai\<pkg>\lib\index.js`）。

---

## 0. 调研方法与证据边界

| 项目 | 状态 |
|---|---|
| 编译产物 `lib/**/*.js` | ✅ 全部读到 |
| 包内中文 README（含语义契约、默认值表、已知限制） | ✅ 全部读到 |
| 生效装载配置 `§NM\@deepseek-ai\dsh-base\cordis.patch.yml` | ✅ 读到（这是 host 组合的**唯一**来源） |
| 生效 agent preset `~\.dsh\.agent-presets\dev\agent.cordis.yml` | ✅ 读到 |
| 原始 TypeScript `src/*.ts` | ❌ **读不到**（包内 `files` 只有 `lib/`） |
| `.js.map` 的 `sourcesContent` | ❌ **不存在**——目标 10 个包内 `.map` 文件数为 **0**，故无原始 TS 可恢复 |
| `.d.ts` 类型声明 | ❌ 包内无 `.d.ts`；但**权威类型声明可从 typert 注册表快照里读到**（见 §1.1，`dsh-tool-cordis/lib/index.js`） |
| 包内 README 反复引用的 `docs/subsystems/jobs.zh.md`、`.agents/notes/**`（10+ 篇 Agent Note） | ❌ **本地不存在**（`docs/`、`.agents/` 目录均不存在，属于上游仓库相对路径） |

⚠️ 因此：**凡本报告标注「读不到」处，均是本地无该文件，而非未查**。

---

## 1. Job 的数据模型与状态机

### 1.1 权威类型声明（非推测，来自 typert 注册表）

`§NM\@deepseek-ai\dsh-tool-cordis\lib\index.js` L5097–5139 是生成期注册的类型快照，逐字如下：

```ts
export type JobId = Branded<'JobId'>;
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed';

export interface JobKindMap {          // 生产方插件按 module-augmentation 扩展
  bash: 'bash';
  subagent: 'subagent';
}
export type JobKind = JobKindMap[keyof JobKindMap];

export interface JobStart {            // start() 的入参
  kind: JobKind;
  label: string;
  outputLimitBytes?: number;
  owner?: Agent;
  run(): JobHooks;
}

export interface JobHooks {            // 生产方必须实现的最小面
  cancel(reason?: string): void;
  done: Promise<JobOutcome>;
  readOutput?(): string;               // ★ 可选：有无它决定 job 属于哪一类（见 §2）
}

export interface JobOutcome {
  status: 'completed' | 'killed' | 'failed';
  detail?: string;
  output?: string;                     // ★ 最终输出任务在此交付
}

export interface JobSnapshot {         // 对外的不可变快照（只读投影）
  id: JobId; kind: JobKind; label: string;
  outputLimitBytes?: number;
  ownerSession?: SessionId;
  status: JobStatus;
  detail?: string;
  startedAt: number; finishedAt?: number;
  reported: boolean;                   // ★ 通知抑制位
}

export interface JobRead { text: string; snapshot: JobSnapshot }
export type JobDoneListener     = (snapshot: JobSnapshot, owner: Agent | undefined) => void | PromiseLike<void>;
export type JobsChangedListener = (owner: Agent | undefined) => void;
```

> 📌 **注意一处不一致**：`JobKindMap` 快照只声明了 `bash`/`subagent`，但 `§NM\@deepseek-ai\dsh-tool-pwsh\lib\index.js` L388 实际以 `kind: "pwsh"` 启动 job。说明该 Maps 是可被生产方包 augment 的接口，typert 快照只是抓到了当时已加载的部分。**移植时应把 kind 当开放字符串**（注册表本身只校验「非空字符串」，见 L133）。

### 1.2 内存中的可变记录（内部真身）

`§NM\@deepseek-ai\dsh-jobs-local\lib\index.js` L146–164，`start()` 构造的 record：

```js
const job = {
  id, kind, label, outputLimitBytes, owner,
  cancel: hooks.cancel.bind(hooks),
  readOutput: hooks.readOutput?.bind(hooks),
  status: "running",
  detail: void 0,
  output: void 0,            // 仅最终输出任务用
  startedAt: Date.now(),
  finishedAt: void 0,
  reported: false,           // ★ 通知抑制位（快照里也暴露）
  settled, markSettled,      // 供 teardown 等待的自建 Promise
  waiters: 0,
  waitResolvers: new Set(),  // wait() 的挂起者
};
```

- **存储位置：纯内存 `Map`**（L105 `store = new Map()`），**没有 sqlite、没有文件落盘**。
- id 计数同样只在内存：`counters = new Map()`（L106），`id = JobId(\`${kind}-${count}\`)`，即 `<kind>-N`、**N 从 1 起、按 kind 独立、进程内单调**。
- 快照是**每次新建的只读投影**（`snapshot()` L317–331），"从不交出实时状态"（README 原文）。
- **进程终止即全部消失**——这是 README「已知限制」第一条明写的。

### 1.3 状态机

```
                 start(spec)
   (无记录) ─────────────────────► running
                                     │
                    ┌────────────────┼─────────────────┐
                    │                │                 │
        producer done.then       kill(id)          teardown
        (settle, 首次即胜)    cancel() 成功      (cancelForTeardown)
                    │                │                 │
                    │                ▼                 │
                    │            stopping ─────────────┤
                    │           (等 done 结算)          │
                    │                │                 │
                    └────────────────┴─────────────────┘
                                     │
                                     ▼
              completed │ killed │ failed      ← 三个终态，finishedAt 落地
```

**关键规则（均有代码证据）：**

1. **首次结果优先（first-wins）** — `settle()` L366 开头即 `if (isTerminal(job.status)) return;`。晚到的 producer 结果被丢弃，这正是 teardown 强制失败能压过迟到成功的原因。
2. **`stopping` 不是终态，且只有 `kill()` 与 teardown 能进入**。`kill()` L197–209：
   ```js
   job.cancel(reason);          // 先取消；抛异常则状态不变（保持 running）
   job.status = "stopping";
   job.reported = true;         // ★ 主动 kill 视为已上报 → 抑制完成通知
   ```
   `cancel()` 抛异常时 job 保持 running（README：*「取消抛出异常时任务保持运行」*）。
3. **`done` rejection 被隔离为 `failed`**，而非污染注册表（L168–174，记 warning「producer contract violation」）。
4. **每个终态都必须有 `finishedAt`**，且 `finishedAt >= startedAt`——由 `dsh-jobs/lib/types/invariant.js` L22–29 强制校验（`terminal !== (finishedAt !== undefined)` 即报错）。
5. **`reported` 位被置 true 的全部时机**：① `kill()`；② 对**终态**的 `read()`（L191）；③ 对终态或无 future 的 `wait()` 返回时（L258）；④ `wait()` 走完后若已终态；⑤ `settle()` 时若有挂起 waiter（L371 `if (job.waiters > 0) job.reported = true`，为了避免"等的人已经拿到结果"还再发通知）；⑥ teardown 取消（L438，理由：正在被销毁的 owner 已无读者）。

### 1.4 所有权与隔离

- **owner 就是 `Agent` 对象**（不是 id），隔离判据是 `job.owner.id !== caller?.id`（L313–315 `assertAccess`）。
- 代码注释明说这是**安全边界而非保密边界**：*"Ids are predictable, so authorization — not secrecy — is the boundary."*（`dsh-jobs/lib/index.js` L44）
- **无 owner 的 job 对任何调用方开放**，且只在服务 dispose 时清理（README「已知限制」第 5 条亦确认无会话隔离）。
- `list(caller)` 只返回 `owner === undefined || owner.id === caller.id`（L180）。

---

## 2. 两类 job：流式 vs 最终输出

**判据是生产方有没有提供 `readOutput` 钩子**——不是配置项，是生产方在 `run()` 返回的 `JobHooks` 里给不给。注册表按有无分派（L190）：

```js
read(id, caller) {
  const job = this.expect(id);
  this.assertAccess(job, caller);
  const text = job.readOutput !== void 0
    ? job.readOutput()                                  // ★ 流式：每次调用消费游标
    : isTerminal(job.status) ? job.output ?? "" : "";   // ★ 最终输出：终态前恒为 ""
  if (isTerminal(job.status)) job.reported = true;
  return { text, snapshot: this.snapshot(job) };
}
```

| | **流式 job** | **最终输出 job** |
|---|---|---|
| 钩子 | 提供 `readOutput()` | 不提供 |
| 交付通道 | `readOutput()` 返回增量 | `done` 解析出的 `JobOutcome.output` |
| 缓冲在哪 | **注册表不缓冲**，游标在**生产方**（子进程管道） | `settle()` 时存入 `job.output`（L369） |
| 中断/运行中读取 | 有内容，可反复读 | 恒为 `""`（空串） |
| 终止后读取 | 仍走 `readOutput()`，给最后一段增量 | 幂等返回全量 `output` |
| 重复读取 | **不重复**（消费式游标，只此一个） | 幂等，读几次都一样 |
| 实例 | `pwsh` / `bash` 后台（`run_in_background: true`） | `subagent` 后台（非 continuable） |

**证据链：**

- 流式（pwsh 后台）：`§NM\@deepseek-ai\dsh-tool-pwsh\lib\index.js` L387–399
  ```js
  jobId: jobs.start({
    kind: "pwsh", label: args.command, ...exec.agent ? { owner: exec.agent } : {},
    run: () => {
      const proc = ctx.shell.start(ctx.shell.resolve(request));
      return {
        cancel: () => void proc.kill(),
        done: proc.done.then(() => processOutcome(proc)),
        readOutput: () => renderPwshProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
      };
    }
  })
  ```
  `dsh-shell` 的契约明确游标是消费式：`§NM\@deepseek-ai\dsh-shell\lib\index.js` L77 — *"ShellProcess.readOutput is incremental: consecutive reads never repeat output."*

- 流式结算产出**没有 output**：`§NM\@deepseek-ai\dsh-tool-bash\lib\index.js` L21–30
  ```js
  function processOutcome(proc) {
    if (proc.status === "killed") return { status: "killed", detail: ... };
    return { status: "completed", detail: `exit code: ${proc.exitCode ?? 0}` };
  }
  ```
  → 只有 `detail`，`output` 永远 undefined，符合流式定位。

- 最终输出（subagent 后台）：`§NM\@deepseek-ai\dsh-tool-subagent\lib\index.js` L252–268 启动时**只给 `cancel` + `done`，不给 `readOutput`**；`§NM\@deepseek-ai\dsh-subagent\lib\index.js` L2301–2319 的 `runOutcome` 正是产出 `output` 的地方：
  ```js
  case "completed": return { status: "completed", output: finalText(result.output) };
  case "aborted":   return { status: "killed" };                 // 无 output
  case "error": case "max-tokens": case "refusal":
                    return { status: "failed", detail: failureDetail(result) };  // 无 output
  ```

### `job_output` 的完整语义

`§NM\@deepseek-ai\dsh-tool-jobs\lib\index.js` L270–283：

```js
async execute(args, exec) {
  const id = validateJobId(args.job_id);
  if (args.wait === true) {
    const timeout = Math.min(args.timeout_ms ?? waitDefault, waitCap);  // 默认30s，上限600s
    await ctx.jobs.wait(id, timeout, exec.agent, exec.signal);
  }
  const read = ctx.jobs.read(id, exec.agent);
  return { text: read.text, job: publicJob(read.snapshot) };
}
```

- **默认非阻塞**；`wait: true` 才阻塞，超时后**不 kill**，返回存活快照（`wait()` L239 `if (timeoutOf(d.signal,'TASK_WAIT_TIMEOUT') !== void 0) resolve();` → 走"超时即返回"分支）。
- 每次响应都以 `[status: ...]` 结尾（`statusLine()` L80：`[status: ${status}, ${detail}]`，无 detail 则 `[status: ${status}]`）。
- 空增量渲染为 **`(no new output)`**（L263）。
- 输出**只对模型可见的形态做字节上限**（见 §4.3），注册表本身从不重写生产方输出。
- **流式读取只有单一消费方**——这是 README 明确列出的已知限制（*"流输出只有一个消费游标：独立观察者需要游标或快照 API"*），也是本设计对移植最重要的约束。

---

## 3. 通知回流机制（★ 本报告重点）

### 3.1 一句话答案

> **job 结算 → 注册表 `JobDoneListener` → `dsh-tool-jobs` 构造一条 `role: "user"` 的"通知消息"→ 按 owner 当时的忙闲状态，二选一投递：忙则 `inject()` 进 next-step 队列（不打断、不额外开轮次），闲则 `followup()` **唤醒**开启新一轮。**

### 3.2 全链路（逐跳带证据）

**第 1 跳：producer 结算 → 注册表**
`§NM\@deepseek-ai\dsh-jobs-local\lib\index.js` L166–174：`hooks.done.then(outcome => this.settle(job, outcome), ...)`

**第 2 跳：注册表 `settle()` 的提交顺序（顺序本身是有语义的）**
L365–387：

```js
settle(job, outcome) {
  if (isTerminal(job.status)) return;            // 首次结果优先
  job.status = outcome.status; job.detail = outcome.detail;
  job.output = outcome.output; job.finishedAt = Date.now();
  if (job.waiters > 0) job.reported = true;      // 有 waiter → 已算上报，抑制通知
  const snapshot = this.snapshot(job);
  [...job.waitResolvers].forEach(r => r());      // ① 释放等的人
  job.markSettled();                             // ② 释放 teardown 的 settled promise
  this.notifyChanged(job.owner);                 // ③ 广播可见集变化
  if (this.listenersClosed) return;
  for (const listener of this.listenersFor(job.owner)) try {
    const returned = listener(snapshot, job.owner);          // ④ 最后才发完成通知
    Promise.resolve(returned).catch(e => this.selfCtx.logger.warn(...));
  } catch (error) { this.selfCtx.logger.warn(...); }
}
```

注释（L357–364）直接解释了这个顺序的**理由**：
> *"Completion is announced last because a reporter may open a model turn synchronously: every other observer of this settlement must already have seen the committed record."*

即：**完成通知可能同步开启一次模型轮次**，所以它必须排在记录提交、waiter 释放、可见集广播之后——否则其他观察者会读到未提交的记录。

**第 3 跳：监听器如何筛选"该发给谁"**
L297–301 `listenersFor(owner)`：先全局层（无 scope 注册的，服务所有 owner），再沿 owner 的 scope 链（`ScopedLayers`/`scopeOf`）。README 解释了必要性：一个进程级注册表要服务所有 preset，如果扁平化，"一次结算会抵达每个 preset 的 notice 监听器"，模型会读到重复通知。

**第 4 跳：`dsh-tool-jobs` 的监听器（真正的组装点）**
`§NM\@deepseek-ai\dsh-tool-jobs\lib\index.js` L206–227：

```js
ctx.jobs.onJobDone((snapshot, owner) => {
  if (snapshot.reported || owner === void 0) return;      // ★ 已上报 / 无主 → 不通知
  const message = createUserMessage({
    content: [{ type: "text", text: fitCompletionNotice(snapshot) }],
    source: {
      kind: "plugin", plugin: "tool-jobs",
      form: "notice",                                     // ★ UI 折叠行
      summary: completionSummary(snapshot),               // ★ 单行摘要
    },
  });
  const spent = spentWakes.get(owner) ?? 0;
  if (delivery === "wakeup" && owner.status === "idle" && spent < wakeBudget) {
    spentWakes.set(owner, spent + 1);
    owner.followup(message);                              // 闲 → 唤醒开新轮
    return;
  }
  owner.inject(message);                                  // 忙 或 预算耗尽 → 注入
});
```

**第 5 跳：`inject` / `followup` 落到 inbox**
`§NM\@deepseek-ai\dsh-agent-loop\lib\index.js` L390–404：

```js
send(message, target, wakeup) {
  const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
  const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
  this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
  if (wakeup) this.wakeDriver(wakingAfterAbort);
}
followup(input) { this.send(input, "next-turn", true); }   // 入 next-turn 队列 + 唤醒
steer(input)    { this.send(input, "next-step", true); }   // 入 next-step + 唤醒
inject(input)   { this.send(input, "next-step", false); }  // ★ 入 next-step，不唤醒
```

**第 6 跳：消息如何真正进入模型上下文**
- 每次 turn 的步循环开头调用 `preStep(target, ...)`（L534），内部 L496 `this.inbox.claim(target, position.turn)` → **一次性清空整个 `next-step` 列表**（外加 `next-turn` 的 1 条，若 target 为 next-turn），
- 然后 L554：`for (const message of decision.messages) this.session.append("user/message", message, { surfaceOp: "append" })` → **成为真正的 user 角色消息，进入模型可见 surface**。
- **关键：在 `next-step` 非空时 turn 无法结束**（L564/L571：`if (turnEnds && this.inbox.nextStep.length === 0) break;`）。这正是 README 所说的*"该 inbox 尚有内容时 turn 无法结束，因此同时结算的多个任务只花掉一步，而不是各占一轮"*。

**第 7 跳：唤醒预算的自激抑制**
L175–177：`ctx.on("agent/inbox/claimed", ({ agent, message }) => { if (message.source.kind === "user") spentWakes.delete(agent); })`
→ **只有用户撰写的消息才补充预算**；插件自己排队的通知不会给自己补充刚花掉的预算。

### 3.3 通知内容的精确形态

| 要素 | 值 / 来源 |
|---|---|
| 角色 | `user`（`createUserMessage`，`§NM\@deepseek-ai\dsh-llm\lib\types\message.js` L44） |
| 正文 | `background job <id> (<kind>: <label>) finished [status: <status>]. Read its output with job_output.`（`fitCompletionNotice()` L116–120；超限时按 §3.4 降级） |
| source | `{ kind: "plugin", plugin: "tool-jobs", form: "notice", summary: <≤120字符单行> }` |
| 摘要 | `completionSummary()` = `` `${kind} ${label} [status: ...]` ``，再经 `boundContextSummary` 截到 **120 字符**（`CONTEXT_SUMMARY_MAX_CHARS = 120`，message.js L9） |
| **是否含输出本体** | **否**。只给 id 与取用指令，输出要靠 `job_output` 再取——这是刻意的上下文预算设计 |
| **是否含输出路径** | **否**。通知本身不带 spill 路径（spill 路径只在工具结果里，见 §4） |

### 3.4 通知自身的字节上限（有界降级链）

`fitCompletionNotice()` L116–132 是一段显式的**预算优先降级**：固定部分 `background job <id>` 与 `\nDone; job_output.` 优先保留，可变部分（kind/label/status/detail）先用 `retainHead` 截头，再退化为只留 `prefix + action`，最后连 action 都超限时用 `retainTail(action, maxBytes)` 硬砍。

```js
const prefix = `background job ${snapshot.id}`;
const detail = ` (${snapshot.kind}: ${snapshot.label}) finished ${statusLine(snapshot)}`;
const action = "\nDone; job_output.";
```

上限取自 `snapshot.outputLimitBytes`（生产方声明的）。README 补充：*"即使采用 PTY 支持的 64 字节下限，稳定 id 前缀和收集命令的优先级也高于可变 label/detail，因此通知仍可操作。"*

### 3.5 「父 agent 是下一轮才看到，还是被打断？」— 逐情形回答

| owner 当时状态 | 走哪条 | 效果 |
|---|---|---|
| **running（繁忙）** | `inject()` → `next-step` | **不打断当前步**；当前步结束后、**下一次步边界**即被 `claim` 并进入上下文。多个 job 同时完成**合并成一步**（因为 claim 一次清空整个 next-step 列表）。 |
| **idle（空闲）** | `followup()` → `next-turn` + `wakeDriver()` | **主动唤醒**，开启一次**用户并未要求的新模型轮次**。 |
| idle 但 `maxConsecutiveWakes`(默认3) 已耗尽 | 降级为 `inject()` | 通知静默挂在 next-step，**等下一次因别的原因开轮时才被领走**（README「已知限制」第 2 条明说：预算不随时间恢复）。 |
| `completionDelivery: "quiet"` | 恒为 `inject()` | 空闲也不唤醒；README 说这是"确定性 transcript 需要的"。 |
| `reported === true` | 直接 `return` | 不通知（kill 过 / 已 read / 已 wait / teardown 取消 的 job 都属此列）。 |
| `owner === undefined` | 直接 `return` | **无主 job 永不通知**。 |

### 3.6 已知的漏通知窗口（README 自分列）

> *"落在 driver 退休窗口内的结算仍会让通知搁浅：在轮次循环最后一次检查 inbox 与 driver 提交 idle 相位之间，所有者读起来仍是繁忙，因此通知走注入且无人唤醒。steer 有同样的洞；堵上它属于 `agent-loop`。"*

对照代码即 `turn()` 尾部 L600 `if (!this.inbox.hasPending) return false;` 与 `kick()` 的 finally L482–489 之间：`status` 仍报 `running`，但之后没有新的 claim，通知既不唤醒也无人领取。**移植时必须补这个交接。**

---

## 4. 输出保留（retention）与溢写（spill）

这是**三层独立机制**，职责严格分离（`dsh-output-retention` README 明确划界）。

### 4.1 层一：`dsh-output-retention` — 纯库，无 ctx/无服务/无事件

`§NM\@deepseek-ai\dsh-output-retention\lib\index.js`。**只回答"我们保留了什么、省略了什么"**，不回答业务语义。两个 retainer 因**资源模型不同**而分名：

| Retainer | 界 | 策略 | 备注 |
|---|---|---|---|
| `ItemRetainer<T>` | **逻辑单元条数** | 仅 `head`（`maxItems`） | 用于 glob/grep/搜索来源；调用方继续 push 全部，故 `omitted.count` 精确 |
| `TextRetainer` | **UTF-8 字节** | `head` / `tail` / `headTail` | `headTail` 是 spill 预览用的形态 |

关键实现细节（可移植要点）：
- **按字节而非字符**计数，因为子进程管道与 HTTP body 都是字节流；
- `finish()` 会 `trimTrailingPartialUtf8` / `trimLeadingContinuationUtf8` 修剪切割处的半个码点，**保证返回文本绝不引入替换字符**（L109–126, L224–226）；首尾**分开解码**，不会跨越被省略的中间重建码点；
- `TextRetainer` **内存有界**：最多持有 `prefixCap + suffixCap + 一个 chunk`，旧的后缀 chunk 随滑动被丢弃（L137 注释 + L190–200）；
- `truncated` 语义被刻意限定为**预算事实**，绝不表示"上游不完整"（README 专章强调，这是"命名最容易诱发的缺陷"）；
- 省略措辞标准化：`describeOmitted` → `exact` 打印数量（`Omitted 3 items.`）、`unknown` **不打印数量**、`none` 返回空串。

### 4.2 层二：`dsh-spill` / `dsh-spill-local` — 存储 seam

- `§NM\@deepseek-ai\dsh-spill\lib\index.js`：抽象服务 `ctx.spillStore`，**只有 `saveText` 一个方法**。刻意不拥有任何保留策略、不拥有结果替换、不提供检索 API。
- `§NM\@deepseek-ai\dsh-spill-local\lib\index.js`：宿主文件系统实现，安全设计扎实：
  - 根目录：`mkdtempSync(join(tmpdir(), "dsh-spill-"))` → **`0700` 私有、后缀不可预测**（防同机其他用户读 + 防预置符号链接）；
  - 会话隔离：`<root>/session-<sha256(sessionId).slice(0,12)>`；
  - 文件名：`<randomBytes(6).hex>-<encodeSegment(suggestedName)>`，`encodeSegment` 对每码位做 **`~XXXX` 单射转义**，显式处理 `.`→`~002E`、`..`→`~002E~002E`、空串→`~`（**路径穿越防护**，与 JSONL 持久化后端同款）；
  - 写：`open(path, "wx", 0o600)` — **排他 + 仅属主可读写**，任何已存在路径（含符号链接）都会失败；
  - 返回 `{ locator: <绝对路径>, bytes, retrievalHint: "Use read with offset/limit, or grep this path to search within it." }`。

### 4.3 层三：`dsh-spill-policy` — 何时 spill（策略插件）

`§NM\@deepseek-ai\dsh-spill-policy\lib\index.js`，注册在 `tools/post-execute` waterfall 上的 `{ prepend: true }` 监听器。

**生效阈值（来自装载配置，不是默认值）：**
`§NM\@deepseek-ai\dsh-base\cordis.patch.yml` L349–352

```yaml
- id: spill-policy
  name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineBytes: 50000
```

> `maxInlineBytes: 50000`（UTF-8 字节）。**省略该键 ⇒ 插件完全不注册，策略彻底关闭**（代码 L86 `if (maxInlineBytes === void 0) return;`）。

**触发与替换逻辑**（L136–153 模型面分支）：

```js
ctx.on("tools/post-execute", async (exec, result, next) => {
  const decision = await next();
  if (decision.kind !== "accept" || Object.hasOwn(decision, "value")
      || exec.parent !== void 0 || exec.name === "read") return decision;   // 四类豁免
  const text = flattenPlainText(decision.content ?? result.content);
  if (text === void 0) return decision;                                     // 非纯 text 块 → 不动
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxInlineBytes) return decision;                        // 未超 → 不动
  const replacedText = await spillReplacement(text, totalBytes, ownerSessionId(exec), exec.name, exec.callId, "result");
  if (replacedText === void 0) return decision;                             // 尽力而为回退
  return { kind: "accept", content: [{ type: "text", text: replacedText }], ... };
}, { prepend: true });
```

**四类豁免**：`exec.parent !== undefined`（嵌套子调用）、已接受的值替换（注册表需重新校验渲染）、`read`（避免 `read → spill → read again` 死循环）、非 `accept` 决策（`block` 的纠正反馈原样通过）。**非纯 text 块（含图像等）一律不动。**

**替换文本的构造（预览 + 通知，总量绝不超上限）** L96–135：
1. `preview(text, budget)`：`headTail` 切分，`headBytes = Math.ceil(budget/2)`、`tailBytes = Math.floor(budget/2)`；
2. `reserve = byteLength(spillNotice(...)) + 2`，先为通知预留，再 `preview(text, Math.max(0, cap - reserve))`；
3. 通知文案：`` `(Omitted N bytes. Full formatted result stored at: <locator>. <retrievalHint>)` ``；
4. 若**仅通知**仍超上限 → 记 warning 并**保留内联原结果**（*"it never emits a replacement larger than the cap"*）。

**第二个分支 `tools/code-dispatch-log`**（L154–166）：对 `run_code` 子调用结果的**持久化日志副本**施加同一上限（产物标签 `dispatch`）。程序返回值不受影响（早已完整跨 worker 边界）。`read` 子调用在**此分支不豁免**——因为日志副本不是模型上下文，而 `read` 恰恰最易产生巨型日志。

**尽力而为铁律**：无 session owner / 无 `ctx.spillStore` / `saveText` 拒绝 ⇒ 记 warning 并**返回原始结果**。代码 L38 注释：*"A spill failure must NEVER turn a successful tool call into an `isError` or hide the inline result."*

### 4.4 另外两层相关的"收缩"机制（同为实际生效配置）

| 机制 | 生效值 | 来源 | 作用 |
|---|---|---|---|
| `dsh-compaction-tool-result-pruner` | `thresholdChars: 8192, headChars: 4096, tailChars: 1024` | `dsh-base/cordis.patch.yml` L360–365 | 在**会话历史**里把超大工具结果就地收缩（保留 4KB 头 + 1KB 尾），先于整体 compaction |
| `dsh-compaction-basic` | `DEFAULT_THRESHOLD_RATIO = 0.8`、`DEFAULT_RETAIN_RATIO = 0.16` | `§NM\@deepseek-ai\dsh-compaction-basic\lib\index.js` L13/L15 | 压力达上下文容量 80% 触发压缩，压缩后保留约 16% |

### 4.5 job 输出这一侧的独立上限：`outputLimitBytes`

注意 **job 的输出与 spill 是两个不同维度**：

- spill 管的是**任何工具结果**（post-execute 通用）。**job 的读取结果只有在它本身作为一次工具结果返回时才会被 spill 策略看到**（`job_output` 的执行结果同样过 `tools/post-execute` 流水线）。
- `outputLimitBytes` 是**生产方声明、由 job 控制器（`dsh-tool-jobs`）应用**的独立上限（`dsh-jobs` README：*"注册表不会重写生产方输出，也不会为省略此字段的生产方虚构默认值"*）。
- **本地装载配置里没有任何生产方设置 `outputLimitBytes`** ——`dsh-base/cordis.patch.yml` 的 `jobs` 行（L69–70）与 `tool-jobs` 行（L218–219）都无 config。故在当前部署下 `outputLimitBytes` **实际为 undefined**，`dsh-tool-jobs` 的字节上限代码路径（`fitWithSuffix` / `fitCompletionNotice` 的截断分支）**在当前本机配置下不会触发**，读取走"无界控制器行为"。这是从代码推导的结论（代码注释亦自述：*"省略该字段的生产方保留现有的无界控制器行为"*）。

---

## 5. 超时策略

### 5.1 `dsh-timeout` — 共享的超时算术库（无 ctx、无服务）

`§NM\@deepseek-ai\dsh-timeout\lib\index.js`，导出 4 件工具 + 1 个错误类：

```js
const MAX_TIMER_DELAY_MS = 2147483647;   // 2^31-1，Node setTimeout 不钳制为 1ms 的上限

class TimeoutReason extends Error { code; timeoutMs; name = "TimeoutReason" }

function clampTimeout(requested, def, max, name = "timeoutMs")   // → min(requested ?? def, max)
function deadline(upstream, timeoutMs, code)                     // 融合调用方取消 + 定时器，返回 { signal, [Symbol.dispose] }
function idleWatchdog(upstream, timeoutMs, code)                 // 可重臂的"空闲看门狗"，仅在有 outstanding next 时计时
function timeoutOf(x, code)                                      // 从 signal/error 回收 TimeoutReason，可带 code 过滤
```

**核心设计律（README 与代码一致）**：
- **只管通知，不管终止** — `deadline()` 的注释：*"The signal only notifies, so callers must stop their own work."*
- `timeoutMs <= 0` 是**内部的无定时器哨兵**，不是公开的"禁用超时"开关；
- `clampTimeout` 的 `requested` 必须是正整数（`0` 不被接受为公开语义）；
- `idleWatchdog` 计时器**只在 `next()` 挂起期间存在**，故"消费者的思考时间不计入提供方空闲"；
- `timeoutOf(x, code)` 带 code 过滤的意义：**区分本层的定时器与外层嵌套 deadline**，外来 code 走普通取消路径。

### 5.2 `dsh-tool-call-timeout-policy` — 工具调用超时的强制执行者

`§NM\@deepseek-ai\dsh-tool-call-timeout-policy\lib\index.js`。**零配置函数型插件**（`name`/`inject:["tools"]`/`apply`，不注册服务、不接受 config）。

```js
const TOOL_TIMEOUT = "TOOL_TIMEOUT";   // 既作 deadline 分类码，也作结果上的结构化 error.code

function apply(ctx) {
  ctx.on("tools/execute", async (exec, next) => {
    const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs;   // ★ 预算来自工具自身声明
    if (timeoutMs === void 0) return next();                             // 未声明 → 原样委托，不启动定时器
    const d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT);
    const upstream = exec.signal;
    exec.signal = d.signal;                     // 原地替换（Cordis next() 忽略入参）
    try {
      const result = await next();
      if (timeoutOf(d.signal, "TOOL_TIMEOUT") !== void 0) return toolTimeoutResult(timeoutMs);
      return result;
    } finally { exec.signal = upstream; }       // ★ 还原，让 tools/post-execute 看到调用方自己的 signal
  });
}
```

**与 `dsh-timeout` 的关系**：本插件是 `dsh-timeout` 的**第一个参考消费者**。`dsh-timeout` 提供 `deadline()`/`timeoutOf()`/`TimeoutReason` 三个原语，本插件负责①从 `ToolDefinition.timeoutMs` 取预算、②把派生 signal 塞进 `exec.signal`、③把超时映射为面向模型的结构化结果。README 的 `FIXME` 提到未来可能改名为 `dsh-timeout-guard`（**尚未落地**）。

**超时后的处理**：

```js
function toolTimeoutResult(timeoutMs) {
  const message = `tool call timed out after ${timeoutMs}ms`;
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: "ToolTimeoutError", code: TOOL_TIMEOUT } },
  };
}
```

- **不 kill、不抢占**：只是把已分发的结果**替换**为一个 `isError` 结果。工具若不理会 `exec.signal`，它不会停。
- 代码注释与 README 把这一点称为"**协作式，而非硬终止**"，并明确：*"声明 `timeoutMs` 意味着「与 `exec.signal` 协作」…只有转发信号的工具才应声明该字段"*。
- **没有统一预算**：**未声明 `timeoutMs` 的工具没有注册表级默认值**——README 明说 `bash`/`read`/`write`/`edit` **有意不声明**。
- 与 future 的 retry/sandbox 包装层组合时，**注册顺序即语义**（超时在外层 = 覆盖整个重试；在内层 = 覆盖每次尝试）。

### 5.3 job 超时 vs 工具调用超时 — 明确的对照

| 维度 | 工具调用超时 | job 超时 |
|---|---|---|
| 归属 | `dsh-tool-call-timeout-policy` + `ToolDefinition.timeoutMs` | **无独立机制**——`dsh-jobs-local` 内**没有任何 job 级超时** |
| 预算来源 | 工具插件声明（如 `tool-web` 的 `searchTimeoutMs: 60000`） | 生产方自己的 `run()` 内部逻辑 |
| 超时后 | 替换结果为 `TOOL_TIMEOUT` isError | 生产方自行决定（通常 kill 自己的子进程 → `done` 结算为 `killed`） |
| 硬终止？ | 否（协作式） | 由生产方决定 |

**关键证据**：`dsh-jobs-local/lib/index.js` 全文（455 行）**只有一个超时相关常量** `TASK_WAIT_TIMEOUT`（L75），且它只用于 `wait()` 这个**读取等待**，不是 job 的生存期上限：

```js
const TASK_WAIT_TIMEOUT = "TASK_WAIT_TIMEOUT";   // "distinguishes a bounded wait from caller cancellation"
```

`wait()` L230–247：用 `deadline(signal, timeoutMs, TASK_WAIT_TIMEOUT)`；`onAbort` 里若 `timeoutOf(d.signal,"TASK_WAIT_TIMEOUT") !== undefined` 则 **resolve（超时=正常返回存活快照）**，否则（真取消）reject `"wait aborted"`。**超时绝不 kill job**——这正是 `job_output` 文档所说的 *"A timed-out wait returns [status: running] and leaves the job alive."*

**另有 `.dsh` 层可见的相关超时值**（`dsh-base/cordis.patch.yml`）：前台 `bash-sandbox.timeoutMs: 60000`、`tool-web.searchTimeoutMs: 60000`、`session-title-llm.timeoutMs: 60000`。（**注意这些是前台/辅助调用，不是后台 job 的生存期上限。**）

---

## 6. Token 计量（`dsh-token-meter`）

`§NM\@deepseek-ai\dsh-token-meter\lib\index.js`（26KB）+ `lib/types/*.js`。单例服务 `ctx.tokenMeter`。

### 6.1 它统计什么

**估算器无配置项**（README：*"任何配置键都会被拒绝"*），固定启发式为 **每 4 个字符 ≈ 1 token**，再加角色/块/请求 envelope 的结构开销。

两个公开操作：
- `measure(session, requestHeader?)` — 在同一已消费日志 revision 上返回**请求压力**与**当前已计价表层**；同步、返回独立且**深度不可变**的快照，每次调用克隆带位置的节点（`O(1)`，但读取是 O(surface)）。
- `estimateMessage(message)` — 单条消息计价。

`measure()` 返回的字段（README「测量约定」）：
- `totalTokens` = 请求 + 响应压力
- `surfaceTokens` = 仅表层启发式总量，**等于 `nodes[].tokens` 之和**

**provider 用量复用条件严格**：只有当最新成功调用的**规范请求 envelope 与已测量 envelope 完全一致**，且其总量不低于该调用的完整启发式锚点时，才复用 provider 用量；否则全量重估。用量计量求和不重叠的 `uncachedInput / cacheRead / cacheWrite / output` bucket，**不重复添加 reasoning**。显式空 `sourceEventSeqs` 表示"已知空 provider 流"。

### 6.2 给谁用

**给压力敏感插件（主要是 compaction）与 UI。** 组成（`dsh-base/cordis.patch.yml`）：

```yaml
- id: token-meter
  name: '@deepseek-ai/dsh-token-meter'
```

它可选注册 3 个 session projection 单元：

| 单元 | 内容 |
|---|---|
| `tokenUsage` | 全量日志的 `uncachedInputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` |
| `contextPressure` | `pressureTokens`（provider 报告的最新提示词规模 = 未缓存输入 + cache read + cache write）、`projectedTokens`、`contextWindow` |
| `contextBreakdown` | 启发式 `systemTokens` / `toolsTokens` / `messageTokens`（**上下文组成**，非计费规模） |

**主要消费者 = `dsh-compaction-basic`**，它直接调用 `ctx.tokenMeter.measure(agent.session)`（`§NM\@deepseek-ai\dsh-compaction-basic\lib\index.js` L537/565/580/859/885/898/933）：

```js
const measurement = meter.measure(agent.session);
...
if (measurement.totalTokens < spec.thresholdTokens) return null;   // 未达阈值则不压缩
```

其中 `thresholdTokens = Math.floor(contextWindow * thresholdRatio)`，`contextWindow` 来自 `ctx.llm.resolveModelInfo().context`（**容量属适配器，不属 meter**）。

**`projectedTokens`（"下一个请求要花多少"）的特别价值**（README 明确）：
> *"压缩通过直连的 `ctx.llm.stream()` 调用生成摘要，自身不追加任何用量，所以仅凭 `pressureTokens` 会一直报告压缩前的提示词规模，直到再完成一整个轮次为止。"*

即：**压缩动作本身不会让 pressure 下降**，所以需要 `projectedTokens` 把样本沿表层的增减推进到当下，下界钳 0。**UI 的占用率展示读的是 `projectedTokens`**。

### 6.3 明确的边界（README 自陈）

- 占用率百分比是**面向用户的参考数字，既非计费记录也非门控输入**：*"harness 中没有任何环节依据它做决策，压缩改为直接读取 `measure()`"*。
- 三个占用率字段**各自后者胜、彼此独立，不是对单个请求的一次原子观测**（切模型时新容量会与上一路由样本配对）。
- `contextBreakdown` 三项**之和 ≠ `projectedTokens`**：差额正是 provider 锚点承载、而启发式明细带的误差 —— *"按「4 字符 ≈ 1 token」计价，CJK 文本与 JSON schema 会被严重低估"*（**对本机中文环境尤为重要**）。
- **这一层与 job 系统没有直接耦合**：job 的 token 影响是**间接**的——job 通知与 `job_output` 读取结果作为普通消息留在父级历史中直到 compaction（`dsh-tool-jobs` README「Token 影响」原文）。

---

## 7. 并发与资源

### 7.1 上限：每 owner 10 个

`§NM\@deepseek-ai\dsh-jobs-local\lib\index.js`：

```js
const DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER = 10;                        // L77

static Config = z.object({
  maxConcurrentJobsPerOwner: z.number().step(1).min(1)
    .max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_CONCURRENT_TASKS_PER_OWNER),
});                                                                        // L102
```

`start()` 的准入顺序（L131–137）：

```js
if (!this.servesOwner(spec.owner)) throw new Error("background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)");
if (spec.kind.length === 0) throw ...
if (spec.label.length === 0) throw ...
if (spec.outputLimitBytes !== void 0 && (!Number.isSafeInteger(...) || <= 0)) throw ...
if (spec.owner !== void 0) this.ensureOwnerCleanup(spec.owner);
if (this.activeTaskCount(spec.owner) >= this.maxConcurrentJobsPerOwner)
  throw new Error(`background job limit reached for this owner (limit: ${...}); use job_kill to stop an unneeded job, wait for it to finish, then retry`);
const hooks = spec.run();          // ★ 只有全部校验通过才真正执行生产方
```

**语义要点：**
- 计数口径：只有 `running` 与 `stopping` 占用名额（L286）；**终态历史不占容量**；**`stopping` 直到 `done` 结算才释放名额**。
- **bucket 粒度 = 精确 owner 对象**；**所有无 owner 的 job 共享另一个独立的"服务级"桶**（README 明确）。
- **没有队列、没有抢占**（README：*"注册表不会排队或抢占任务，也不会维护第二份可变计数"*）。超限直接失败，错误信息**引导模型用 `job_kill`**。
- 失败发生在**分配 id 与执行生产方之前** ⇒ 不会产生"半启动"的记录。

### 7.2 当前本机生效配置

`§NM\@deepseek-ai\dsh-base\cordis.patch.yml`：

```yaml
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'      # L69-70：无 config → maxConcurrentJobsPerOwner = 10
...
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'       # L218-219：无 config → 全部走默认
```

⇒ **本机实际值：每 owner 最多 10 个并发 job**；`waitTimeoutMs=30000`、`maxWaitTimeoutMs=600000`、`completionDelivery=wakeup`、`maxConsecutiveWakes=3`。
（`~\.dsh\.agent-presets\dev\agent.cordis.yml` L80–81 的 `tool-jobs` 行同样无 config，一致。）

### 7.3 生命周期的资源归属（易踩坑）

- **注册表**（`dsh-jobs-local`）挂在 **host 平面**——它的注释（agent preset L71–79）解释了为什么：registry 按 owner agent 键控，**一个 host 实例服务所有会话**；而生产方（`tool-bash` 等）在 preset 之外解析它，若把 registry 放进 entry-local realm，`run_in_background` 会答"background jobs unavailable"而工具却出现在目录里。
- preset 行 `tool-jobs` 决定的是**这个 agent 能否收集/停止**后台工作 ⇒ 形成**按 preset 的能力开关**：`servesOwner()` 检查 owner 的 scope 链上是否有**控制器**（`attachController("tool-jobs")`，L200）。
- **注册表的存续期长于生产方 fiber 与控制器 fiber**：重载生产方/控制器**不会停止 job**（README）。
- **owner dispose**：`ensureOwnerCleanup()` 通过 owner 的 `ctx.effect` 挂清理 → `disposeOwned()` 取消 + `await` 全部 `settled` + 从 store 删除 + `notifyChanged`。**复用的 agent id / session id 无法重定向旧清理**（校验 `agents.get(ownerId) !== owner` 即抛错）。
- **服务 dispose**：`disposeAll()` → `listenersClosed = true` → `cancelForTeardown(all)` → `await Promise.all(settled)` → `store.clear()` → 逐个 `notifyChanged(owner)` → 执行并清空 `ownerCleanups`。
- **teardown 的取消抛异常 ⇒ 强制标 `failed`**（`cancelForTeardown` L443–450），detail 写明 `"cancel threw during teardown; work may be orphaned"`，**避免死锁**。但**若 `cancel()` 正常返回而 `done` 永不结算，注册表无法与"缓慢停止"区分，teardown 会阻塞**（README 列为已知限制第 2 条 —— 该 job **在服务剩余生命周期内持续占用一个名额**）。

### 7.4 「同时能跑几个」的诚实回答

| 问题 | 答案 |
|---|---|
| 每 owner 几个？ | **10**（可配） |
| 全局几个？ | **无全局上限**——只有 per-owner 桶。有 N 个并发 agent，理论上限就是 10×N（含 substructure 各层）。 |
| 有队列吗？ | **没有**。超限即抛错。 |
| 有全局调度/公平性吗？ | **没有**。 |
| 谁约束真实资源？ | 底层执行体（`ctx.shell` 子进程数、sandbox），以及**没有**任何 job 级的 CPU/内存配额——**读不到**任何此类限制代码。 |

---

## 8. 移植设计要点速查

### 8.1 数据模型（最小可移植核心）

```
JobSnapshot   : id, kind, label, outputLimitBytes?, ownerSession?, status,
                detail?, startedAt, finishedAt?, reported          ← 唯一对外形态，只读投影
JobRecord     : snapshot 字段 + cancel/readOutput(可选)/output + settled/markSettled
                + waiters/waitResolvers                            ← 内部可变，绝不外泄
JobStatus     : running → stopping → (completed|killed|failed)
JobHooks      : cancel(reason?), done: Promise<JobOutcome>, readOutput?()
JobOutcome    : status(终态三选一), detail?, output?
```

**必须照抄的三条不变量**：① 首次结果优先；② `finishedAt` 恰好在终态存在且 `>= startedAt`；③ 有 owner 的 job 只能被 `owner.id === caller.id` 的调用方访问。

### 8.2 通知回流（最值得照抄的部分）

1. **通知是一条真消息，不是回调副作用** — 走 `user` 角色、`source.form = "notice"`、带 ≤120 字符 `summary`，可持久化（`agent/inbox/spliced` 事件落日志）、可回放、UI 可折叠。
2. **忙/闲双通道** — 忙 → `inject` 进 `next-step`（**不打断、多任务合并成一步**）；闲 → `followup` 唤醒开新轮（**因为"无人领取的待发通知等于模型永远不会知道的完成"**）。这个二选一是整个机制的精华。
3. **唤醒预算必须设界且只用人类输入补充** — 因为链条会自激（被唤醒的一轮可能又启动一个 job）。
4. **`reported` 位是去重的唯一手段** — kill / read / wait / teardown 都要置位；没有它就会重复通知。
5. **声明顺序即语义** — 完成通知必须排在其他 settle 后效（提交、释放 waiter、广播变更）**之后**，因为它可能同步开启一轮。
6. **必须补 driver 退休窗口**（§3.6）：`status` 仍报 running 但已无后续 claim 时，注入的通知会搁浅。上游自称属 `agent-loop` 的坑，**移植时应显式设计交接**。

### 8.3 输出/超时/token 三条策略的可移植数值

**输出保留**
- 通用 spill 阈值：**`maxInlineBytes = 50000`（UTF-8 字节）**；省略该键 = 策略完全关闭。
- 预览形态：**`headTail`，head = `ceil(budget/2)`，tail = `floor(budget/2)`**；`budget = cap - reserve`，`reserve = byteLength(通知) + 2`。
- 工具结果历史收缩：**`thresholdChars 8192 / headChars 4096 / tailChars 1024`**。
- 通知摘要硬上限：**`CONTEXT_SUMMARY_MAX_CHARS = 120`**。
- spill 权限：根目录 **`0700`**（`mkdtemp` 随机后缀）、文件 **`0600` + `wx` 排他**、文件名 `randomBytes(6).hex-` 前缀、会话目录 `session-` + sha256 前 12 hex。
- **按字节不按字符**，且切割处必须修剪半个 UTF-8 码点；`truncated` 只表示预算、不表示上游不完整。

**超时**
- 库上限常量：**`MAX_TIMER_DELAY_MS = 2147483647`**（`setTimeout` 不钳制的边界）。
- 工具调用超时：预算来自 `ToolDefinition.timeoutMs`，**无注册表级默认**；`clampTimeout(requested, def, max) = min(requested ?? def, max)`。
- **协作式，绝不硬终止**：signal 只通知，工具须自己转发 `exec.signal`；超时替换为 `{ isError: true, error.info.code: "TOOL_TIMEOUT" }`，文案 `Error: tool call timed out after <ms>ms`。
- **job 无超时上限**；`TASK_WAIT_TIMEOUT` 只用于"有界等待"，超时 = 返回存活快照、**不 kill**。
- 已声明值参考：`job_output` wait 默认 **30000ms / 上限 600000ms**；前台 bash-sandbox **60000ms**；`web_search` **60000ms**。

**Token 计量**
- 固定启发式：**4 字符 ≈ 1 token** + 结构开销；**无配置项**（多余键直接拒绝）。
- 分层：provider 锚点（精确，条件苛刻）+ 表层增量（启发式）→ `projectedTokens`；压缩阈值 **0.8**、保留比 **0.16**。
- **容量不属 meter**，来自 `ctx.llm.resolveModelInfo().context`。
- 面向用户的占用率**不是门控输入**；CJK 与 JSON schema 会被**严重低估**（本机中文场景必须注意）。

### 8.4 并发
- **每 owner 10**（`maxConcurrentJobsPerOwner`，`running` + `stopping` 计数，终态不占位，`stopping` 待 `done` 才释放）。
- **无队列、无抢占、无全局上限**；超限即抛错并引导 `job_kill`。
- id 生成：**`<kind>-N`**，按 kind 独立计数，进程内单调；**注册表纯内存**，进程死则全丢。

---

## 9. 诚实标注：读不到 / 无法确认的部分

### 9.1 文件层面确实不存在（本地无此文件）

1. **原始 TypeScript 源码**：`src/*.ts` 未随包发布（`package.json` 的 `files` 只含 `lib/`），且**目标 10 个包内 `.js.map` 数量为 0**，故无法从 `sourcesContent` 还原原始 TS。所有实现细节均以编译后 JS 为据。
2. **`.d.ts` 类型声明**：包内 `lib/types/**` 只有 `.js`，**无 `.d.ts`**（`dsh-jobs` 下 `.d.ts` 计数 = **0**）。本报告的接口声明取自 typert 生成期快照（`dsh-tool-cordis/lib/index.js`），属**注册表快照而非权威 `.d.ts`**。
3. **被 README 引用的 Agent Note 全部不存在**：`docs/subsystems/jobs.zh.md`、`.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.zh.md`、`2026-07-26-job-registry-seam.zh.md`、`2026-07-06-tool-result-retention-library.zh.md`、`2026-07-06-timeout-deadline-library.zh.md`、`2026-07-08-tool-output-spill-files.zh.md`、`2026-07-26-code-dispatch-log-spill.zh.md`、`2026-07-29-package-regrouping.md`、`2026-07-29-projected-token-usage-and-request-context.zh.md` 等 —— `docs/` 与 `.agents/` 在 `app.asar.unpacked` 下**均不存在**（已 `Test-Path` 验证为 False）。**设计动机与历史决策的原始记录读不到**，本报告中的"为什么"只能来自代码注释与 README 转述。
4. **`dsh-timeout` 的完整 README 未纳入引用**（已读 `lib/index.js` 全文 + 导出面；README 内容与代码一致，未逐条摘录）。

### 9.2 存在但本报告未能完全覆盖

5. **`dsh-token-meter` 的 `lib/index.js` 全文（26KB）未逐行读完**。第 6 节结论基于**其 README（对测量约定的描述极为详尽）+ `lib/types/*.js` 结构与 `dsh-compaction-basic` 的调用点**。`measure()` 内部 `surface-fold.ts` 的具体 fold 算法细节、`usage-projection.js` / `surface-projection.js` / `breakdown-projection.js` 的逐行实现**未逐行验证**。
6. **`dsh-tool-cordis` 中的 typert 快照可能滞后**：`JobKindMap` 只列 `bash`/`subagent`，而 `dsh-tool-pwsh` 实际用 `kind: "pwsh"`。无法确定这是快照滞后、还是 pwsh 未做 module augmentation（两种都可能）。**移植时应把 kind 视为开放字符串。**
7. **`dsh-terminal-bash` / `dsh-tool-bash-persistent` / `dsh-tool-pwsh-persistent` 的 `readOutput` 实现未细读**（`grep` 显示存在 `readOutput()` 定义与调用），故"PTY 持久终端"这条路径是否构成第三类 job 未确认。
8. **`fitCompletionNotice` 中提到的 "PTY 支持的 64 字节下限"**（`dsh-tool-jobs` README）在 `dsh-tool-jobs/lib/index.js` 里**找不到对应的 64 常量** ——可能位于 PTY 渲染侧包内。**该数值未验证。**

### 9.3 逻辑上无法从静态代码确认

9. **本机运行时的真实并发数**：README/代码给出**上限**为 10，但**当前进程内实际存活 job 数无法从静态文件读出**——注册表纯内存（`store = new Map()`），无落盘、无查询接口（唯一读取途径是运行中的模型工具 `job_list`，或在进程内调用 `ctx.jobs.list()`）。本报告**未向运行中的 GUI 发起任何探测**。
10. **`outputLimitBytes` 在本机的实际取值**：已确认 `dsh-base/cordis.patch.yml` 与 agent preset 中**所有 job 生产方（`tool-pwsh` / `tool-bash` / `tool-subagent`）的行都没有配置该项**，且生产方代码里也没写死该字段 ⇒ 推断为 `undefined`。但**无法排除运行期插件（如 `dsh-claude-driver`、用户 profile 的其他 patch 层）在其他 job kind 上设置它**——`dsh-claude-driver` 与其他 profile bundle 的 `cordis.patch.yml` **未纳入本次检查范围**。
11. **spill 目录的实际累积情况**（`%TEMP%\dsh-spill-*` 下文件数量与体积）**未检查**——报告只描述策略，不描述运行时状态。**未发现任何自动清理/GC 逻辑**（`dsh-spill-local` 全文无删除代码），但这只说明"本地后端不清理"，**不能断言无其他清理者**。
12. **跨进程 / 持久后端**：`dsh-jobs` README 明说"约定是进程内的"，持久化或跨进程后端**不存在**；`JobStart.run()` 直接传回调和**确切 `Agent` 对象**，任何持久后端都必须先重塑身份/重启/所有权/观察语义。**这是已知的设计边界，非遗漏。**

---

## 附：核心证据文件清单

| 包 | 关键文件 | 本次用途 |
|---|---|---|
| `@deepseek-ai/dsh-jobs` | `lib/index.js`、`lib/types/index.js`、`lib/types/invariant.js`、`lib/types/brand.js`、`README.zh.md` | 抽象契约、语义律、快照不变量 |
| `@deepseek-ai/dsh-jobs-local` | `lib/index.js`（455 行，全文精读）、`README.zh.md` | **实现主体**：状态机、settle、准入、teardown |
| `@deepseek-ai/dsh-tool-jobs` | `lib/index.js`（353 行，全文精读）、`README.zh.md` | **通知回流**、三工具、字节上限 |
| `@deepseek-ai/dsh-agent-loop` | `lib/index.js` L300–609 | `inject`/`followup`/`steer`、inbox claim、turn 终止条件 |
| `@deepseek-ai/dsh-agent` | `lib/types/inbox.js`（185 行，全文） | 持久化 inbox 投影、splice 语义 |
| `@deepseek-ai/dsh-llm` | `lib/types/message.js` L1–80 | `createUserMessage`、`boundContextSummary`(=120) |
| `@deepseek-ai/dsh-output-retention` | `lib/index.js`（285 行，全文）、`README.zh.md` | `ItemRetainer`/`TextRetainer`、UTF-8 边界 |
| `@deepseek-ai/dsh-spill` | `lib/index.js` | `ctx.spillStore` 抽象 seam |
| `@deepseek-ai/dsh-spill-local` | `lib/index.js`（138 行，全文） | 路径安全、`0700`/`0600`/`wx` |
| `@deepseek-ai/dsh-spill-policy` | `lib/index.js`（169 行，全文）、`README.zh.md` | 阈值判定、preview+notice、豁免规则 |
| `@deepseek-ai/dsh-timeout` | `lib/index.js`（140 行，全文） | `deadline`/`clampTimeout`/`idleWatchdog`/`timeoutOf` |
| `@deepseek-ai/dsh-tool-call-timeout-policy` | `lib/index.js`（144 行，全文）、`README.zh.md` | `TOOL_TIMEOUT` 映射、协作式语义 |
| `@deepseek-ai/dsh-token-meter` | `README.zh.md`（68 行）、`lib/types/*.js`、`lib/index.js`(部分) | 计量约定、三个投影单元 |
| `@deepseek-ai/dsh-compaction-basic` | `lib/index.js`(grep + 局部) | `measure()` 消费点、0.8/0.16 阈值 |
| `@deepseek-ai/dsh-tool-pwsh` / `dsh-tool-bash` | `lib/index.js` 生产方段落 | **流式 job** 生产方实例 |
| `@deepseek-ai/dsh-tool-subagent` / `dsh-subagent` | `lib/index.js` 生产方与 `runOutcome` | **最终输出 job** 生产方实例 |
| **装载配置** | `@deepseek-ai/dsh-base/cordis.patch.yml` L69–70、L218–219、L343–352、L360–365；`~\.dsh\.agent-presets\dev\agent.cordis.yml` L71–81 | **本机实际生效的阈值与默认值** |
