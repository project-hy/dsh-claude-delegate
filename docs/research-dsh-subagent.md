# DSH（DeepSeek Harness）桌面版 子 agent 核心架构 研究报告

> 用途：为把 DSH 的子 agent 架构移植到其它 Node 项目提供设计输入。
> 研究目标：`@deepseek-ai/dsh-subagent` 及 6 个周边包。
> 版本：`0.1.1-rc.2`（各包 package.json 一致）。
> 研究日期：本机安装产物快照。

---

## 0. 阅读范围与诚实声明

### 0.1 实际位置

任务描述给的路径是 `node_modules\dsh-subagent\...`，**实际不存在**。真实位置在 `@deepseek-ai` scope 下：

```
C:\Program Files\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\
├── dsh-subagent\                      (lib/index.js 116 KB + lib/types/*.js)
├── dsh-subagent-in-process-driver\    (lib/index.js 10 KB)
├── dsh-subagent-spawn-in-process\     (lib/index.js 1.5 KB)
├── dsh-subagent-fork-in-process\      (lib/index.js 2.3 KB)
├── dsh-tool-subagent\                 (lib/index.js 13.5 KB)
├── dsh-tool-subagent-control\         (lib/index.js 3.8 KB + lib/types/list-agents.js 8 KB)
└── dsh-tool-subagent-report\          (lib/index.js 4.2 KB)
```

### 0.2 能读到什么

- **核心代码全部可读，且不是混淆产物**。`lib/index.js` 是 bundler 输出（带 `//#region` 标记），但保留了完整 JSDoc、原始变量名、4 空格缩进的逻辑结构；`lib/types/*.js` 是同一份代码的**按模块编译形态**（缩进更贴近 TS 原样）。两者内容一致，`package.json` 的 `main` 指向 `lib/index.js`。
- 每个包都带 **`README.zh.md`**，篇幅很大（`dsh-subagent` 的 33 KB），内容是结构化的架构说明 + "模型体验/Token 影响/KV Cache 影响"三段式，**信息密度接近设计文档**，且与代码可以交叉验证。本报告大量引用它，但所有关键结论都用代码复核过。
- 本机实际部署组合可读：`@deepseek-ai/dsh-base/cordis.patch.yml` 第 292–333 行。

### 0.3 读不到什么（不编造）

| 项 | 状态 |
|---|---|
| `*.js.map` / `sourcesContent` | **不存在**。`Get-ChildItem -Recurse -Include '*.map'` 在 subagent 相关包中命中数 **0**；只有 `//# sourceMappingURL=xxx.js.map` 注释悬挂。原始 TS 拿不到。 |
| `*.d.ts` | 不存在（虽然有 `"types": "lib/types/index.d.ts"` 声明）。类型只能从 JS 的 JSDoc 与运行时校验反推。 |
| `src/` 目录 | 不随包发布。 |
| `.agents/notes/**` Agent Note | README 大量引用（如 `2026-07-25-subagent-policy-inheritance.zh.md`），**不在安装产物里**，无法核对。 |
| `docs/subsystems/subagent.zh.md`、`docs/tool-catalog.zh.md` | 同上，仅有引用。工具 schema 已从 `defineTool` 定义直接读到，不依赖该文档。 |
| `dsh-subagent-acp`（进程外 provider） | **本机未安装**。`dsh-subagent/lib/types/out-of-process.js` 提供了进程外语汇（无能力声明、结果结算、run handle 发布），但没有消费者，因此进程外路径的**实际行为无法验证**，只能读词汇层。 |
| monorepo 私有符号 | `SubagentProvider` / `SubagentRun` / `SubagentResult` 的完整类型定义只在 `.d.ts` 中，读不到；本报告按运行时实际使用的字段描述。 |

---

## 1. 架构总览

### 1.1 组件分层（文字图）

```
┌─ 模型可见层（工具 / ToolDefinition）──────────────────────────────────┐
│  dsh-tool-subagent  ×2 实例（按 cordis.patch.yml 各注册一个工具名）     │
│    ├─ id: tool-subagent        provider=spawn  toolName=subagent      │
│    │                           backgroundMode=continuable             │
│    └─ id: tool-subagent-fork   provider=fork   toolName=subagent_fork │
│                                backgroundMode=one-shot                │
│  dsh-tool-subagent-control（全局、只注册一次）                          │
│    ├─ 根插件            → send_message / interrupt_agent              │
│    └─ ./list-agents     → list_agents(scope)                          │
│  dsh-tool-subagent-report（**子级作用域**贡献，不是全局工具）           │
│    └─ registerContinuableSetup(childCtx => report 工具 + prompt 段)   │
└───────────────────────────────────────────────────────────────────────┘
                     ↓ 只依赖 ctx.subagents（服务面）
┌─ Service Definition 层：@deepseek-ai/dsh-subagent ────────────────────┐
│  SubagentRuntime (ctx.subagents)  —— 具名 provider 注册表              │
│    · providers: Map<name, SubagentProvider>                           │
│    · 公开 API: registerProvider/getProvider/list                      │
│               start(name, req) → SubagentRun            (一次性)      │
│               startContinuable(spec) → {childId,messageId}            │
│               followup(parent,childId,content,opts)   (父→子投递)     │
│               interrupt(targetSessionId, authority)   (停当前轮次)     │
│               reportFrom(child,content,opts)          (子→父上报)     │
│               listChildren / listDescendants          (只读目录)      │
│               registerContinuableSetup(contribution)                  │
│               drainContinuableDescendants / drainContinuableChildren  │
│    · 内部 SubagentContinuationManager —— 驻留 / 准入 / 所有权 /       │
│      冷恢复 / child-first 拆卸 / **结算通知**                          │
│    · 内部 SubagentActivationSetupRegistry —— 部署贡献安装/撤销         │
│    · 生命周期 emitter（subagent/start|end、provider-added|removed）    │
│    · 2 个 session projection 单元（subagentTiming / subagent）         │
│    · 持久化描述符词汇 subagent/descriptor（version 2）                 │
└───────────────────────────────────────────────────────────────────────┘
                     ↑ SubagentProvider 契约
┌─ Service Provider 层（传输）──────────────────────────────────────────┐
│  dsh-subagent-in-process-driver   startInProcessRun()  ← 共享驱动      │
│    ├─ spawn-in-process  name=spawn  inheritsParentContext=false       │
│    │     start(req) → startInProcessRun(req, {})           无 seed     │
│    └─ fork-in-process   name=fork   inheritsParentContext=true        │
│          start(req) → startInProcessRun(req, {seed})  seed=已完成轮次  │
│  （进程外：out-of-process.js 词汇已就绪，无 provider 安装）             │
└───────────────────────────────────────────────────────────────────────┘
                     ↓ 复用宿主能力
┌─ 宿主层 ──────────────────────────────────────────────────────────────┐
│  ctx.agents   工厂：create({sessionId,meta,seed,agentOptions,signal,  │
│                            setup}) / resume({resumeSessionId,...}) /  │
│                     get(id) → Agent      AgentHandle: {agent,dispose}  │
│  Agent        followup(msg)  steer(msg)  inject(msg)                  │
│               cancel(cause,{keepInbox})  whenIdle()  status  session  │
│  ctx.sessions live store │ sessionPersistence(jsonl) │ sessionProjections │
│  ctx.jobs     one-shot 后台 Task（jobs-local: 每 owner 上限 10）       │
│  dsh-agent-loop  滚动池 maxParallelToolCalls（默认 10）                │
│  dsh-tool-call-timeout-policy  只对声明 timeoutMs 的工具生效           │
└───────────────────────────────────────────────────────────────────────┘
```

### 1.2 调用链 A：`subagent`（可继续，默认走后台）

```
LLM 发出 subagent 工具调用
└─ dsh-tool-subagent/lib/index.js:219 execute(args, exec)
   ├─ const parent = exec.agent
   ├─ request = { label:args.description, prompt:[{type:'text',text:args.prompt}],
   │              parent, agentOptions?, persona?, toolFilter?, maxDepth? }
   └─ resolveDelegationRun(args,{backgroundEnabled,continuable})
      backgroundMode=continuable ⇒ run_in_background ?? true = true
      └─ ctx.subagents.startContinuable({ provider, label, request, signal:exec.signal })
         └─ dsh-subagent/lib/index.js:2420 SubagentRuntime.startContinuable
            └─ requireContinuations() → SubagentContinuationManager.startContinuable  (771)
               ├─ assertAdmitting(parent)                 ← drain 期间拒绝准入
               ├─ requirePersistence()                    ← 无 sessionPersistence 直接响亮失败
               ├─ assertSubagentMaxDepth / resolveChildDepth（父深度+1）
               ├─ childId = SessionId(randomUUID())
               ├─ assertChildIdAvailable(childId)          ← 已在 agents/sessions 中 → DUPLICATE_CHILD
               ├─ snapshotSubagentDescriptor({mode:'continuable',provider,label,
               │      agentProvider,agentModel,persona?,toolFilter?})
               ├─ captureDelegatedPolicyOverrides(parent)
               ├─ host.prepareContinuable(provider, {sessionId,parent,signal})
               │    └─ provider.prepareContinuable  → spawn:{}  /  fork:{seed}
               ├─ seedDescriptorTurn(childId, prepared.seed, descriptor)
               │    = Session.create(childId, seed).append('subagent/descriptor')
               └─ locks.run(childId, …)                    ← ChildLock 按 childId 串行化
                  ├─ assertChildIdAvailable（二次，防持久化重复）
                  ├─ materialize({childId,provider,parent,create:{seed,meta,
                  │              delegatedPolicies},agentOptions,composition,signal})  (1206)
                  │   ├─ 注册到 materializations（drain barrier）
                  │   ├─ setup = childCtx => {
                  │   │      appendDelegatedPolicyOverrides(childCtx.agent.session, …)
                  │   │      applyChildComposition(childCtx, parent, composition)
                  │   │      return setupRegistry.apply(childCtx)   // report 等贡献
                  │   │   }
                  │   ├─ ownerCtx.agents.create({sessionId, meta, seed,
                  │   │        agentOptions, signal, setup})       ← 私有 activation-owner scope
                  │   ├─ activations.set(childId, activation)
                  │   ├─ acquireOwnership(parent, childId)          ← 父的 ownedChildren 先登记
                  │   ├─ on('agent/inbox/claimed'|'discarded') → accepted.delete + wake
                  │   └─ observer.start(agent) → emit('subagent/start')
                  ├─ watchSettlement(activation)                     ← 异步驻留看护
                  └─ submitMaterialized → submitAdmitted → submit → admitWaking
                     ├─ activation.accepted.add(messageId)（同步）
                     ├─ handle.agent.followup(createUserMessage(content,source))
                     └─ 返回 messageId
工具返回 { kind:'continuable', subagentId } → 渲染 "started subagent <childId>"
```

### 1.3 调用链 B：`subagent_fork`（一次性，默认前台）

```
dsh-tool-subagent execute → backgroundMode=one-shot 且 run_in_background 缺省 ⇒ false
└─ settleForegroundRun(await ctx.subagents.start('fork', {...request, signal:exec.signal}))
   └─ SubagentRuntime.start  (2607)
      ├─ expectProvider('fork') / assertCapabilities(provider, request)
      ├─ assertObjectJsonSchema(request.outputSchema)（若要求结构化输出）
      ├─ descriptor = snapshotSubagentDescriptor({mode:'one-shot',provider,label})
      ├─ provider.start({...request, descriptor})
      │   └─ fork-in-process/lib/index.js:46
      │      const seed = completedTurnPrefix(request.parent)   // 到最后一个 turn/end
      │      return startInProcessRun(request, { ...seed.length ? {seed} : {} })
      │         └─ in-process-driver/lib/index.js:160
      │            ├─ assertSubagentMaxDepth / resolveChildDepth / childId=randomUUID
      │            ├─ inherited = captureDelegatedPolicyOverrides(parent)
      │            ├─ setup = childCtx => { appendDelegatedPolicyOverrides;
      │            │     applyChildComposition; attachStructuredRuntime?(schema);
      │            │     attachDescriptorAppend(childCtx, descriptor) }
      │            ├─ parent.ctx.agents.create({sessionId, meta, seed?, agentOptions,
      │            │      signal, setup})            ← 直接父 ctx，不是 ownerCtx
      │            └─ drivePublishedRun(handle, signal, prompt, childId, boundary, structured)
      │               ├─ onAbort → child.cancel({kind:'parent'})（先装监听、再复查 signal.aborted）
      │               ├─ result = (async () => {
      │               │     child.followup(createUserMessage({content:prompt,
      │               │                              source:{kind:'user'}}))
      │               │     await child.whenIdle()           ← 只驱动「一项任务」
      │               │     return readResult(child, boundary, cancelled, structured?)
      │               │   })()
      │               └─ return { id, localAgent, result, dispose() }
      └─ observeRun(emit, 'fork', parent, run)     ← 挂 result.then → subagent/end；再 emit start
   └─ 工具侧：await run.result → 非 completed 抛错 → **总是** await run.dispose()
```

### 1.4 三个 driver 的差别（一句话版）

| 包 | 角色 | 关键差异 | 证据 |
|---|---|---|---|
| `dsh-subagent-in-process-driver` | **共享运行驱动**（不注册 provider） | 深度校验、创建事务、persona/toolFilter/结构化输出安装、结果读取、取消、dispose 全在此一处实现 | `lib/index.js:160 startInProcessRun`；`README.zh.md:5`「其余机制……都在此共用同一套实现」 |
| `dsh-subagent-spawn-in-process` | provider，`name=spawn` | `start(req)` → `startInProcessRun(req, {})`，**不传 seed**；`inheritsParentContext=false`；`prepareContinuable()` 返回 `{}` | `lib/index.js:33-38` |
| `dsh-subagent-fork-in-process` | provider，`name=fork` | `start(req)` → 先算 `completedTurnPrefix(parent)` 再 `startInProcessRun(req,{seed})`；`inheritsParentContext=true`；`prepareContinuable` 同样返回 seed | `lib/index.js:23-53` |

两者的 `capabilities` 完全一致：

```js
// dsh-subagent-fork-in-process/lib/index.js:35-42（spawn 同形，见 :23-29）
capabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true };
inheritsParentContext = true;   // spawn 处为 false
```

> **注意**：`inheritsParentContext` 只用于**描述**（决定工具描述文案），不构成强制执行。
> `dsh-subagent/lib/index.js:58`：「`inheritsParentContext` 只用于描述，不能强制执行。它仅说明子 agent 是否能看到父级已完成的对话历史（`fork` 可以；`spawn` 和各进程外一次性提供方不可以），不表示是否继承工具、服务或权限。」

> **本机部署事实**：`dsh-base/cordis.patch.yml:292-333` 只加载了 `spawn` 与 `fork`；`subagent_fork` 被显式配置为 `backgroundMode: one-shot`（理由见 §2.2 尾部）。`dsh-workflow-worker-thread` 也以 `provider: spawn` 消费同一 seam（:335-338），是第四个消费者。

---

## 2. 八个问题逐条

### 2.1 子 agent 如何创建

见 §1.2 / §1.3 的完整调用链。补充要点：

1. **提供方选择在插件加载期完成，模型看不到选择器**。
   `dsh-tool-subagent/lib/index.js:137` 的 `mount(provider)` 只接受 `provider.name === config.provider` 的那个 provider；每个实例绑定一个 `provider` + 一个 `toolName`，要换传输就再挂一个不同名的实例。第 278–288 行用 `subagent/provider-added` / `provider-removed` 事件做延迟挂载/卸载，**刻意不依赖同级插件加载顺序**（源码注释：`else ctx.logger.info(...) tool will register when it appears`）。

2. **能力校验发生在创建子 agent 之前，且失败是拒绝而非"接受后忽略"**。
   ```js
   // dsh-subagent/lib/index.js:2652
   assertCapabilities(provider, request) {
     const needs = [
       { when: request.outputSchema !== void 0, cap: "outputSchema" },
       { when: request.maxDepth    !== void 0, cap: "depthLimit"   },
       { when: request.toolFilter  !== void 0, cap: "toolFilter"   },
       { when: request.persona     !== void 0, cap: "persona"      },
     ];
     for (const { when, cap } of needs)
       if (when && !provider.capabilities[cap])
         throw new SubagentError(`subagent provider "${provider.name}" does not support the "${cap}" capability`, "UNSUPPORTED_CAPABILITY");
   }
   ```
   工具侧还有一道"挂载即失败"的静态检查（`dsh-tool-subagent/lib/index.js:138`）：provider 无 `depthLimit` 能力却配了数值 `maxDepth` → 直接抛错并提示改 `'provider-managed'`。

3. **`prepareContinuable` 的"方法存在性即能力"**（`dsh-subagent/lib/index.js:2628`）：
   ```js
   async prepareContinuable(name, request) {
     const provider = this.expectProvider(name);
     if (provider.prepareContinuable === void 0)
       throw new SubagentError(`... does not support continuable children (no prepareContinuable capability)`, "UNSUPPORTED_CAPABILITY");
     return provider.prepareContinuable(request);
   }
   ```
   它只返回**纯数据** `{ seed? }` —— 不含 Agent、AgentHandle、提示词投递、结果或 dispose 操作。创建后的一切（身份预留、组合、Agent 创建、投递、冷恢复、所有权、dispose）都由 continuation manager 负责。

4. **两种 mode 的创建路径不同，这是最值得注意的结构决定**：
   - 一次性：`start()` → provider 拥有"从发布到完全停稳"的隔离子 agent 生命周期；发布即所有权转移（`startInProcessRun` 的 `await agents.create(...)` 兑现后 handle 归调用方）。
   - 可继续：**完全不经过 provider 的 start**。manager 直接 `ownerCtx.agents.create(...)`（冷恢复用 `ownerCtx.agents.resume(...)`），provider 只贡献 detached spec。源码注释（`dsh-subagent/lib/index.js:1140`）：「冷恢复绝不通过提供方分发，因为持久化会话已持有初始前缀，折叠后的描述符即是全部重建输入。」

5. **发布语义是"创建即发布"**：`startInProcessRun` 只在子 agent 发布到 `ctx.agents` 后才兑现；启动被拒绝时，agent 工厂的**未发布创建事务**已完全停稳，调用方绝不会拿到创建到一半的句柄。

---

### 2.2 上下文传递：`subagent` vs `subagent_fork`

#### 差异的**全部**来源是一个字段：`seed`

```js
// dsh-subagent-fork-in-process/lib/index.js:23-28
function completedTurnPrefix(parent) {
  const events = parent.session.events;
  const lastEnd = events.findLast((e) => e.type === "turn/end");
  if (lastEnd === void 0) return [];
  return events.slice(0, lastEnd.seq + 1);
}
// :46-49
start(request) {
  const seed = completedTurnPrefix(request.parent);
  return startInProcessRun(request, { ...seed.length > 0 ? { seed } : {} });
}
```

```js
// dsh-subagent-spawn-in-process/lib/index.js:33-35
start(request) {
  return startInProcessRun(request, {});   // 没有 seed
}
```

#### 子 agent 到底收到什么（逐项）

| 项 | spawn | fork | 证据 |
|---|---|---|---|
| 自己的 Session（独立 id、独立日志） | ✅ 全新 | ✅ 全新 | `agents.create({sessionId: childId, ...})` |
| 父级已完成对话历史 | ❌ 无 | ✅ 截至最后一个 `turn/end` 的连续前缀（seq 从 0 起） | `completedTurnPrefix` |
| 父级**进行中**的轮次 | ❌ | ❌ **显式排除** | 同上；README：该轮次"不平衡，无法作为有效子会话重放" |
| 任务描述（prompt） | ✅ 第一条 user message，**逐字** | ✅ 追加在 seed 之后 | `child.followup(createUserMessage({content: prompt, source:{kind:'user'}}))` |
| 系统提示词 | 全局提示词 + 子级作用域遮蔽 | 同左 | `applyChildComposition` |
| 父级 agent-preset 组合 | ✅ 加入（决定工具 schema 与提示段） | ✅ 加入 | `childCtx.get("agentPresets")?.composeFrom(childCtx, parent.ctx)` |
| 工具集 | 全局层按 preset 解析；`toolFilter` 只做全局层限制 | 同左 | `childCtx.tools.restrict(composition.toolFilter)` |
| 父级工具限制 / 权限子集 | ❌ **不继承**（"全新的扁平注册作用域"） | ❌ 同左 | driver README :19 |
| cwd / 工作区 | ✅ 继承父 `header.cwd` | ✅ 同左 | `childSessionMeta` |
| provider / model / maxTokens | ✅ 默认继承父级，`request.agentOptions` 可覆盖 | ✅ 同左 | `resolveChildAgentOptions` |
| 沙箱策略 | ✅ 仅继承父 session 的**显式 override** | ✅ 同左 | `captureDelegatedPolicyOverrides` |
| 审批策略 | ✅ 钉死 `'never'` | ✅ 同左 | 同上 |
| 委派深度 | `父深度 + 1` 写入 header | ✅ 同左 | `resolveChildDepth` / `childSessionMeta` |
| `report` 工具 + `tool:report` 提示段 | ✅（仅当该子级是 **continuable**） | ❌（本机 fork 被配成 one-shot，故不装） | `setupRegistry.apply(childCtx)` |

#### 子 agent 收到的"位置感"文案

```js
// dsh-subagent/lib/index.js:547
const SUBAGENT_DELEGATION_CONTEXT =
  "You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.";
// :570 applyChildComposition
childCtx.systemPrompt.context({ name: "subagent:delegation", order: 120, text: SUBAGENT_DELEGATION_CONTEXT });
```
注意它是 **runtime context contribution**，不是普通 system prompt section —— 源码注释：`"A runtime-context contribution rather than a system-prompt section, so the deployment's system prompt stays uniform across parents and children."`（保持父/子系统提示词一致，利于 KV 前缀复用。）

#### 如何避免上下文爆炸（7 条机制）

1. **spawn 根本不复制父历史** —— 最便宜的传输。
2. **fork 只复制"平衡的已完成轮次前缀"**，排除 in-flight 轮次。父级还没完成任何轮次时 seed 为空，子级行为等同全新 spawn。
3. **子级只回传"最后一条非空 assistant message"**：
   ```js
   // dsh-subagent/lib/index.js:115
   function finalAssistantOutput(events) {
     const fold = new AssistantOutputFold();
     for (const event of events) fold.push(event);
     return fold.collect();
   }
   // :101 collect() —— 若没有非空 assistant 消息，退化为累计的流式文本
   ```
   中间工具调用、推理、失败重试全部留在子会话，父级不付 token。
4. **结果读取用 boundary 切片，绝不把 seed 算成子级输出**：
   ```js
   // dsh-subagent-in-process-driver/lib/index.js:167 / 228
   const activationBoundary = seed?.length ?? 0;
   function readResult(child, boundary, cancelled, structured) {
     const own = child.session.events.slice(boundary);
     const lastEnd = foldConsumedWork(own).end;
     const output = finalAssistantOutput(own) ?? [];
   ```
5. **持久化描述符不进模型历史**。`subagent/descriptor` 是 log-only 事件：`dsh-session/lib/index.js:229` 的 `isSurfaceEligibleType()` 只认 `user/message`、`assistant/message`、`tool/result` 三种；`deriveEventMessage`（:278）对其它类型一律返回 `null`。所以 fork 子级历史里即便含父级 descriptor，也不会成为模型消息。
6. **provider 诊断文本与 output 分离，且有硬上限**：
   ```js
   // dsh-subagent/lib/index.js:2113-2129
   const MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4096;
   const DIAGNOSTIC_TRUNCATION_SUFFIX = "\n[diagnostic truncated]";
   function limitSubagentDiagnostic(diagnostic) {
     const bytes = utf8Encoder.encode(diagnostic);
     if (bytes.byteLength <= MAX_SUBAGENT_DIAGNOSTIC_BYTES) return diagnostic;
     let prefixBytes = MAX_SUBAGENT_DIAGNOSTIC_BYTES - utf8Encoder.encode(DIAGNOSTIC_TRUNCATION_SUFFIX).byteLength;
     while ((bytes[prefixBytes] & 192) === 128) prefixBytes -= 1;   // 不切碎 UTF-8 序列
     return utf8Decoder.decode(bytes.subarray(0, prefixBytes)) + DIAGNOSTIC_TRUNCATION_SUFFIX;
   }
   ```
   且 `diagnostic` **不是** assistant 输出 —— 消费方单独呈现，不会进入 `subagent/end.lastAssistantMessage`。
7. **fork 刻意保持 one-shot**（KV 前缀复用优先）：
   `dsh-base/cordis.patch.yml:320-329` 注释：可继续子级还要额外携带作用域局部的 `report` 工具及其提示词 section，**这些增量位于继承历史之前，会使继承历史整体失效**。所以 `subagent_fork` 被配成 `one-shot`，牺牲可继续能力换取 fork 的逐字节相同前缀。

---

### 2.3 生命周期与状态

#### 两套形态，两套生命周期对象

**（A）一次性 `SubagentRun`** —— 一次可 dispose 的前台委派，只有一个结果，没有冷恢复操作：
```js
// dsh-subagent-in-process-driver/lib/index.js:215-225
return {
  id: childId,
  localAgent: child,
  result,                      // Promise<{output, structured?, diagnostic?, stopReason}>
  async dispose() {
    signal.removeEventListener("abort", onAbort);
    flags.cancelled = true;
    const disposal = (await Promise.allSettled([handle.dispose(), result]))[0];
    if (disposal.status === "rejected") throw disposal.reason;
  },
};
```

**（B）可继续 Activation** —— 一个持久 Session + 至多一个进程内驻留时段：
```js
// dsh-subagent/lib/index.js:1247-1259
const activation = {
  childId,
  parentSession: parent.id,
  provider,
  handle,                                   // AgentHandle
  ancestry: new WeakSet([handle.agent, ...parentLineage]),
  ownedChildren: new Set(),                 // 子先于父的等待图
  observer,                                 // 生命周期观察器
  disposal: undefined,                      // 幂等拆卸事务（memoized）
  accepted: new Set(),                      // 已准入但未见 drain 的 inbox message id
  announced: false,                         // 是否已向调用方返回过 id（决定通知是否静默）
  poke: Promise.withResolvers(),            // 结算看护的唤醒信号
};
```

#### 状态存在哪

| 存储 | 内容 | 证据 |
|---|---|---|
| **进程内存（唯一权威，不持久化）** | `manager.activations: Map<childId, Activation>` —— 注释明写 `"Process-local, never durable"` | `dsh-subagent/lib/index.js:727-728` |
| 进程内存 | `providers: Map<name, provider>`；`materializations: Set`（drain barrier）；`locks: ChildLock.tails: Map`；`closingScopes: Map`；`draining: boolean` | `:2382` / `:730` / `:731` / `:740` / `:741` |
| **持久化（子 Session 日志）** | `subagent/descriptor` 事件（version 2），是身份的权威记录 | `:328-452` |
| 持久化（SessionHeader） | `parentSession`、`origin:'subagent'`、`delegationDepth`、`seedLength`、`cwd`、`createdAt`、`agentPreset` | `childSessionMeta` `:530-541` |
| 派生（投影） | `subagentTiming`（活跃时长）、`subagent`（mode/label 身份，**last-wins，在 descriptor 处 reset**） | `:1978` / `:2084` |

#### 内部驻留状态机：刻意只有三态，且不维护计数器

```js
// dsh-subagent/lib/index.js:1132
stateOf(activation) {
  if (activation.handle.agent.status === "running" || activation.accepted.size > 0) return "running";
  if (activation.ownedChildren.size > 0) return "waiting";
  return "settled";
}
```
源码注释点明为何不能只看 `Agent.status`：它会在"已接受的唤醒发送"与"准入该消息的 microtask"之间**停留在 `idle`**，同步的 inbox 观察者会看到 `settled` 而实际已有轮次排队。`activation.accepted` 就是这个窗口的补偿记账。

**三态语义**：`running` = 有正在进行的准入 / 未结束轮次 / 会唤醒的 inbox 工作；`waiting` = Agent 已完全停稳但仍拥有未 dispose 的子级；`settled` = 完全停稳且所有子级已 dispose → manager dispose `AgentHandle` 并移除 Activation。

#### 模型可见状态（`list_agents` 的三态，**不能与内部三态混为一谈**）

```js
// dsh-tool-subagent-control/lib/types/list-agents.js:24-29
function statusOf(agents, id) {
  const agent = agents.get(id);
  if (agent === undefined) return 'ready';
  return agent.status === 'running' ? 'running' : 'idle';
}
```
- `running`（driver 活跃）/ `idle`（驻留但处于轮次之间，可能在等它启动的 agent）/ `ready`（**仅存于存储**，可恢复而非终态）。
- 诊断态：`corrupt` / `unsupported` / `unavailable`（`list-agents.js:96`）。
- 映射关系：内部 `settled` ⇄ 模型 `ready`（但仅当该 child 仍是 continuable）；内部 `waiting` ⇄ 模型 `idle`。README 特别强调 `ready`「可恢复而非终态，也不表示有结果等待收集」。

#### 父 agent 如何感知子 agent 状态（5 条通道）

1. **结算通知**（主力，见 §2.5）。
2. **生命周期事件**：`subagent/start` / `subagent/end` 成对，共享服务生成的 `runId`，按委派父级做 scope-filtered dispatch：
   ```js
   // dsh-subagent/lib/index.js:192-197
   const identity = { runId: SubagentRunId(randomUUID()), provider, id: run.id,
                      local: run.localAgent !== void 0 };
   ```
   `dsh-tool-cordis/lib/index.js:4232` 描述：「`ctx.agents.get(info.id)` 在该通知期间可解析……父级作用域的监听器只观察自己的委派」。监听器**互相隔离**：同步抛错或返回的 promise 被拒绝只记日志，不阻塞同级监听器、不改变运行（`createLifecycleEmitter` `:166-182`）。
   注意 `local` 标志按 provider 返回的**确切** `localAgent` 是否存在快照（可继续子级恒为 true），不从可复用的 provider 名或会话名推断。
3. **`subagent/provider-added` / `subagent/provider-removed`**：因为 Cordis 可能并发加载同级插件，**配置顺序不能证明注册顺序**（`:98`）。
4. **`list_agents` 快照**（拉取式发现，不加载/不恢复子 agent）。
5. **子级的 `report`**（只有可继续子级装了这个工具）。

> 父级**收不到**子级的中间步骤、工具输出、推理过程。`prompt` 里反复强调这一点，并把它写进了子级的 `report` 工具描述：「The agent that started you shares your workspace but does not automatically receive your transcript, tool output, or reasoning.」

---

### 2.4 并发控制

#### 结论：**子 agent seam 本身没有并发上限**

`dsh-subagent/README.zh.md:48`：「服务可以针对不同的同级子 agent 并发调用同一提供方……**提供方可以在内部按自身容量排队**，但不得改变这项独立性约定。」代码中没有任何 semaphore / 队列 / 计数器限制并发启动数。

#### 但有 4 个来自外层的实际限流点

| # | 限制 | 默认值 | 作用域 | 证据 |
|---|---|---|---|---|
| 1 | `maxParallelToolCalls`（agent loop 滚动池） | **10** | 一条 assistant message 内所有工具调用 | `dsh-agent-loop/lib/index.js:919-921`、`:230` |
| 2 | `maxConcurrentJobsPerOwner` | **10** | 只约束 **one-shot 后台 Task** | `dsh-jobs-local/lib/index.js:77`、`:137` |
| 3 | `maxDepth` | **3**（`0` 禁止委派） | 委派深度预算 | `dsh-tool-subagent/lib/index.js:37` |
| 4 | `COLD_READ_CONCURRENCY` | **4** | `listChildren`/`listDescendants` 的冷候选并发 inspect | `dsh-subagent/lib/index.js:1697` |

**（1）工具并行池** —— `subagent` 工具声明了 `isConcurrencySafe: () => true`（`dsh-tool-subagent/lib/index.js:218`），因此进入并行池：
```js
// dsh-tools/lib/index.js:2940-2947
executionMode(exec) {
  const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
  if (!tool?.isConcurrencySafe) return { kind: "exclusive" };
  try { return tool.isConcurrencySafe(exec.arguments) === true ? { kind: "parallel" } : { kind: "exclusive" }; }
  catch { return { kind: "exclusive" }; }        // fail-closed
}
```
```js
// dsh-agent-loop/lib/index.js:229-239
const fillPool = async () => {
  while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {
    const nextCall = group[nextToStart];
    if (nextToStart > 0 && mode === "parallel" && ctx.tools.executionMode(nextCall.exec).kind !== "parallel") break;
    await startCall(nextToStart); nextToStart++;
    ... await commitReady(); ...
  }
};
```
结果**按模型顺序提交**（`slots[committed]`），所以并行执行不改变模型看到的结果顺序。README 也说明：同一条 assistant 消息中的兄弟委派会重叠执行（`dsh-tool-subagent/README.zh.md:32`），并援引 [并行 subagent Agent Note]。**协调兄弟间的工作区效果由模型负责** —— seam 不做工作区隔离或锁。

**（2）后台 Task 的每 owner 上限**：
```js
// dsh-jobs-local/lib/index.js:137
if (this.activeTaskCount(spec.owner) >= this.maxConcurrentJobsPerOwner)
  throw new Error(`background job limit reached for this owner (limit: ${this.maxConcurrentJobsPerOwner}); use job_kill to stop an unneeded job, wait for it to finish, then retry`);
```
超限是**同步抛错**（`ctx.jobs.start` 在调用方 `run()` 之前失败），在工具里变成出错的 tool result。注意这**只影响 one-shot 后台**；`backgroundMode: continuable` 路径不注册 Task，所以不受此限制。

**（3）深度预算**：
```js
// dsh-subagent/lib/index.js:43-53
function delegationDepthOf(agent) {
  const runtime = agent.options.subagentDepth;
  if (runtime !== void 0 && (!Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0)))
    throw new TypeError("agent subagentDepth must be a non-negative safe integer");
  return Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0);   // header 是单调下界
}
function resolveChildDepth(parent, maxDepth) {
  const childDepth = delegationDepthOf(parent) + 1;
  if (!Number.isSafeInteger(childDepth)) throw new RangeError("subagent child depth exceeds the safe-integer range");
  if (maxDepth !== void 0 && childDepth > maxDepth) throw new SubagentDepthError(childDepth, maxDepth);
  return childDepth;
}
```
README 说明工具在达到上限时**仍然可见**，每次尝试启动才检查当前深度（`dsh-tool-subagent/README.zh.md:28`）—— 即不靠隐藏工具来限制，而是每次调用都判。

**（4）列表冷读并发**：`resolveCandidateRows` 用固定宽度 worker 池消费队列（`dsh-subagent/lib/index.js:1813-1818`），注释说明这是「bound one read-only scan of local media, not deployment behavior」，若出现网络持久化后端应提升为 Config 字段。

#### 串行化（不是限流，但同样重要）

```js
// dsh-subagent/lib/index.js:699-716
var ChildLock = class {
  tails = new Map();
  run(childId, operation) {
    const result = (this.tails.get(childId) ?? Promise.resolve()).then(operation, operation);
    const tail = result.then(() => void 0, () => void 0);
    this.tails.set(childId, tail);
    tail.then(() => { if (this.tails.get(childId) === tail) this.tails.delete(childId); });
    return result;
  }
};
```
每个 `childId` 的投递 / 释放 / 拆卸被线性化。注意 `.then(operation, operation)` —— 前一个操作即使失败也继续排队，避免一次失败饿死后续操作。尾部条目在无后继时自清理（防 Map 泄漏）。

另一个"串行化"是 **drain barrier**：`materializations: Set` 记录所有已准入但尚未发布或回滚的物化过程，`drain()` 先等它们全部 settle，再处理 Activation 森林（`dsh-subagent/lib/index.js:997-1004`）。

#### 没有的东西（诚实标注）

- **没有子 agent 队列上限**：Agent inbox 是唯一 FIFO 队列，本身无限。
- **前台调用无超时**：`subagent` 工具没有声明 `timeoutMs`，`dsh-tool-call-timeout-policy` 不生效（见 §2.7）。
- **没有跨进程协调**：README 已知限制 —— 「驻留仅限进程内：Activation inbox 与所有权图不会在两个 harness 进程之间协调」。

---

### 2.5 结果回流

**关键：这里有三条互不相同的通道，混用会设计错。**

#### 通道 1：前台一次性 run → 同步返回

```js
// dsh-tool-subagent/lib/index.js:82-99
async function settleForegroundRun(run) {
  const [execution] = await Promise.allSettled([run.result.then((result) => {
    const error = stopReasonError(result);
    if (error !== void 0) throw new Error(withDiagnosticAndPartialText(error, result));
    return { kind: "foreground", runId: run.id, output: result.output };
  })]);
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
  if (execution.status === "rejected") {
    if (disposal.status === "rejected")
      throw new AggregateError([execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`);
    throw execution.reason;
  }
  if (disposal.status === "rejected") throw disposal.reason;
  return execution.value;
}
```
- 只有 `completed` 返回 `{kind:'foreground', runId, output}`，渲染为子级最终文本。
- 其它 stopReason 变成 `Error: <终止原因标题>` + `\nDiagnostic: ...`（若有）+ `\nPartial output before the run ended:\n<部分文本>`。诊断与 `output` **保持分离**，所以"被截断的回答不会被报告为成功"。
- **无论成败都 dispose**，且结果失败与 dispose 失败**两项都保留**（AggregateError）。
- `stopReasonError` 的完整词表（`:55-64`）：`aborted` → "subagent run was cancelled"；`error` → "subagent run failed"；`max-tokens` → "…hit its token limit before finishing"；`refusal` → "subagent declined the task"。

#### 通道 2：一次性后台 Task → job 回落

```js
// dsh-tool-subagent/lib/index.js:248-269
const jobs = ctx.get("jobs");
if (jobs === void 0) throw new Error("background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
return { kind: "background", jobId: jobs.start({
  kind: "subagent", label: args.description, owner: parent,
  run: () => {
    const controller = new AbortController();
    return {
      cancel: (reason) => { controller.abort(reason ?? "background subagent task killed"); },
      done: settleStart(ctx.subagents.start(config.provider, { ...request, signal: controller.signal }), controller.signal),
    };
  },
}) };
```
返回 `started background subagent job <id>`；后续用通用 `job_output` / `job_kill`。完成通知由 **`dsh-tool-jobs`** 统一发出（不是 subagent 包）：
```js
// dsh-tool-jobs/lib/index.js:206-227
ctx.jobs.onJobDone((snapshot, owner) => {
  if (snapshot.reported || owner === void 0) return;
  const message = createUserMessage({ content:[{type:"text", text: fitCompletionNotice(snapshot)}],
    source: { kind:"plugin", plugin:"tool-jobs", form:"notice", summary: completionSummary(snapshot) } });
  const spent = spentWakes.get(owner) ?? 0;
  if (delivery === "wakeup" && owner.status === "idle" && spent < wakeBudget) {   // wakeBudget 默认 3
    spentWakes.set(owner, spent + 1); owner.followup(message); return;
  }
  owner.inject(message);
});
```
`runOutcome` / `settleRun`（`dsh-subagent/lib/index.js:2301-2345`）把子结果映射成 task 结局：`completed` → 带最终文本；`aborted` → `killed`；其余一律 `failed`，detail 里拼上 provider 诊断。

#### 通道 3：可继续子 agent → **结算通知**（本架构最核心的机制）

工具立即返回 `{kind:'continuable', subagentId}` → `started subagent <childId>`。**没有 Task、没有结果 promise**。结果靠管理器主动投递：

```js
// dsh-subagent/lib/index.js:1488-1523
notifySettlement(activation, terminal) {
  if (!activation.announced) return;                        // ① 未返回过 id 的物化保持静默
  try {
    const parent = this.ctx.agents.get(activation.parentSession);
    if (parent === void 0) return;                          // ② 父级已离开注册表：丢弃，不算错误
    const summary = settlementSummary(activation.childId, terminal.stopReason);
    const message = createUserMessage({
      content: [{ type: "text", text: summary },
        ...terminal.output === void 0
          ? [{ type: "text", text: "It left no closing message." }]
          : [{ type: "text", text: "Its closing message:" }, ...terminal.output]],
      source: { kind: "subagent-settled", form: "notice",
                summary: boundContextSummary(summary), senderSessionId: activation.childId },
    });
    if (this.closingTeardownFor(parent) !== void 0) { parent.inject(message); return; }   // ③ 谱系已排空：不唤醒
    this.sendWaking(parent, message, () => {
      if (parent.status === "idle") parent.followup(message);
      else parent.steer(message);
    });
  } catch (error) {
    this.ctx.logger.warn(`subagent "${activation.childId}" settlement notice was not delivered to its parent: ` + errorChain(error));
  }
}
```

`settlementSummary` 的完整措辞表（`:684-697`）：
```js
case "completed":  return `${subject} finished and will do no further work unless you send it more.`;
case "aborted":    return `${subject} was stopped before it finished.`;
case "max-tokens": return `${subject} ran out of room before it finished.`;
case "refusal":    return `${subject} declined the task.`;
case "error":      return `${subject} failed before it finished.`;
default:           return `${subject} ended abnormally (${String(stopReason)}) before it finished.`;
```

**为什么这段逻辑必须归管理器、而不能写成外部 `subagent/end` listener**（源码 `:659-663` 与 README 都讲得很明确）：

- 外部 listener 的 payload **不携带父级**；
- 到那时**子级 handle 已经被 dispose**；
- 而且"唤醒父级自己结算 watcher"的那次 release **已经跑过了**。

**两条让投递可靠而非侥幸的顺序规则**：

1. **发送发生在子级所有权释放之前** —— `finishDisposal` 里顺序是 `this.activations.delete(childId); this.notifySettlement(...); this.releaseOwnership(childId);`（`:1464-1466`）。此时父级仍然把该子级计入 `ownedChildren`，因此父级在**结构上不可能**被判定为 `settled`。
2. **父级本身也是驻留 Activation 时，用与 report 相同的唤醒准入记账** —— `sendWaking` → `admitWaking(parentActivation, message.id, send)`，先登记 id 再发送。这样"从同步发送到负责准入的 microtask 运行"之间的窗口不会被误判为完全停稳（因为 `Agent.status` 会把上下文维护折叠成 `idle`）。

**无条件投递**（不管子级有没有 `report` 过）的理由，README 写得很好：最需要说明结局的终止情形 —— 达到 token 上限、模型失败、取消、拆卸 —— **恰恰是子级根本没有机会选择的那些情形**。

**投递失败绝不阻塞拆卸**（`:1482-1484`）：「retaining a child to retry a notice would pin its whole ancestry in `waiting` forever.」

#### `dsh-tool-subagent-report` 到底干什么

它是**子 → 父的主动上报通道**，不是结果回流的必需品，而是**可选的方向性通信**。

```js
// dsh-tool-subagent-report/lib/index.js:29-34
function installReportTool(childCtx, ctx, delivery) {
  const disposeSection = childCtx.systemPrompt.section({
    name: "tool:report", order: 117,
    text: "Deliver your result with the report tool before you finish: call it once with a self-contained answer. The agent that started you shares your workspace but does not automatically receive your transcript, tool output, or reasoning, so a closing remark such as \"done\" leaves it nothing it can use. Report earlier as well whenever a partial finding changes what that agent should do next; reporting never ends your turn.",
  });
  ...
}
// :93-96 注册为「可继续子级贡献」，而不是全局工具
function apply(ctx, config = {}) {
  const { reportDelivery } = Config(config);
  ctx.subagents.registerContinuableSetup((childCtx) => installReportTool(childCtx, ctx, reportDelivery));
}
```

要点：
1. **作用域而非全局**：通过 `registerContinuableSetup` 装进每个可继续进程内子级的**未发布作用域**。因此**根 agent、一次性子级、远程 provider、兄弟作用域、无 agent 的工具执行都拿不到它**。
2. **不接受接收方参数**：`report` 只有 `output: string`。`exec.agent` 既是发送方也是**权限凭据**；服务从子级持久化 `parentSession` 推导唯一接收方（`resolveReportParent` `:939-945`）。
3. **投递策略是部署策略**：`reportDelivery: 'next-step'（默认）| 'quiet'`，面向模型的 schema 不能在单次调用中选择或覆盖。
4. **刻意不受子级 `toolFilter` 影响**（作用域局部注册优先于全局层过滤）：「委派允许列表无法移除唯一的返回通道」（README:11）。要禁用就整包不加载。
5. **调用成功 ≠ 已读**：只返回父级已接受消息的稳定 MessageId。README 明确列举它**不**代表：已读回执、inbox 中该次出现的 id、父级日志确认、轮次完成回执、持久化刷盘。而且**失败的调用也可能已经送达**（`tools/post-execute` 否决可能让已被接受的调用以失败结束）。
6. **不结束轮次、不结算 Activation、不阻止父级后续消息**；轮次结束也绝不自动上报。
7. `installReportTool` 单独导出，供检查类消费方（如工具目录生成）把 `report` 装进新创建的子级作用域并拿到同时撤销两者的唯一 disposer。

---

### 2.6 控制能力

#### `dsh-tool-subagent-control` 提供的工具

| 工具 | 位置 | 参数 | 底层调用 |
|---|---|---|---|
| `send_message` | 根插件 `lib/index.js:21-66` | `subagent_id`（必填）、`message`（必填） | `ctx.subagents.followup(parent, SessionId(subagent_id), message, {source, signal})` |
| `interrupt_agent` | 根插件 `lib/index.js:67-98` | `agent_id`（必填） | `ctx.subagents.interrupt(SessionId(agent_id), {kind:'ancestor', agent: caller})` |
| `list_agents` | 单独可加载的 `./list-agents`（`lib/types/list-agents.js:52`） | `scope?: 'children'\|'descendants'` | `ctx.subagents.listChildren()` / `listDescendants()` |

设计理由（源码模块注释 `:4-11`）：绑定 provider 的 `dsh-tool-subagent` 实例会为每种传输各注册一个委派工具；这个单独加载的包**只注册一次共享控制工具**，因此多个委派工具绝不会重复注册全局控制工具。`list_agents` 又可独立省略 —— 部署可保留投递能力但不暴露发现能力。

#### `send_message`：父 → 子

```js
// dsh-tool-subagent-control/lib/index.js:57-64
return { messageId: await ctx.subagents.followup(parent, SessionId(args.subagent_id), message, {
  source: { kind: "coordinator", form: "relay", senderSessionId: parent.id },
  signal: exec.signal,
}) };
```
- 把 `exec.agent` 作为「授权投递的**确切在线直接父级**」传入。工具自身**不做任何生命周期路由** —— 驻留、冷恢复、授权全在服务里。
- 消息成为子级的**下一个 FIFO 轮次**：如果子级仍在工作，消息会等它当前轮次结束，**无法重定向已经在进行的工作**。
- 调用**不返回子级的回答**，只返回 `messageId`；渲染 `message queued as the next turn for subagent <id>`。
- `source` 记录 `{kind:'coordinator', form:'relay', senderSessionId}` —— 服务**保留该来源，但绝不将其视为权限**。
- 工具转发的执行信号**只在 inbox 接受之前**掌管准入；一旦子级接受，已接受的轮次无法再通过本工具取消。
- 投递失败 → 出错的 tool result，明确说明"消息未送达"（`exec.signal` 转发 + `SubagentError` 传播）。

#### `interrupt_agent`：停当前轮次

```js
// dsh-tool-subagent-control/lib/index.js:89-97
execute(args, exec) {
  const caller = exec.agent;
  if (!caller) throw new Error("interrupt_agent requires a calling agent (exec.agent was undefined)");
  ctx.subagents.interrupt(SessionId(args.agent_id), { kind: "ancestor", agent: caller });
  return Promise.resolve({ accepted: true });
}
```
- **fire-and-return**：`{accepted:true}` + `interrupt requested for agent <id>`，不等待目标完全停稳（目标可能还会跑一小会儿）。不存在或已结算 → 被接受的 no-op，仍渲染接受行。
- 只停**当前轮次**：服务侧用 `cancel(cause, { keepInbox: true })`（`:908`）。因此已排队的 inbox 工作保留（暂停到之后的 `send_message`）、已发布的后代继续运行、child 本身仍可接受后续消息、Activation 与 handle 不受影响。
- **已经领取到被中断轮次中的工作不会重新入队。** 被中断 driver 进入 idle 后，一次唤醒型发送会恢复暂停的 FIFO 队列。

**授权（服务侧，`dsh-subagent/lib/index.js:896-909`）**：
```js
interrupt(targetSessionId, authority) {
  if (authority.kind === "ancestor") {
    const caller = authority.agent;
    if (this.ctx.agents.get(caller.id) !== caller)
      throw new SubagentError(`interrupting "${targetSessionId}" requires the exact live ancestor agent`, "UNAUTHORIZED");
    if (caller.id === targetSessionId)
      throw new SubagentError(`agent "${caller.id}" cannot interrupt itself`, "UNAUTHORIZED");
  }
  const activation = this.activations.get(targetSessionId);
  if (activation === void 0) return;                                   // 未知 id：接受的 no-op，不查持久目录
  if (authority.kind === "user") {
    if (activation.handle.agent.session.header.parentSession !== authority.parentSessionId)
      throw new SubagentError(`subagent "${targetSessionId}" belongs to another parent session`, "UNAUTHORIZED");
  } else if (!activation.ancestry.has(authority.agent))
    throw new SubagentError(`subagent "${targetSessionId}" is not a live descendant of agent "${authority.agent.id}"`, "UNAUTHORIZED");
  if (activation.disposal !== void 0) return;
  activation.handle.agent.cancel(authority.kind === "user" ? { kind: "user" } : { kind: "parent" }, { keepInbox: true });
}
```
要点：
- self / sibling / 陈旧 / 非 ancestor 调用方 → `UNAUTHORIZED`（工具侧变成出错结果）。
- **只检查在线身份与 lineage，不查持久目录** —— 源码注释说明这是为了让自然完成竞态、重复请求、一次性 id、未知 id 全部被同一条 no-op 路径统一覆盖，避免为 no-op 付一次 IO。
- **中断权限被刻意设计得比投递权限更宽**：`kind:'user'` 出示持久化直接 parent 地址时，**即使 parent Agent 离线，在线 child 仍可被停止**。理由：停止一个轮次是幂等的，且不投递任何内容。
- 反过来，"继续执行"**没有** host-user 通道（README 已知限制：「`followup()` 要求确切在线直接父级。只有 `interrupt()` 接受持久化 parent 地址形式的用户授权」）。

#### 继续 / 恢复（resume）一个子 agent

**没有独立的 resume 工具。冷恢复是 `followup` 的一条内部分支**：

```js
// dsh-subagent/lib/index.js:855-873
async followup(parent, childId, content, options) {
  this.assertAdmitting(parent);
  while (true) {
    const live = await this.locks.run(childId, async () => {
      const activation = this.activations.get(childId);
      if (activation === void 0) return this.coldResume(parent, childId, content, options);   // ← 冷恢复
      if (activation.disposal !== void 0) return activation.disposal.then(() => void 0, () => void 0);
      return this.submitAdmitted(activation, content, options.source, parent, options.signal);
    });
    if (live !== void 0) return live;
    this.assertAdmitting(parent);
    options.signal.throwIfAborted();
  }
}
```
那个 `while (true)` 是给"投递与最终 dispose 竞态"兜底的：唯一的 `undefined` 返回来自 disposal 分支，会重试一次并冷恢复新 Activation。（源码用 `/* v8 ignore */` 标注该竞态"没有测试能确定性调度"。）

```js
// dsh-subagent/lib/index.js:1144-1157
async coldResume(parent, childId, content, options) {
  const persistence = this.requirePersistence();
  let loaded;
  try { loaded = await persistence.inspect(childId, options.signal); }
  catch (error) { options.signal.throwIfAborted();
    throw new SubagentError(`subagent "${childId}" is unavailable`, "NOT_RESUMABLE", { cause: error }); }
  options.signal.throwIfAborted();
  this.assertAdmitting(parent);
  this.authorizeLineage(parent, childId, loaded.meta.parentSession);      // 重建前后各检查一次授权
  const descriptor = foldSubagentDescriptor(loaded.events.slice(loaded.meta.seedLength ?? 0));
  if (descriptor === void 0 || descriptor.mode !== "continuable")
    throw new SubagentError(`subagent "${childId}" has no supported continuation state and cannot be resumed; do not retry send_message with this id`, "NOT_RESUMABLE");
  ...
  activation = await this.materialize({ childId, provider: descriptor.provider, parent,
    agentOptions: { provider: descriptor.agentProvider, model: descriptor.agentModel },
    composition: { persona: descriptor.persona, toolFilter: descriptor.toolFilter }, signal: options.signal });
  return this.submitMaterialized(activation, content, options.source, parent, options.signal);
}
```
关键细节：
- **必须 `mode === 'continuable'`** 才能恢复；一次性 child 的 id 传给 `send_message` 会得到 `NOT_RESUMABLE` 并附一句给模型的明确指示："do not retry send_message with this id"。
- 重建输入**只有**折叠后的 descriptor + 持久 Session；**从不通过 provider 分发**（provider 甚至可能已卸载/未注册 —— README:94：「冷恢复时段会从描述符读取初始提供方名称，不会调用或注册该提供方」）。
- 重建用的 agentOptions/provider/model 与 persona/toolFilter 全部来自 **descriptor**，不是当前父级状态。README:64 解释：「冷恢复只会重放已持久化的委派事件，不会重新捕获父级策略，因此创建之后的父级切换绝不会追溯性地改变持久化子 agent。」
- 授权检查出现在**两次**：`authorizeLineage` 之后，`submitAdmitted` 里在最终无 await 的 inbox 准入区间**再查一次**（`:1365`），因此"在物化期间被注销或替换的 parent 无法授权投递"。

#### 服务级拆卸（不给模型）

`drainContinuableDescendants(parents)`（`:1014`）与 `drainContinuableChildren(parent, childIds)`（`:1055`）：
- 前者关闭**指定在线根**下的准入，只停这些根可见的可继续后代，等已准入的物化完成发布或回滚，再按**子级优先**顺序释放。该截止状态持续到**每个确切父级离开注册表**（这样不会毒化后来的同 id 替换，`:734-739`），无关父级树仍在线。
- 后者只释放一个确切父级的**具名**驻留直接子级，不关闭准入、不影响同级。缺失 id 视为 no-op；驻留子级属于其他父级则 `UNAUTHORIZED`。**这是拆卸操作，因此与 `interrupt()` 不同，它不会保留待处理的 inbox 工作。**

---

### 2.7 超时与失败

#### 超时：**没有子 agent 墙钟超时**

诚实结论 + 证据：
- 在 `dsh-subagent` / `dsh-subagent-*-in-process` / `dsh-tool-subagent*` 全包内 grep `timeout|deadline`，命中全部是 `aborted` 语义、`CANCELLED` 错误码、`TASK_WAIT_TIMEOUT` 引用 —— **没有任何墙钟/绝对截止时间逻辑**。
- `dsh-tool-subagent` 的 `defineTool` 调用**没有** `timeoutMs`，所以 `dsh-tool-call-timeout-policy` 对它不生效：
  ```js
  // dsh-tools/lib/index.js:844
  if (options.timeoutMs !== void 0 && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
  ```
  `dsh-tool-call-timeout-policy/README.zh.md:57`：「**没有统一预算**：只有声明 `timeoutMs` 并将其放在 `ToolDefinition` 上的工具才会获得截止时间；未声明工具没有注册表级默认值（已交付的 `bash`／`read`／`write`／`edit` 有意不声明）。」加上其"协作式而非硬终止"的性质，即使声明了也只是通知信号。
- 实际起"上限"作用的是三样东西：**深度预算 `maxDepth`=3**、**maxTokens**（默认从父级继承，命中后 `stopReason: 'max-tokens'`）、**父级被中断/取消**（`aborted`）。
- 唯一的真超时在后台 Task 的**等待**侧：`job_output` 的 `wait:true` + `timeout_ms` 到点返回 `TASK_WAIT_TIMEOUT`，但 job 本身继续活着（`dsh-jobs-local/lib/index.js:74-75`）。

#### 失败分层与通知归属

| 阶段 | 行为 | 谁通知 | 证据 |
|---|---|---|---|
| **发布前失败** | `start()` / `startContinuable()` **直接 reject**，不发 `subagent/start|end`，不留已发布子 agent | 调用方（工具 → 出错结果） | `dsh-tool-subagent/lib/index.js:44-53` `settleStart` |
| continuable 在**第一条消息被接受前**回滚 | `activation.announced === false` → `notifySettlement` **静默返回** | 无（调用方已被告知子级未建立） | `:1489` |
| **发布后**失败（一次性） | 通过 `run.result` 结算（**只有 seam 无法表示的基础设施故障才可以 reject**） | 工具侧（前台同步 / 后台 job） | driver `:201-214` |
| **发布后**失败（可继续） | Activation 结算 → **无条件**结算通知 | manager `notifySettlement` | `:1488` |
| 监听器抛错 | 只记日志，不阻塞同级、不改变运行 | `ctx.logger.warn` | `:173-180` |
| 拆卸某一边界失败 | 聚合成 `ACTIVATION_TEARDOWN_FAILED`，**所有分支都跑完才抛**；多边界 → AggregateError 作为 cause | 拆卸调用方（host） | `:1461-1468` |
| 最终 session flush 失败 | best-effort，只 warn，**绝不阻碍 handle dispose 或所有权释放** | `ctx.logger.warn` | `:1530-1537` |
| 结算通知投递失败 | 只 warn + drop，**绝不阻塞拆卸** | `ctx.logger.warn` | `:1520-1522` |
| 父级已离开注册表 | 通知被丢弃，**不算错误**（子级自己的 Session 仍是持久记录） | 无 | `:1491-1492` |

#### 终止原因词表与推导（值得移植的细节）

```js
// dsh-subagent-in-process-driver/lib/index.js:124-132（一次性）
function toStopReason(reason) {
  switch (reason?.kind) {
    case "completed":  return "completed";
    case "max-tokens": return "max-tokens";
    case "aborted":    return "aborted";
    case "blocked":    return "refusal";
    default:           return "error";
  }
}
```
```js
// dsh-subagent/lib/index.js:274-289（可继续，每个 Activation epoch）
function epochStopReason(events) {
  const { end, droppedUnrun } = foldConsumedWork(events);
  switch (end?.data.reason.kind) {
    case "max-tokens": return "max-tokens";
    case "aborted":
    case "interrupted": return "aborted";
    case "error": return "error";
    case "blocked": return "refusal";
    case void 0:
    case "completed": return droppedUnrun ? "aborted" : "completed";
    default: return "error";
  }
}
```
两条设计决定值得抄：
1. **从子级自己的日志推导，不从"拆卸成功"推导**（注释 `:258-263`）："teardown succeeding says nothing about whether the model errored, hit its token ceiling, or was cancelled, so deriving the reason from disposal would report failed work as completed."
2. **已记录的失败优先于取消**（注释 `:267-269`）："A recorded failure still wins over a cancellation — stopping a child that had already failed does not turn its failure into a cancellation."
3. `droppedUnrun`（接受的工作被取消、且没有轮次在其上开启）→ `aborted` 而非 `completed`。

另外每个 `switch` 的 `default` 都显式处理"无法命名的终止原因"，注释统一说明理由：**Treating an unnameable reason as success would report failed work as completed** —— 这是 fail-safe 方向的默认分支，与多数代码里"未知 ⇒ 成功/忽略"的习惯相反。

---

### 2.8 与父 agent 的消息通道

#### 只有两条合法边，且都是"确切在线身份"授权

| 方向 | 工具 | 凭据 | 服务侧授权 |
|---|---|---|---|
| 父 → 子 | `send_message` | `exec.agent`（确切在线的**直接**父级） | `followup` → `authorizeLineage(parent, childId, parentSession)` |
| 子 → 父 | `report` | `exec.agent`（确切在线的**可继续**子级） | `reportFrom` → `authorizeReporter` + `resolveReportParent` |
| 运行时 → 父 | （无工具）结算通知 | manager 内部 | `notifySettlement`（构造 source，不做工具授权） |

```js
// dsh-subagent/lib/index.js:1373-1376
authorizeLineage(parent, childId, parentSession) {
  if (this.ctx.agents.get(parent.id) !== parent)
    throw new SubagentError(`subagent "${childId}" delivery requires the exact live parent agent`, "UNAUTHORIZED");
  if (parentSession !== parent.id)
    throw new SubagentError(`subagent "${childId}" belongs to another parent session`, "UNAUTHORIZED");
}
```
注意第一行是**对象身份比较**（`!== parent`），不是 id 比较 —— 这挡住了"同 id 已被重新发布"的陈旧调者。

```js
// dsh-subagent/lib/index.js:930-945
authorizeReporter(child) {
  const activation = this.activations.get(child.id);
  if (activation === void 0 || activation.handle.agent !== child)
    throw new SubagentError(`agent "${child.id}" is not a live continuable subagent and cannot report`, "UNAUTHORIZED");
  if (activation.disposal !== void 0)
    throw new SubagentError(`subagent "${child.id}" activation is being disposed; the report was not delivered`, "ACTIVATION_CLOSING");
  return activation;
}
resolveReportParent(child) {
  const parentId = child.session.header.parentSession;
  const parent = parentId === void 0 ? void 0 : this.ctx.agents.get(parentId);
  if (parent === void 0)
    throw new SubagentError("direct parent is not live; report was not delivered", "PARENT_UNAVAILABLE");
  return parent;
}
```
同样是比较**同一个 agent 对象**（`activation.handle.agent !== child`），不是 id。

#### 路由细节

**父 → 子：只按驻留状态路由**（README:78：「路由只取决于驻留状态」）
```
activations.get(childId) === undefined  → coldResume()：从持久 Session 重建 Activation，排入消息
activation.disposal !== undefined       → 等该 disposal 结束，然后重试（while(true)）
否则                                    → submitAdmitted：同一 Agent 的 followup
   ├─ Agent running  → pipeline 入队（等当前轮次结束）
   └─ Activation waiting（Agent 已 idle 但仍有子级）→ 唤醒同一 Agent
```
Agent inbox 是**唯一**轮次队列，所以每条被接受的消息都有一个可观察顺序；manager 只管驻留，Agent loop 管全部轮次排序与执行。

**子 → 父：两条子路径**（`deliverReport` `:947-964`）
```js
const message = createUserMessage({
  content: [{ type: "text", text: `Background subagent ${activation.childId} reported:` }, ...content],
  source: { kind: "subagent-report", form: "relay", senderSessionId: activation.childId },
});
if (delivery === "next-step") this.sendWaking(parent, message, () => { this.sendReport(parent, message, delivery); });
else this.sendReport(parent, message, delivery);
return message.id;
// sendReport:  next-step → parent.steer(message)      /  quiet → parent.inject(message)
```
- `next-step`（默认）：运行中的父级在**最近的安全 step 边界**收到报告；空闲父级则**启动一个轮次**。
- `quiet`：`inject`，添加相同的 next-step 上下文但**不唤醒**停驻的父级。
- `steer` 而非 `inject` 的一个附带好处（README:88）：即使驱动在状态读取与发送之间退出，该消息仍会被认领。

**结算通知：第三种 source kind**
```js
source: { kind: "subagent-settled", form: "notice", summary: boundContextSummary(summary), senderSessionId: activation.childId }
```
README:84 强调：「与子级自撰的 `subagent-report` 是**不同的 source kind**，因此 transcript 绝不会把运行时写下的话算到子级头上。」

#### 唤醒准入记账（消除"发送 → 准入"之间的空窗）

```js
// dsh-subagent/lib/index.js:1343-1353
admitWaking(activation, messageId, send) {
  activation.accepted.add(messageId);
  try { send(); }
  catch (error) { activation.accepted.delete(messageId); throw error; }
  this.wake(activation);
  return messageId;
}
// :974-978 —— 父级是驻留 Activation 时才记账，否则直接发
sendWaking(parent, message, send) {
  const parentActivation = this.activations.get(parent.id);
  if (parentActivation !== void 0 && parentActivation.handle.agent === parent)
    this.admitWaking(parentActivation, message.id, send);
  else send();
}
```
配套在物化时挂的两个 inbox 事件（`:1265-1272`）：
```js
handle.agent.ctx.on("agent/inbox/claimed",   ({ message }) => { if (activation.accepted.delete(message.id)) this.wake(activation); });
handle.agent.ctx.on("agent/inbox/discarded", ({ message }) => { if (activation.accepted.delete(message.id)) this.wake(activation); });
```

#### 不能做的事（边界清单）

- **兄弟之间不能互发**，祖先（非直接父）不能给孙级发消息（只能 `interrupt`）。`list_agents` 的 schema 描述写死这一点：「You may use `send_message` only for depth-1 entries; deeper entries are candidates for `interrupt_agent` only.」
- **子级不能指定接收方**（`report` 无接收方参数）。
- **没有持久化 mailbox**：上报需要在线直接父级；不提供恰好一次投递、幂等键、投递回执、重试协议。任一侧记录接受后若进程失败，结果都不明确。
- **不对当前轮次 steering**：每条消息都开启后续 FIFO 轮次。
- **不返回收件人的回答**：`send_message` 只回 `messageId`；"通过该 id 查看其 transcript，才是了解它完成了哪些工作的真源"。
- **resume 后没有待处理通知**：`AgentHandle.dispose()` 是一次 `keepInbox: false` 的 cancel，会**持久地取消尚未被认领的通知**。因此 README:88 说：resume 后的父级没有待处理通知可读；`list_agents` 只告诉它有哪些子级、各自在线还是仅存于存储；结局本身留在子级自己的 Session 里，一次 `send_message` 会通过 resume 该子级把它取回。
- **嵌套上报只向上到达一条直接边**：孙级只向作为其直接父级的子级上报，该直接父级必须随后显式发出一条衍生更新给它自己的父级。

---

## 3. 可移植到其它 Node 项目的最小设计要点（10 条）

1. **把"委派"切成三个包，靠一个具名注册表解耦**：Service Definition（注册表 + 能力校验 + 生命周期事件）/ Provider（传输实现）/ Consumer（面向模型的工具）。注册表用 `Map<name, provider>` 而非单例，重复名显式报错，注册受 effect 生命周期约束（注销阻止新启动但**不撤销已返回的运行**），并发出 `provider-added` / `provider-removed` 事件让消费者**不依赖加载顺序**。
   → 证据：`SubagentRuntime.registerProvider`（`:2570`）；注释理由「Cordis 可能并发加载同级插件；配置顺序不能证明注册顺序」（`:98`）。

2. **Provider 接口保持极小，且用"方法存在性"作能力检查**：`{ name, capabilities, inheritsParentContext, start(request) → Promise<Run>, prepareContinuable?(req) → Promise<Data> }`。`capabilities` 是**创建前的硬校验**（`outputSchema` / `depthLimit` / `toolFilter` / `persona`），失败即拒绝，绝不"接受后忽略"。`prepareContinuable` 只返回**纯数据**（如 `{seed?}`），不给 provider 任何 handle / 投递 / dispose 能力。
   → 证据：`assertCapabilities`（`:2652`）、`prepareContinuable` 的注释「它只是数据，不携带任何能力」（README:48）。

3. **上下文继承只用一个可选 `seed` 参数，两种模式共用同一个驱动器**：`undefined` = 全新子 agent；有值 = 继承前缀。这样"新建 vs 继承"的差异被压缩到一个字段，其余（深度、创建、persona、工具过滤、结构化输出、取消、结果读取、dispose）只有一份实现。
   → 证据：`spawn: startInProcessRun(req, {})` vs `fork: startInProcessRun(req, {seed})`。

4. **seed 必须"平衡"，并且必须记录它的长度**：切到最后一个 `turn/end`（`events.slice(0, lastEnd.seq + 1)`），永远不要把 in-flight 轮次复制给子会话；把 `seedLength` 写进子 session header，结果读取时 `events.slice(seedLength)` 只取自有后缀。**忘了这一步，就会把父级的消息当成子级的输出** —— 这是 fork 类实现最容易出的 bug。
   → 证据：`completedTurnPrefix`；`activationBoundary = seed?.length ?? 0`；`childSessionMeta(..., lineageSeedLength)` → `seedLength`。

5. **结果 = 子级最后一条非空 assistant 消息（否则退化为累计文本），写成唯一的纯 fold**：同一个 fold 同时供给 run 结果、end 事件、以及"边流边看"的增量形态（`push(event)` / `pushText(text)` / `collect()`）。约定单一来源，别在多个消费点各写一遍。
   → 证据：`AssistantOutputFold`（`:74-109`）；注释说明空内容 assistant 消息只是用来记 usage，所以**不能**覆盖更早的输出。

6. **一次性 run 与"可继续"会话用两套生命周期，别塞进一个状态机**：
   - 一次性：`{ id, result, dispose() }` —— await 之后所有权转移给调用方，调用方**在每条路径上**都必须 dispose；`dispose()` 幂等；只有基础设施故障才允许 `result` reject，业务失败一律用**非 completed 的 stopReason** 表达。
   - 可继续：持久 Session + "同一时刻至多一个进程内 residency（Activation）" + `ownedChildren` 所有权图 + 幂等 memoized disposal。
   → 证据：driver `:192-226`；`activation` 结构（`:1247-1259`）。

7. **驻留状态从底层真值推导，别维护第二套计数器**：`running = exec.status === 'running' || acceptedInboxIds.size > 0`；`waiting = ownedChildren.size > 0`；`settled` = 其他。`accepted` 这个集合专门补偿"已发送但尚未被准入的唤醒消息"这个窗口 —— **底层状态机会在这段时间里报告空闲**，只看它就会提前结算。
   → 证据：`stateOf`（`:1132-1136`）及其注释。

8. **用底层执行器的 inbox 作为唯一轮次队列，所有"继续"都是"排下一个 FIFO 轮次"**：不要在 seam 外面再建一个队列，不要承诺 steering（`followup` 只排下一轮；要 steering 就单独提供 `steer`，并且明确它只在 step 边界被消费）。路由只依赖"有没有驻留"这一个事实。
   → 证据：`followup` 的三分支路由；`dsh-agent/README.zh.md:70-73` 的 followup/steer/inject 语义区分。

9. **结算通知由"拥有驻留权的那一层"发出，并在所有权释放之前发**：不要写成外部 end 事件监听器 —— 那种监听器拿不到父级、那时 handle 已被 dispose、唤醒父级结算看护的 release 也已经跑过。配套三条纪律：① 发送在释放子级所有权**之前**；② 父级本身也是驻留会话时，用与业务上报相同的唤醒准入记账；③ 投递失败只记日志并丢弃，**绝不为了重试一条通知而保留子级**（否则会把它的整条祖先链永久钉在 waiting）。同时提供**无条件**投递：不管子级是否上报过，因为最需要说明结局的终止情形正是子级没机会开口的那些。
   → 证据：`notifySettlement`（`:1488-1523`）、`finishDisposal` 的行序（`:1464-1466`）、注释 `:1482-1484`。

10. **持久化用"版本化 + 白名单键 + 显式字段"的描述符，绝不存可合并扩展的 options 对象**：畸形载荷要么响亮报错（当前版本的 payload 不符合 schema = 损坏），要么折叠成可序列化的 `null` 哨兵（版本不认识 = 无法分类），**绝不部分采用**。派生身份用 last-wins + 在每个描述符处 reset，这样"继承来的祖先身份"会被"自己的身份"覆盖。跨压缩保留（只进日志，不 surface 给模型）。
    → 证据：`SUBAGENT_DESCRIPTOR_VERSION = 2`、`assertKnownKeys`、`parseSubagentDescriptor` 对 version !== 2 返回 `undefined`（`:386`）、`subagentIdentityProjectionDefinition`（`:2084`）。

    **附加两条同等重要**（如果上面 10 条已满，这两条可作为第 9、10 条的补充）：
    - **子先于父的拆卸**：父的 Activation 只有在其 `ownedChildren` 全部 dispose 之后才 settle / dispose；拆卸失败绝不允许阻碍 handle 释放；所有分支都尝试完才聚合抛错。
    - **幂等 disposal**：`dispose()` 先查 memoized transaction 再安装（`disposal ??= ...`），保证取消、递归回调、并发 drain 全都收敛到同一个 owner。

---

## 4. DSH 踩过 / 规避的坑

以下每条都从代码中的注释、校验、`v8 ignore` 标注或边界处理推断；标注 **【注释明示】** 的是源码注释/README 直接写明的，**【推断】** 的是我从此类防御性代码反推的。

### 4.1 上下文与历史

| # | 坑 | DSH 的规避 | 来源 |
|---|---|---|---|
| 1 | fork 直接复制父级原始日志 → 子级拿到**不平衡的无效会话**（有 assistant 工具调用但没有匹配的 tool result / turn-end） | `completedTurnPrefix` 切到最后一个 `turn/end` | **【注释明示】** fork `:9`「the current tool-call turn is unbalanced and cannot be replayed as a valid child session」 |
| 2 | 父级**进行中**的轮次混进子级历史 | 显式排除 | **【注释明示】** fork README:11 |
| 3 | seed 内容被当作子级输出回传给父级 | `activationBoundary` / `seedLength` / `events.slice(boundary)` | **【推断】** 三重冗余（driver、lifecycle observer、list-children 的 seq 门）说明这确实出过问题 |
| 4 | 子 agent 不加入父级 preset → **抵达模型时看到空工具注册表** | `applyChildComposition(childCtx, parent, composition)` 把 parent 作为**必需参数**，让"组装子 agent 却不做该加入"在调用点**无法表达** | **【注释明示】** `:560-565`「a child that joins no preset sees an empty tool registry and none of its parent's prompt sections … Taking the parent as a parameter is what makes that omission unrepresentable at the call sites」 |
| 5 | 父级在**空档期切过 preset**，header 仍写着旧的 → 冷读子级历史时用错工具集/提示段重建轮次 | preset 从父级**活着的 scope 链**读（`parent.ctx.get("agentPresets")?.composedPreset(parent.ctx)`），**不从 header 读** | **【注释明示】** `:520-524`「a parent that switched preset while blank runs on the newer composition and its header still names the older one」 |
| 6 | fork 种子里的**祖先 descriptor** 污染子级身份/计时 | 两个投影都在 `subagent/descriptor` 处 **reset（last-wins）** | **【注释明示】** `:1973-1977`、`:2074-2082` |
| 7 | 畸形/未知版本投影载荷**抛错**会拖垮整条列表/推送链 | 折叠成 `null` 哨兵，"绝不抛错"；且 `null` 能完好穿过每个 JSON push 帧，让消费者**替换**而不是保留陈旧身份 | **【注释明示】** `:2077-2082`「so a consumer holding the earlier identity replaces it instead of keeping it stale」 |
| 8 | 可继续 fork 子级让 fork 的 KV 前缀复用**整体失效** | `report` 工具 + `tool:report` 提示段在继承历史**之前** → 所以每份随附组合都把 fork 配成 `backgroundMode: one-shot`，宁可放弃可继续能力 | **【注释明示】** `cordis.patch.yml:320-323`、fork README:42/61 |

### 4.2 权限与策略

| # | 坑 | DSH 的规避 | 来源 |
|---|---|---|---|
| 9 | 恢复后的子 agent 被**重新计为顶层**，从而无限委派 | `delegationDepth` **单调**：`Math.max(header.delegationDepth ?? 0, runtime.subagentDepth ?? 0)`；runtime 只能加深 | **【注释明示】** depth.js `:36-38`「a resumed child arrives with fresh options, and counting it from zero would let it delegate as if it were top-level」 |
| 10 | 子 agent 发起审批请求 → 卡在一个**没人应答的 prompt** 上 | 委派时把子级 approval 策略**钉死 `'never'`**（不管父级自己是什么策略），并用 `subagent:delegation` runtime context 告诉子级"别重试被拒操作，改为在回复里说明限制" | **【注释明示】** `captureDelegatedPolicyOverrides` `:588-590`；README:64「每次审批请求（例如 `sandbox_permissions` 升权）都会被确定性拒绝，而不会等待无人处理的提示」 |
| 11 | **沙箱部署默认值被错误复制**到子级（父级后来跟随部署默认值变化，子级却被钉死） | **绝不复制部署默认值**：只复制父 session 的**显式 override**（`sandboxPolicy.overrideOf(parent.session)`） | **【注释明示】** README:64「未切换的父级不会记录 `sandbox/mode`，其子 agent 会动态跟随部署默认值」 |
| 12 | 创建后父级切换策略**追溯性地改变**已持久化的子 agent | 策略在**第一次 await 之前**捕获，写成 `source:'delegation'` 事件；冷恢复**只重放**已持久化的委派事件，不重新捕获 | **【注释明示】** README:64 |
| 13 | 父级被注销/替换后仍能授权投递 | 授权检查**两次**：冷恢复重建前一次，最终**无 await 的 inbox 准入区间**再一次；对象身份比较（`!== parent`）而非 id 比较 | **【注释明示】** README:31；`authorizeLineage` `:1374` |
| 14 | 用可复用的 provider 名或会话名**推断**运行身份/本地性 | `local` 标志按 provider 返回的**确切** `localAgent` 是否存在快照 | **【注释明示】** README:94 |

### 4.3 结算与拆卸（这是 DSH 花最多笔墨的部分）

| # | 坑 | DSH 的规避 | 来源 |
|---|---|---|---|
| 15 | 结算通知**静默丢失**：父级在通知还留在 inbox 时被 dispose，而 `cancel()` 默认清空 inbox | 两条顺序规则（发送在所有权释放之前；父级是驻留 Activation 时做唤醒准入记账） | **【注释明示】** README:86「缺少其中任一条规则，父级都可能在通知仍留在 inbox 时被 dispose，而 `cancel()` 会清空该 inbox，于是通知被静默丢失」 |
| 16 | 同一时刻结算多个子级 → 各自消耗一个**独立轮次** | 对忙碌父级用 `steer`（step 边界）而非 `followup`；同时对阻塞的多个子级只消耗**一个** step | **【注释明示】** README:88 |
| 17 | 拆卸期间唤醒父级 → 多跑一次模型请求，而且**树的每一层各一次**（每层自己的通知又唤醒上一层） | 父级 lineage 已开始排空 → 用 `inject`，**完全不唤醒** | **【注释明示】** README:88；`closingTeardownFor` `:1112` |
| 18 | 为了重试一条通知而保留子级 → 把它整条**祖先链永久钉在 `waiting`** | 通知投递失败只 `warn` + drop；投递**绝不阻塞或使拆卸失败** | **【注释明示】** `:1482-1484` |
| 19 | 最终 session flush 失败被当成"持久化确认" → 阻碍 handle 释放 | flush 是 best-effort，失败只 warn；注释明说「listener 参与本身不能标识持久化后端」；`dispose` 仍必须释放所有权 | **【注释明示】** `:1525-1528` |
| 20 | 用"拆卸成功"推导终止原因 → **把失败的工作报告成 completed** | 从子级自己的日志 `foldConsumedWork(events)` 推导；且**已记录的失败优先于取消** | **【注释明示】** `:258-269` |
| 21 | 无法命名的终止原因被默认当成成功 | 每个 `switch` 的 `default` 都**fail-safe 到"未完成/error"**，注释统一写「Treating an unnameable reason as success would report failed work as completed」 | **【注释明示】** `:284-287`、`:692-695` |
| 22 | 投递与最终 dispose 的**竞态**（send-versus-dispose cutoff） | `ChildLock` 临界区 + `followup` 的 `while(true)` 重试 + `disposal ??= ...` memoized transaction；相关分支标 `/* v8 ignore */` 承认"没有测试能确定性调度" | **【注释明示】** `:861-873` |
| 23 | 拆卸**不幂等**（重入）→ 两次取消、双重释放 | `dispose()` 先查 memoized `activation.disposal` 再安装（`Promise.withResolvers` + `finishDisposal`） | **【推断】** `:1420-1427` |
| 24 | 一个分支的拆卸失败**饿死**其它分支 | `disposeRoots` 用 `Promise.all` + 每分支 try/catch 收集，**所有分支都跑完才聚合抛错** | **【注释明示】** `:992-995`、`:1067-1078` |
| 25 | 拆卸的**截止状态毒化后来的同 id 替换** | `closingScopes` 条目保留到那个**确切 root 离开 Agent 注册表**（否则一个同 id 的新 agent 会被误判为"正在收尾"） | **【注释明示】** `:734-739` |

### 4.4 输入校验与边界

| # | 坑 | DSH 的规避 | 来源 |
|---|---|---|---|
| 26 | 描述符"顺手存整个 options 对象" → 一个无关扩展值（非 JSON）就让续跑失败 | 显式字段快照 + `assertKnownKeys` 白名单 + 版本号；注释：「支持另一个组合输入是**有意的版本变更**，绝不是隐式的额外字段」 | **【注释明示】** `:306-318` |
| 27 | `toolFilter: {}` 的二义性（是"无限制"还是"配置错误"？） | 挂载时直接抛错：「配置了 `toolFilter` 但既没 `allow` 也没 `deny` —— 移除该键或填好过滤器」 | **【注释明示】** `dsh-tool-subagent/lib/index.js:132` |
| 28 | 配了数值 `maxDepth` 但 provider 无法强制执行 → 静默不生效 | 挂载时抛错，并给出可操作建议「改用 `maxDepth: 'provider-managed'`」 | **【注释明示】** `:138` |
| 29 | 诊断文本按**字节**截断切碎 UTF-8 序列 | 4096 字节界上回退到字符起始字节（`while ((bytes[i] & 0b1100_0000) === 0b10000000) i--`） | **【注释明示】** `:2118-2128` |
| 30 | 诊断文本**泄漏**工具输入/文件内容/环境值/凭证/原始协议载荷 | 契约要求 provider 侧先剔除（README:70） | **【注释明示】** README |
| 31 | `childId` 重复（调用方预留给一个已存在的会话） | 三重检查：`assertChildIdAvailable`（在线 agents + sessions）、持久化 `listSnapshots` 比对、`locks.run` 临界区内再查；失败 → `DUPLICATE_CHILD` | **【推断】** `:812`、`:835-837`、`:806` |
| 32 | 重复 provider 名 / 重复 `toolName` | provider 注册显式报错 `DUPLICATE_PROVIDER`；但**承认**这里有个缺口：`TODO(subagent-dup-toolname)` —— 「等待中的一次性实例较晚才发现重复名称」，可继续实例会在插件应用期间预留提示段名 | **【注释明示】** `:2573`、`dsh-tool-subagent/README.zh.md:81` |
| 33 | **子进程 cwd** 指向一个 mode-600 目录 → `statSync().isDirectory()` 为真但 spawn 报 EACCES | `isEnterableDirectory` 额外做 `accessSync(path, X_OK)` 探测 | **【注释明示】** `:2153-2156`「The search-permission probe matters」 |
| 34 | cwd 落回**服务进程的启动目录**（一个 server 服务多个 session，每个有自己的 cwd） | 相对路径报错；配置 `cwd: ""` 报错（`path.resolve('')` 就是进程 cwd，会**悄悄**重新引入这个回退）；无 cwd 时报错并要求显式配置 | **【注释明示】** `:2182-2192`、`:2196-2208` |
| 35 | 超时/关闭等待配成 0 / 负数 / NaN → **跳过或卡死**等待 | `assertPositiveFinite` 统一校验 | **【注释明示】** `:2142-2151` |
| 36 | 深度值 `-0`、非安全整数、格式错误的存储值 | `Object.is(runtime, -0)` 显式检查、`Number.isSafeInteger`、`RangeError`；"缺失值按顶层深度零处理，**拒绝格式错误的存储值**" | **【注释明示】** `:43-53` |

### 4.5 并发与竞态

| # | 坑 | DSH 的规避 | 来源 |
|---|---|---|---|
| 37 | 前一个操作失败后，同一 child 的后续操作被**饿死** | `ChildLock` 用 `.then(operation, operation)` —— 成功和失败路径都继续排队 | **【推断】** `:708` |
| 38 | `ChildLock.tails` 无限增长 | 尾部条目在后继到来时自清理（只在 `tails.get(id) === tail` 时删） | **【推断】** `:711-713` |
| 39 | drain 与"正在创建中的子 agent"竞态 → 漏掉一个刚发布的 child | `materializations: Set` + drain barrier：先等所有已准入的物化**完成发布或回滚**，再处理森林 | **【注释明示】** `:992`、`:1005-1013` |
| 40 | 拆卸慢 → 新委派继续涌入 | `assertAdmitting`：manager 级 drain 或该确切父级树收尾期间，**所有**新启动/投递/上报都被拒（`DRAINING`） | **【注释明示】** `:1117-1121` |
| 41 | 工具并行执行导致结果**乱序** | 滚动池按 `slots[committed]` 顺序 `commitReady()`；结果与上下文按**模型顺序**提交 | **【注释明示】** `dsh-agent-loop/lib/index.js:154-160` |
| 42 | 超时/沙箱/重试等多个包装层的**嵌套语义**不明确 | 注释显式声明："多个 `tools/execute` 监听器按注册顺序组合……注册顺序决定语义（超时覆盖整个重试操作 vs 覆盖每次尝试）" | **【注释明示】** `dsh-tool-call-timeout-policy/README.zh.md:36` |
| 43 | 取消期间列表还在慢慢跑完整个目录 | 每次持久化读都转发 `signal`，并在这些 await **前后**检查；读拒绝晚于 abort 则转成稳定 `CANCELLED` | **【注释明示】** `:1819`、`:1948-1950` |
| 44 | 冷读同一个列表时**打爆**持久化后端 | `COLD_READ_CONCURRENCY = 4` 固定宽度 worker 池；注释明确这是"读一次本地介质的界，若是网络后端应提升为 Config" | **【注释明示】** `:1692-1697` |
| 45 | 列表把"仅存于存储"误报成"有结果可收" | 状态机刻意命名为 `ready` 而非 `completed`；schema 描述写死「可恢复而非终态，也不表示有结果等待收集」 | **【注释明示】** `list-agents.js:17-23`、`:55-65` |

### 4.6 进程/传输边界

| # | 坑 | DSH 的规避 | 来源 |
|---|---|---|---|
| 46 | 进程外子 agent **无法**兑现父级强制的能力 | 进程外 provider 的能力广告是**全 false**（`NO_START_CAPABILITIES`），因此在 provider 拒绝任何需要这些能力的请求 —— 注释：「**never accepted-then-ignored**」 | **【注释明示】** `:2130-2141` |
| 47 | 子级进程崩溃的**半途输出**丢失 | `settleRunResult` 用 `{ attempt, collectOutput, collectDiagnostic, cancelled, signal, onAbort }` 契约：`result` 在发布后**永不 reject**，异常一律压平为 `stopReason:'error'` + 受限诊断，并保留已收集的输出 | **【注释明示】** `:2219-2253` |
| 48 | 取消时假设子进程会**配合** | `subprocessRunHandle.dispose()` 先结算本地取消（"there is no assumption the child cooperates"），再等后端 teardown 到**实际退出** | **【注释明示】** `:2254-2259` |
| 49 | 跨进程真相不一致 | README 承认这是**未解决**的：`list_agents` 是快照而非投递承诺，另一个进程也可能激活本进程报告为 `ready` 的 child；跨进程准确性需要**共享租约** | **【注释明示】** README:75、:156 |

### 4.7 崩溃与持久性（承认的缺口）

| # | 坑 | DSH 的应对 / 状态 | 来源 |
|---|---|---|---|
| 50 | 已接受但**从未写入日志**的消息在崩溃后丢失 | 接受但**坚决不虚构**：README:157「不回放已接受但未记录的消息……此后一条经授权的消息可以冷恢复该子 agent，但丢失的消息不会自动回放」 | **【注释明示】** README:157 |
| 51 | 为让目录"好看"而编造条目 | 明确拒绝：README:110「如果该检查点缺失，服务**不会根据 Task 历史虚构目录条目**」 | **【注释明示】** README:110 |
| 52 | 列表分类时**顺手解析**描述符 → 与投影折叠两套权威 | 注释明说「**投影折叠是唯一分类权威** —— 本模块自己不解析任何描述符」；列表操作本身不解析描述符 | **【注释明示】** `:1679-1688`、`:2524-2526` |
| 53 | 缓存（派生数据）读取失败被当成**权威判断** | 缓存读抛异常时**不据此分类**，静默落到权威重折；且用 `seq` 门（`cached.seq >= header.seedLength ?? 0`）证明该值折叠自 child 自己的后缀 | **【注释明示】** `:1869-1879`、`:2457` |
| 54 | 同 id 被**重新发布**的会话被当成同一个 child | `sameLifecycle(meta, expected)` 比对 `LIFECYCLE_WITNESS_KEYS`（version/id/createdAt/cwd/parentSession/seedLength/delegationDepth），不一致 → `corrupt` diagnostic | **【注释明示】** `:1933-1946` |
| 55 | listener 抛错或返回被拒的 promise **拖垮整个运行** | `createLifecycleEmitter` 对每个 listener 独立 try/catch + `Promise.resolve(returned).catch(...)`；`renderThrown` 防 coercion 逃逸 | **【注释明示】** `:157-182` |
| 56 | 取消收敛期间的**唤醒缺口** | 明确登记为未解决的 Issue（#1838）：中断信号发出后、driver 进入 idle 前被接受的唤醒型 follow-up 会保持排队直到另一条唤醒发送到达 | **【注释明示】** README:155 |

---

## 附录 A：本机实际部署组合（`dsh-base/cordis.patch.yml`）

```yaml
:292-293  - id: subagent
            name: '@deepseek-ai/dsh-subagent'

:295-298  - id: subagent-spawn-in-process
            name: '@deepseek-ai/dsh-subagent-spawn-in-process'
            config:
              providerName: spawn

:300-303  - id: subagent-fork-in-process
            name: '@deepseek-ai/dsh-subagent-fork-in-process'
            config:
              providerName: fork

:307-308  - id: tool-subagent-control
            name: '@deepseek-ai/dsh-tool-subagent-control'

:310-311  - id: tool-subagent-list-agents
            name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'

:313-318  - id: tool-subagent
            name: '@deepseek-ai/dsh-tool-subagent'
            config:
              provider: spawn
              toolName: subagent
              backgroundMode: continuable

:324-329  - id: tool-subagent-fork
            name: '@deepseek-ai/dsh-tool-subagent'
            config:
              provider: fork
              toolName: subagent_fork
              backgroundMode: one-shot

:332-333  - id: tool-subagent-report
            name: '@deepseek-ai/dsh-tool-subagent-report'

:335-338  - id: workflow-worker-thread
            name: '@deepseek-ai/dsh-workflow-worker-thread'
            config:
              provider: spawn
```

其它关键依赖：`:70 dsh-jobs-local`、`:98 dsh-session-persistence-jsonl`、`:126 dsh-session-projection`、`:218 dsh-tool-jobs`、`:343 dsh-tool-call-timeout-policy`、`:354 dsh-session-checkpoint-policy`。

**这份组合印证的三件事**：
1. 只有 `spawn` 和 `fork` 两个 provider，`acp` 未安装。
2. 模型默认拿到的 `subagent` 是**可继续 + 后台优先**（`backgroundMode: continuable` 使其 `run_in_background` 默认 `true`）。
3. `subagent_fork` 被刻意压制为 one-shot —— 因此 `report` 通道只对 `subagent` 创建的子级开放。

## 附录 B：`SubagentError` 错误码清单（从代码提取）

| 码 | 触发条件 | 位置 |
|---|---|---|
| `DUPLICATE_PROVIDER` | 同名 provider 重复注册 | `:2573` |
| `DUPLICATE_CHILD` | childId 已被在线 agent/session 或持久化占用 | `:812`、`:836` |
| `NO_PROVIDER` | 具名 provider 不存在 | `:2636` |
| `UNSUPPORTED_CAPABILITY` | 请求需要 provider 不支持的能力；或 provider 无 `prepareContinuable` | `:2630`、`:2671` |
| `UNAUTHORIZED` | 非确切的在线父/祖先/自身/跨父级 | `:899`、`:900`、`:905`、`:906`、`:932`、`:1056`、`:1061`、`:1374`、`:1375` |
| `ACTIVATION_CLOSING` | 目标 Activation 正在 dispose | `:935`、`:1307`、`:1364` |
| `PARENT_UNAVAILABLE` | 上报时直接父级不在线 / parent 拒绝 | `:943`、`:985` |
| `ACTIVATION_SETUP_REVOKED` | 子级构建期间某个贡献被撤销 | `:1634` |
| `ACTIVATION_TEARDOWN_FAILED` | 拆卸在 ≥1 个边界失败 | `:1077`、`:1449`、`:1454`、`:1459`、`:1463` |
| `DRAINING` | manager 或该父级树正在排空 | `:1121` |
| `NOT_RESUMABLE` | 无持久化 / inspect 失败 / 无 continuable 描述符 | `:1151`、`:1157`、`:1177` |
| `PERSISTENCE_UNAVAILABLE` | 缺少 `sessionPersistence` | `:1541` |
| `CONTINUATION_UNAVAILABLE` | 缺少 `ctx.agents`（continuation manager 未建立） | `:2641` |
| `CANCELLED` | 列表在检查点观察到 abort | `:1949` |
| `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE` | 未挂载 `sessionProjections` | `:1750` |
| `SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE` | 未挂载 `ctx.sessions` | `:1752` |
