[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-blue?logo=github)](https://github.com/topics/dsh-plugin) [![npm](https://img.shields.io/npm/v/dsh-claude-code)](https://www.npmjs.com/package/dsh-claude-code) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

# dsh-claude-code

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 工具插件：把**自包含的编码子任务**委派给**本地 Claude Code 订阅**执行，结果回传给 DSH。DSH 是 leader，Claude Code 是 worker。

- 走官方 [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)，驱动 `claude` CLI，**不提取任何 OAuth token**，合规使用订阅。
- 内置 **claude-code-delegation skill**（任务书模板 + 开派前置检查 + 回传验收 + 本插件操作事实 + 与官方通路的分工），**装好插件即自动装好技能**，用户目录不需要再放一份副本。
- 支持 **resume 跨轮记忆**：结果正文末尾会附 `session: <id>`，把它传回 `resume` 即可续接上一轮的上下文（前台与后台作业都适用）。
- 支持 **后台异步任务**：`run_in_background: true` 立即返回 `jobId`，用 DSH 自带的 `job_output` 增量读实时输出。
- 内置 **Claude Code 监控面板**：会话头「对话 / 轨迹」右边多一个 **Claude Code** 标签页 —— 任务 tab 条 + 原生风格实时输出（Markdown 预览 / 工具卡片 / 可折叠思考 / 运行中秒数）+ 一键取消。
- 内置 **长命令实时通道 `mcp__dsh__shell`**：Agent SDK 从不转发工具 stdout（它的消息联合里没有这种帧），所以插件自建了一条**由我们自己 spawn** 的 shell 通道 —— 构建 / 测试这类长命令的输出**逐行实时**进面板，还带独立超时、退出码与进程树清理。
- 面板同时列出**kind=`subagent` 的后台作业**（原生 subagent，或官方 `subagent_claude_code`）：它们没有本插件的事件流，改用 harness 的 `jobs.observe` 实时流渲染，取消走官方 `jobs.kill`。两类任务在一个面板里，互不干扰。
- 支持 **结构化输出**（`outputSchema`）、**成本上限**（`maxBudgetUsd`）、**追加系统提示**（`appendSystemPrompt`）与**自定义 subagents**。
- 支持 **DSH 0.2**：已在 `@deepseek-ai/dsh-*@0.2.0-rc.2` 上跑通（作业 owner 传 session id、结算文本走 `outcome.result`、客户端从 `ctx.jobs` 读 roster、逐字增量进事件流）。

## 与官方 `subagent_claude_code` 的分工

DSH 0.2 自带官方子代理通路（`@deepseek-ai/dsh-subagent-claude-code` + `@deepseek-ai/dsh-tool-subagent`）。两者不冲突，按需要选：

| | 本插件 `claude_code` | 官方 `subagent_claude_code` |
|---|---|---|
| 参数 | 15+：`cwd` / `model` / `permissionMode` / `allowedTools` / `maxTurns` / `effort` / `maxBudgetUsd` / `timeoutMs` / `appendSystemPrompt` / `outputSchema` / `resume` … | 只有 `prompt` + `run_in_background`（模型与权限来自 profile 配置） |
| 选模型 | ✅ per-call（默认跟随主会话模型） | ❌ 由 harness 决定 |
| resume | ✅ 会话保留，正文回传 `session: <id>` | ❌ provider 写死 `persistSession: false`，结构上不可能 |
| 成本 / 轮次 | ✅ 结果尾附 `(turns / cost / tokens)` | ❌ 行里只有 status/detail |
| 过程可见性 | ✅ 结构化事件：思考块、工具卡片、进度秒数 | 官方 job 文本流 |
| 进程管理 | 插件自己 spawn CLI | ✅ 官方 subprocess 托管 |
| 作业 kind | `claude-code` | `subagent` |
| 适合 | 需要精细控制、需要续跑、要回读成本 | 一次性、"原生"、无人值守任务 |

两者的后台作业都会出现在同一个面板里。

## 安装（用户侧）

```bash
# 方式一（最简单，自动接线）：通过 dsh 插件命令安装
dsh plugin --profile web add dsh-claude-code

# 方式二：手动装进 profile
cd ~/.dsh/profiles
npm install dsh-claude-code
# 然后在 ~/.dsh/profiles/<你的profile>/cordis.patch.yml 里加上：
# - insert:
#     - id: claude-code
#       name: 'dsh-claude-code'
```

装完重启 dsh。插件自带 `cordis.patch.yml`（`dsh.bundle` manifest），`dsh plugin add` 会用它自动接线。自带接线是**安全默认**（`acceptEdits`，不带代理）；只有本机出网 IP 是数据中心 IP、Anthropic 返回 403 时才需要自己加 `proxy`。

> 支持的 DSH 线：**0.1.0-rc.6 – 0.2.0-rc.2**（peer 范围 `>=0.1.0-rc.6 <0.3.0`）。已在 `@deepseek-ai/dsh-*@0.2.0-rc.2` 真实类型线上 `npm run typecheck` 零错误、`npm run build` 通过。
>
> 从源码开发：`npm install --legacy-peer-deps`（直接 `npm install` 会因 `dsh-system-prompt` → `dsh-invariants` 的 peer 冲突 ERESOLVE 失败）。

接线示例（带配置）：

```yaml
- insert:
    - id: claude-code
      name: 'dsh-claude-code'
      config:
        model: sonnet                # sonnet | opus | haiku | 完整 id
        permissionMode: acceptEdits  # default | acceptEdits | bypassPermissions | plan | dontAsk | auto
        maxTurns: 100
        timeoutMs: 600000
        # 可选：claude 可执行文件路径（SDK 会自动从 PATH 探测，一般不用配）
        # pathToClaudeCodeExecutable: /path/to/claude
        # 可选：成本上限与追加指令
        # maxBudgetUsd: 2
        # appendSystemPrompt: 始终用中文写提交信息；不要碰 lib/ 目录。
        # 可选：出网 IP 是数据中心 IP 时走本机代理（Anthropic 403 的解法）
        # proxy: http://127.0.0.1:<你的代理端口>
        # 可选：自定义 subagents（Claude Code 内可被 Agent 工具调用）
        # subagents:
        #   reviewer:
        #     description: 复核刚写完的补丁，找出 bug 与风格问题
        #     prompt: 你是严格的代码复核者，只报真实问题，按严重度排序。
        #     tools: [Read, Grep, Glob]
        #     model: sonnet
```

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `model` | `sonnet` | Claude 模型别名或完整 id |
| `permissionMode` | `acceptEdits` | Claude Code 权限模式。`acceptEdits` 自动放行文件编辑；`auto` 由分类器自动批/拒；`bypassPermissions` 完全免确认（需信任，且要开下面的开关） |
| `maxTurns` | `100` | 每次任务 Claude Code 最多跑多少轮 |
| `timeoutMs` | `7200000` | 单次调用的硬超时，到点强制中止（后台任务同样受它约束） |
| `warnTimeoutMs` | `3600000` | 跑满这么久后发一条 `warning` 事件（不中止）；`0` 关闭 |
| `warnIntervalMs` | `1800000` | 超过 `warnTimeoutMs` 后每隔这么久重复告警；`0` 关闭重复 |
| `cwd` | DSH cwd | Claude Code 工作目录 |
| `allowedTools` | 未设 | 允许的 Claude Code 内置工具名列表 |
| `pathToClaudeCodeExecutable` | 自动 | `claude` 可执行文件路径 |
| `effort` | `high` | 思考强度：`low`/`medium`/`high`/`xhigh`/`max` |
| `maxThinkingTokens` | 未设 | 思考 token 预算上限（旧参数，建议改用 `thinkingMode`） |
| `thinkingMode` | 未设 | 思考模式：`adaptive`（Claude 自己决定思考量）或 `disabled`（关闭扩展思考）；不设即用 SDK 默认 |
| `maxBudgetUsd` | 未设 | 单次任务的美元成本上限，达到即停 |
| `appendSystemPrompt` | 未设 | 追加到 Claude Code 默认系统提示后面的额外指令 |
| `allowDangerouslySkipPermissions` | `false` | 有意的安全开关；不开时 `permissionMode: bypassPermissions` 会被直接拒绝 |
| `proxy` | 未设 | 给 claude 子进程设置的 HTTP 代理（如 `http://127.0.0.1:7890`），写入其 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`；出网 IP 是数据中心 IP、Anthropic 返回 403 时用它 |
| `shellChannel` | `true` | 挂载 `mcp__dsh__shell` 长命令实时通道（见下文）；关掉则回到"只有 `⏳ 运行中` 心跳" |
| `shellChannelOnly` | `false` | 打开后**禁用内置 Bash**，所有命令都走实时通道（100% 有实时输出，代价是每条命令都是新进程，`cd`/`export` 不跨命令保留） |
| `shellPath` | 自动 | 实时通道用的 bash；不配时按 `CLAUDE_CODE_GIT_BASH_PATH` → PATH 上的 Git → `C:\Program Files\Git\bin\bash.exe` 依次探测（**不会**用 `WindowsApps\bash.exe` 那个 WSL 假壳） |
| `shellTimeoutMs` | `900000` | 实时通道内**单条命令**的超时；到点连整棵进程树一起杀（Windows 走 `taskkill /T /F`） |
| `subagents` | 未设 | 自定义 subagent 表：名称 → `{ description, prompt, tools?, disallowedTools?, model?, maxTurns?, initialPrompt?, background? }`，注册到 Claude Code 的 Agent 工具 |

## 工具一览（模型可见）

| 工具 | 说明 |
|---|---|
| `claude_code` | 把一个自包含编码任务委派给本机 Claude Code；前台返回最终文本，`run_in_background: true` 返回 `jobId` |

> 0.7.1 起**与额度有关的全部能力都已移除**：`claude_code_usage` 工具、面板顶部的额度栏、host 侧 `readUsageSnapshot` 与 `claudeCode/usage` RPC 一并删除（连同 `src/usage.ts`）。模型侧没有查额度的工具，面板里也没有额度 UI。

### `claude_code` 参数

| 参数 | 说明 |
|---|---|
| `task`（必填） | 自包含任务描述（目标、文件、约束、验收） |
| `cwd` / `model` / `permissionMode` / `maxTurns` / `allowedTools` / `effort` / `maxThinkingTokens` | 覆盖插件配置 |
| `resume` | 传上次返回的 `sessionId`（正文末尾 `session: <id>`），续接那个 Claude Code 会话（记住之前的上下文） |
| `run_in_background` | `true` = 转成 DSH 后台任务，立即返回 `{ kind: "background", jobId }` |
| `thinkingMode` | 本次调用的思考模式：`adaptive` / `disabled` |
| `maxBudgetUsd` | 本次调用的美元成本上限 |
| `appendSystemPrompt` | 本次调用追加到默认系统提示的额外指令 |
| `outputSchema` | JSON Schema 对象；给了就让 Claude Code 产出结构化结果，回到 `structuredOutput` |
| `proxy` | 本次调用用的 HTTP 代理（覆盖插件配置的 `proxy`） |
| `shellChannelOnly` | 本次调用禁用内置 Bash，所有命令走实时通道（覆盖配置的 `shellChannelOnly`） |

返回：最终结果文本 + `sessionId` + token 用量 + 费用 + 用到的工具 + `durationMs` / `numTurns`（有 `outputSchema` 时还有 `structuredOutput`）。**正文末尾会带一行 `session: <id>`**，那是 resume 的凭据；后台作业在 `job_output` 的结算文本里同样带这行。

## 技能（装插件即装）

插件的 host 半边用 `ctx.skills.register` 注册两个技能，来源是 `runtime`，因此**不需要**在 `~/.dsh/skills/` 下再放副本（放副本反而会造成两份说明书打架）：

| 技能 | 内容 |
|---|---|
| `claude-code-delegation` | 任务书模板（🔒 硬约束）+ 开派前置检查三条 + `outputSchema` 骨架 + 回传后验收 + 本插件的参数/后台作业/面板/超时 + **与官方 `subagent_claude_code` 的分工** |
| `parallel-dev` | 并行开发编排：多任务并行分派、worktree/分支、完成后集成 |

## 用法示例

```json
// 第一轮
{ "task": "修复 src/parser.ts 里 parse() 对空输入的崩溃，并加一个单元测试", "cwd": "/path/to/repo" }
// → 正文末尾：session: abc-123

// 第二轮（迭代同一任务，带记忆）
{ "task": "上一步的修复里你漏了边界情况 X，补上并重跑测试", "resume": "abc-123" }
```

## 后台异步任务

长任务不必阻塞当前这轮对话：传 `run_in_background: true`，工具立刻返回 `jobId`，任务在 DSH 的后台任务系统里跑。

```json
// 1) 派后台任务
{ "task": "把 src/ 全量迁移到新的 logger API，跑通 npm run build", "run_in_background": true }
// → { "kind": "background", "jobId": "claude-code-1" }

// 2) 增量读实时输出（每次只返回上次之后的新内容）
job_output { "jobId": "claude-code-1" }

// 3) 看在跑的任务 / 取消
job_list {}
job_kill { "jobId": "claude-code-1" }
```

- 实时输出来自 SDK 的 `includePartialMessages`，包含 Claude Code 的逐字增量文本、`[tool] Name` 调用标记，结算文本末尾附 `session: <id>`（后台任务也能 resume）。
- 任务结束时 DSH 自动推送完成通知，不用轮询；结束状态为 `completed` / `failed` / `killed`。
- 后台任务同样受 `timeoutMs` 约束，超时自动中止并以 `failed` 收尾（已产生的实时输出会保留）。
- `job_output` / `job_list` / `job_kill` 与完成通知由 DSH 的 `dsh-tool-jobs` 提供；没装它时后台模式会直接报 `background jobs unavailable: load @deepseek-ai/dsh-tool-jobs`。
- **关于"实时"的边界**：SDK 只把助手文本逐字流出来；**内置 Bash 的 stdout 永远拿不到**（`tool_result` 要等命令结束才回，SDK 的消息联合里根本没有工具输出帧）。所以面板用两手覆盖：长命令走下面的 `mcp__dsh__shell` 通道拿到**逐行实时输出**；没走通道的调用至少显示 `⏳ 运行中 1m20s…` 心跳。看不见滚动输出不代表面板丢数据。

## 长命令实时输出：`mcp__dsh__shell`

**为什么存在**：Agent SDK 的消息联合里**没有**任何"工具输出"帧（`tool_output` / `tool_stream` / `partial_tool` 都是 0 处命中；`SDKLocalCommandOutputMessage` 是本地斜杠命令的输出，不是工具的）。Claude Code 自己的 TUI 能看到 Bash 滚动输出，是因为管道握在 CLI 手里、不外传给 SDK 消费者。所以想在面板里看实时输出，唯一的办法是**换一条我们自己拥有的执行通道**。

**怎么用**：插件挂一个进程内 MCP server（名字 `dsh`），工具是 `mcp__dsh__shell`：

| 参数 | 说明 |
|---|---|
| `command`（必填） | 要执行的命令，以 `bash -lc` 启动 |
| `cwd` | 可选，默认用委派的工作目录 |
| `timeoutMs` | 可选，本命令超时（默认 `shellTimeoutMs` = 15 分钟）；到点杀整棵进程树 |
| `purpose` | 可选，一句话说明这条命令在干什么，显示在面板的命令行上 |

- 插件会自动把这条规矩注入委派方的系统提示：**预计超过 20 秒的命令走 `mcp__dsh__shell`**，短命令与需要保持 shell 状态的命令继续用内置 Bash。
- 输出逐行进面板（`▶ 实时输出` 代码块；`stderr` 标红；命令行与 `exit 0 · 12.3s` 作为暗色元信息行）。**不进**模型的 `job_output` 文本流——构建日志不该灌进上下文。
- 编码兜底：整块按 UTF-8 解码，一旦出现替换字符就按 **GBK** 重解（中文 Windows 的命令输出不会变问号）。
- 内置 Bash 仍然可用，原因很实在：Claude Code 的 Bash 是**持久 shell 会话**（`cd`/`export` 跨调用保留），而我们每条命令都是新进程。要 100% 覆盖就打开 `shellChannelOnly`（禁用 Bash），代价就是失去这个状态。
- 找不到 bash 时工具会直接告诉模型"改用内置 Bash"，不会静默失败。

## Claude Code 监控面板（Web 端）

装好后重启 DSH，会话顶部「对话 / 轨迹」右边会多一个 **Claude Code** 标签页，点开整个会话体变成监控面板：

- **上方任务 tab 条**：本会话的两类后台任务 —— 本插件的 `claude-code` 委派，以及 `subagent` 作业 —— 一个任务一个 tab（状态色点 —— 运行中蓝色呼吸、已完成绿、已失败红、已取消灰 —— 加单行截断标题）；运行中在前（按开始时间），已结束按新到旧；放不下时 tab 条横向滚动。
- **任务详情弹框**：每个 tab 上的 `ⓘ` 打开弹框（ESC / 点遮罩 / 关闭按钮都能关），里面是完整任务全文、模型、状态、开始 / 结束时间、耗时、费用、轮数、Claude 会话 id（可复制）和失败原因；缺省字段显示 `-`。点 `ⓘ` 不会切换选中的任务。
- **下方 Claude Code 窗口**：统计条（jobId / 状态 / 轮数 / 费用 / 耗时）+ **原生风格输出**——助手文本**直接按 Markdown 预览**（标题 / 粗体斜体 / 行内代码 / 代码块 / 有序无序列表 / 引用 / 分隔线 / 链接，每块右下角可切「原文 / 预览」；零依赖手写渲染器，全部走 React 文本节点、不用 `innerHTML`，链接只放行 `http(s):` 且 `target=_blank rel=noopener noreferrer`），思考块默认折叠成一行 `💭`（点开看全文），每次工具调用是一张卡片（工具名徽标按名字着色 + 参数 JSON 单行、点开展开为格式化全文），工具结果缩进挂在这张卡片下面（长结果截断 + 展开），**运行中的卡片显示 `⏳ 运行中 <已运行>` 并随心跳刷新**，任务结束是一条 `✅ 完成 · $0.13 · 12 turns · 3m20s` 摘要；贴底自动滚动、上滚即暂停并给「↓ 回到底部」。没有结构化事件的任务（例如首个块之前就失败）回落到等宽文本流。
- **`mcp__dsh__shell` 的实时输出**：命令的 stdout/stderr 逐行渲染成 `▶ 实时输出` 块（stderr 标红、每块最多在 DOM 里留 400 行），命令行是暗色的 `$ <命令>`，结束补一行 `exit <码> · <耗时>`；相邻同流事件合并成一个块，所以几千行构建日志不会变成几千个节点。
- **官方 `subagent` 行**：没有本插件的事件流，改用 harness 的 `jobs.observe(sessionId, jobId)` 流渲染（遇到被驱逐的缺口会提示截断），取消走 `jobs.kill`。
- **操作**：取消（二次确认）、复制输出、复制 Claude 会话 id（可直接当 `resume` 用）。
- 实时输出只在「面板打开 + 选中任务还在跑」时每秒拉一次增量（结构化事件与文本流各自一个绝对游标），任务进终态后补拉一次收尾。任务行来源是**三路合并去重**：harness 的 `jobs` roster + 0.1.x 的镜像 + 插件自己的 tracker 列表（每 2 秒轮询，保证刚派出的任务立刻出现）。
- 面板的读取走**绝对 offset**，和模型侧 `job_output` 的游标完全独立——你在面板里看输出不会偷走模型的字节。面板取消走插件自己的中止通道，任务照常以 `killed` 结算，**模型仍然会收到完成通知**。
- 插件任务只存在于当前 DSH 进程内（每会话保留最近 20 条），重启后列表为空；历史结果看对话里的工具卡片。
- 标签页在 tab 条里的位置由插件加载顺序决定（不是 `order`），一般就在「轨迹」右边。
- **改了 client 半边必须重启 DSH**（桌面端没有硬刷新，别指望 Ctrl+R）。

## 错误诊断

调用前会做一次同步预检，常见问题给的是可直接照做的提示：

| 现象 | 处理 |
|---|---|
| `claude executable not found` | 本机没装 CLI：`npm install -g @anthropic-ai/claude-code`；或把 `pathToClaudeCodeExecutable` 指到正确路径 |
| 实时通道报"找不到 bash" | Windows 上需要 Git Bash：装 Git，或把 `shellPath` 指到 `…\Git\bin\bash.exe`（PATH 上那个 `WindowsApps\bash.exe` 是 WSL 假壳，不能用） |
| `cwd does not exist or is not a directory` | `cwd` 写错或目录不存在，改成存在的绝对路径（**不传不会跟随主会话 cwd**，会落到宿主进程 cwd） |
| 认证失败 | 在终端手动跑一次 `claude` 完成登录，再回来调用 |
| 计费错误 | 检查 Claude 订阅状态 |
| 限流 / 过载 | 稍后重试；必要时降 `effort` 或拆小任务 |
| 403（出网 IP 是数据中心 IP） | 在插件配置里设 `proxy`（如 `http://127.0.0.1:7890`，指向本机 Clash 等代理），或给 **DSH 进程**设置 `HTTPS_PROXY` / `HTTP_PROXY` 后重启 dsh 再调用 |
| `bypassPermissions` 被拒 | 这是有意的安全开关：在插件配置里显式设 `allowDangerouslySkipPermissions: true`，或改用 `acceptEdits` / `auto` |
| 达到 `maxBudgetUsd` | 调高预算或缩小任务范围 |
| `resume` 的会话已被清理 | 去掉 `resume` 重新发起一次（报 `no conversation found`） |
| 后台任务报 `session "[object Object]" has no live agent` | 0.2 之前的老 bug（owner 传了 Agent 对象而非 id），0.7.1 已修 |

## 合规说明

- ✅ 走 Claude Code 官方 CLI / Agent SDK，符合 Anthropic 认证与订阅政策。
- ❌ 本插件**不是**「把 Claude 当 DSH 的裸模型适配器」——那需要提取 Claude Code 的 OAuth token 直连 api.anthropic.com，已被 Anthropic 明令禁止、会导致封号。
- 说明：`claude_code` 运行的是 **Claude Code CLI 外壳**，其底层模型由本机 `~/.claude/settings.json` 的 `ANTHROPIC_BASE_URL` 与别名映射决定，**可能不是 Anthropic 的模型**。不要把产出表述为「来自 Claude」；准确说法是「以 Claude Code 方式（外壳）运行」。

## 开发

```bash
npm install --legacy-peer-deps
npm run build       # node 半边 tsc → lib/，client 半边 esbuild → lib/client.js，再断言产物齐全
npm run typecheck   # 两个 tsconfig 都查（node + client）
```

两个半边：

| 半边 | 入口 | 产物 | 构建 |
|---|---|---|---|
| node（Host） | `src/index.ts`（+ `tracker.ts` / `remote.ts` / `live-shell.ts` / `delegate-model.ts` / `delegation-skill.ts`） | `lib/*.js` + `lib/types/**` | `tsc -p tsconfig.json` |
| client（Web） | `src/client/index.ts` | `lib/client.js`（单文件 CJS，外层包 `window.__ModuleLoader__.load({ id: "dsh-claude-code", … })`） | `tsc -p tsconfig.client.json`（只出 d.ts）+ `scripts/build-client.mjs`（esbuild） |

`scripts/assert-artifacts.mjs` 会逐个断言产物存在（新增模块要同步加进它的清单，否则漏文件不会被发现）。client bundle 只允许 `require` DSH shell 的 seed 白名单（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives` 等），构建脚本会断言这一点，其余依赖必须打进 bundle。

本地部署（源码方式）：

```bash
npm run build
# 把 lib/ 全量覆盖到安装位置（新模块文件也要一起拷，漏拷会让插件加载失败）
cp -R lib/* ~/.dsh/profiles/<profile>/node_modules/dsh-claude-code/lib/
# 然后重启 dsh
```

## 发布

```bash
npm login
npm publish         # publishConfig.access 已设 public
```

发布后建议：GitHub 建仓库并给仓库打 **dsh-plugin** topic，即可出现在 github.com/topics/dsh-plugin。

## 注意

- 每次调用约 10 秒起步、按订阅计费（小任务实测约 0.1~0.2 美元），只适合"完整子任务"。
- Claude Code 自己执行工具，DSH 的沙箱/权限不套在它的工具调用上——请把 `cwd` 与 `permissionMode` 收敛到信任范围。
- 详细变更见 [CHANGELOG.md](CHANGELOG.md)。
