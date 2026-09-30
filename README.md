[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-blue?logo=github)](https://github.com/topics/dsh-plugin) [![npm](https://img.shields.io/npm/v/dsh-claude-delegate)](https://www.npmjs.com/package/dsh-claude-delegate) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

# dsh-claude-delegate

> 把一件**说得清的编码活**交给本机 Claude Code 干完，结果拿回来。
>
> 基于原插件 [zhangjunjesse/dsh-claude-code](https://github.com/zhangjunjesse/dsh-claude-code) 改造（见 [它是从哪来的](#它是从哪来的)）。

装上之后，DSH 多一个工具 `claude_code`、多一个 **Claude Code 面板**。分工很直白：DSH 决定"做什么、做到什么算对"，Claude Code 负责"把代码读遍、改完、跑通"。

全程用官方 [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 驱动你本机那份 `claude` CLI——**不碰 OAuth token**，走的是你已有的订阅。

支持的 DSH 线：**0.1.0-rc.6 → 0.2.0-rc.2**（peer 范围 `>=0.1.0-rc.6 <0.3.0`，已在 `@deepseek-ai/dsh-*@0.2.0-rc.2` 上 typecheck/build 双绿）。

---

## 它是从哪来的

上游是 **[zhangjunjesse/dsh-claude-code](https://github.com/zhangjunjesse/dsh-claude-code)**，npm 上只发到 0.1.2 就停了；本仓库（[project-hy/dsh-claude-delegate](https://github.com/project-hy/dsh-claude-delegate)）在它 0.6.0 的基础上继续做。为了不和上游撞名，**包名与仓库名都改成 `dsh-claude-delegate`**（上游仍保留在 `upstream` remote，想取它的更新就 `git fetch upstream`）。

在原有基础上做的事：

| | |
|---|---|
| **适配 DSH 0.2**（0.2.0-rc.2） | 作业 owner 传 session id、结算文本走 `outcome.result`、客户端从 `ctx.jobs` 读 roster、逐字增量进事件流 |
| **新增长命令实时通道** | `mcp__dsh__shell`：SDK 从不转发工具 stdout，所以自建一条由插件自己 spawn 的通道，输出逐行进面板 |
| **新增监控面板** | 任务 tab 条 + 结构化过程（思考块 / 工具卡片 / Markdown 预览）+ 终端输出块 + 一键取消；并修掉切 tab 后任务行消失的问题 |
| **修 `resume`** | 结果正文末尾回传 `session: <id>`，前台与后台都能续跑 |
| **技能改为运行时注册** | 从"往用户目录放一份副本"改成装插件即装技能，不会再有两份说明书漂移 |
| **删掉额度/用量那一块** | `claude_code_usage` 工具、面板额度栏、usage RPC 与模块全部移除 |
| **清掉随包的不安全默认值** | 上游随包的接线里带着作者开发机的 `proxy: 127.0.0.1:7897` 与 `bypassPermissions`（前者在本机必然 `ECONNREFUSED`，后者等于委派出去的子进程没有任何权限确认），本仓库改为安全默认并写进注释 |

---

## 30 秒上手

```bash
dsh plugin --profile web add dsh-claude-delegate   # 插件自带接线清单，装完自动接好
# 重启 dsh
```

然后让模型干活时直说就行：

```
用 claude_code 把 src/parser.ts 里 parse() 对空输入崩溃的问题修掉，补一个单测，
cwd 用 /path/to/repo
```

它给回来的正文里，最后一行是 `session: <id>`——**先记住这行，它是下一轮的钥匙**（下面第 2 个玩法就靠它）。也可以从代码里直接调：

```json
{ "task": "把 src/parser.ts 里 parse() 对空输入崩溃的问题修掉，补一个单测", "cwd": "/path/to/repo" }
```

---

## 它是什么，它不做什么

| | |
|---|---|
| **是什么** | 一个"外包接口"：你给它一份自包含的活儿，它把 CLI 跑完，把最终文本、`sessionId`、花费、轮次、用到的工具交回来 |
| **不是** | 不是把 Claude 当作 DSH 的裸模型接入。它驱动的是**完整 Claude Code**（能读写文件、能跑命令、有自己的会话） |
| **顺手给的** | 长命令实时输出、后台作业、跨轮记忆（resume）、成本上限、结构化输出、自装技能、一块能盯进度的面板 |
| **不负责的** | 替你定义"什么叫做对"。任务书里的验收标准得你先想清楚 |

---

## 三个高频玩法

### 1. 长活不堵对话

加 `run_in_background: true`，工具**立刻**返回 `jobId`，活在后天跑，你现在这轮可以继续干别的：

```json
{ "task": "把 src/ 全量迁到新 logger API，跑通 npm run build", "run_in_background": true }
// → { "kind": "background", "jobId": "claude-code-1" }
```

读进度用 DSH 自带的作业工具（每次只回上次之后的新内容）：

```
job_output { "jobId": "claude-code-1" }   # 看新输出
job_list   {}                             # 谁在跑
job_kill   { "jobId": "claude-code-1" }   # 不要了
```

跑完 DSH 会推一条完成通知，不用轮询。后台作业同样受 `timeoutMs` 约束，超时按 `failed` 结算（已经产出的输出留着）。这一套依赖 `dsh-tool-jobs`，没装时后台模式会直接报 `background jobs unavailable`。

### 2. 停下改完接着干

第一轮末尾那行 `session: <id>` 就是钥匙，下一轮把它塞进 `resume`：

```json
// 第二轮：同一个 Claude Code 会话，它记得上一轮干了什么、为什么那么干
{ "task": "上一步的修复漏了边界情况 X，补上并重跑测试", "resume": "abc-123" }
```

后台作业也一样能续：结算文本里同样带着 `session: <id>`。

### 3. 两条活一起跑

两条互不相干的活（不同模块、不同仓库）不用排队——同一轮里发两次调用、都开后台，面板里就是两条独立的任务 tab，各自刷各自的输出。想让它自动编排（判要不要 worktree、开分支、派完再集成），装插件时一起带的 `parallel-dev` 技能是干这个的。

---

## 控制委派：参数怎么给

参数分五类，按需要给，不给就吃配置里的默认值。

| 想控制 | 参数 |
|---|---|
| **干什么** | `task`（必填，写清目标 / 文件 / 约束 / 验收） |
| **在哪儿干** | `cwd`（**建议每次显式给绝对路径**；不给时不会跟随主会话，而是落到宿主进程的 cwd） |
| **用谁、怎么干** | `model`、`effort`、`maxTurns`、`permissionMode`、`allowedTools`、`appendSystemPrompt`、`subagents` |
| **花多少** | `maxBudgetUsd`（美元上限，到点就停）、`timeoutMs`（硬超时）、`thinkingMode` / `maxThinkingTokens` |
| **怎么交回来** | `outputSchema`（给 JSON Schema 就回结构化结果）、`resume`（续上一轮）、`run_in_background`（转后台） |

结果里给回来的：最终文本、`sessionId`、token 用量、费用、轮次、耗时、用过的工具；给了 `outputSchema` 还会多一个 `structuredOutput`。

> `permissionMode` 默认 `acceptEdits`——**文件编辑自动放行，跑命令仍然会被拒**。要它自己跑构建/测试，得在调用里显式给 `allowedTools`（例如 `["Read","Write","Edit","Bash","Glob","Grep"]`）。这个插件**没有审批弹窗**：没预授权的操作直接失败，不会停下来等人点同意。

---

## 配置：写在 profile 里

```yaml
- insert:
    - id: claude-code
      name: 'dsh-claude-delegate'
      config:
        model: sonnet                # sonnet | opus | haiku | 完整 id
        permissionMode: acceptEdits  # default | acceptEdits | bypassPermissions | plan | dontAsk | auto
        maxTurns: 100
        timeoutMs: 600000
        # cwd: /path/to/repo
        # maxBudgetUsd: 2
        # appendSystemPrompt: 提交信息一律用中文；不要动 lib/ 目录。
        # proxy: http://127.0.0.1:7890      # 出网 IP 被 Anthropic 判成数据中心时用
        # subagents:                        # Claude Code 内部可被 Agent 工具调用
        #   reviewer:
        #     description: 复核刚写完的补丁，只报真问题
        #     prompt: 你是严格的代码复核者，按严重度排序输出。
        #     tools: [Read, Grep, Glob]
```

常用字段（完整表见源码 `Config` schema）：

| 字段 | 默认 | 作用 |
|---|---|---|
| `model` / `effort` | `sonnet` / `high` | 用哪个别名、思考多用力 |
| `permissionMode` | `acceptEdits` | 权限档位；`bypassPermissions` 需要额外开 `allowDangerouslySkipPermissions` 才生效（有意的保险闸） |
| `maxTurns` / `timeoutMs` | `100` / `7200000` | 轮次上限、单次硬超时 |
| `warnTimeoutMs` / `warnIntervalMs` | `3600000` / `1800000` | 跑太久先告警（不中止），以及多久重复一次；设 `0` 关 |
| `cwd` / `allowedTools` | 宿主 cwd / 未设 | 干活目录、允许的内置工具 |
| `pathToClaudeCodeExecutable` | 自动探测 | 手动指定 `claude` 可执行文件 |
| `proxy` | 未设 | 写进 claude 子进程的 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` |
| `shellChannel` / `shellChannelOnly` / `shellPath` / `shellTimeoutMs` | `true` / `false` / 自动 / `900000` | 实时输出通道（下一节） |
| `subagents` | 未设 | 自定义 subagent 表 |

本来想省事的场景下，`dsh plugin add` 用的就是包内自带的 `cordis.patch.yml`（安全默认：`acceptEdits`、不带代理）。

---

## 面板：从派出去到收回来

会话顶部「对话 / 轨迹」旁边会多一个 **Claude Code** 标签页，点开会话体就变成监控面板。它不是日志窗，是"这条活现在到哪了"的一屏：

- **任务条**：本会话每条后台作业一个 tab。色点即状态——运行中蓝色呼吸、完成绿、失败红、被取消灰；运行中的排在最前，结束的按时间倒序。标题太长会截断，放不下横向滚。
- **详情弹框**：tab 上的 `ⓘ` 打开，里面是完整任务全文、模型、状态、起止时间、耗时、费用、轮次、Claude 会话 id（点一下复制，直接当 `resume` 用）和失败原因。字段缺就显示 `-`。
- **主体窗口**：顶部一条统计（jobId / 状态 / 轮次 / 费用 / 耗时），下面是过程——助手文本**按 Markdown 预览**（标题、粗体、行内码、代码块、列表、引用、链接，每块右下角能切「原文 / 预览」；渲染器是手写的零依赖实现，全走 React 文本节点、不用 `innerHTML`，链接只放行 `http(s):` 且带 `noopener`），思考块默认收成一行 `💭`，每次工具调用是一张卡片（工具名着色 + 参数一行，点开展开），结果挂在卡片下（太长折叠），运行中的卡片显示 `⏳ 运行中 <已跑>`，收尾是一条 `✅ 完成 · $0.13 · 12 turns · 3m20s`。贴着底自动滚，你一上滚就暂停并给出「↓ 回到底部」。
- **命令输出块**：走实时通道的命令（见下一节）在这里显示成终端块——`▶ 实时输出` 头 + 逐行输出（stderr 标红）+ 暗色的 `exit 0 · 12.3s` 收尾。
- **取消**：按钮在一次确认后真的把子进程树杀掉，任务按 `killed` 结算，**模型那边照样收到完成通知**。

几个实现上的事实，用起来会碰到：

- 面板读的是**绝对偏移**，和模型侧 `job_output` 的游标各走各的——你在面板里翻输出，不会把模型的字节偷走。
- 任务记录活在**当前 DSH 进程**里（每会话留最近 20 条），重启就空；想回看历史结果，去对话里的工具卡片。
- tab 的位置由插件加载顺序决定，一般就在「轨迹」右边。
- **改了插件的客户端半边必须重启 DSH**：桌面端没有硬刷新。

---

## 命令输出为什么能实时

这里有个 SDK 层面的硬事实：**Agent SDK 从不把工具的输出转发给你**。它的消息联合里没有"工具输出"这种帧——工具跑的时候只有心跳（`tool_progress`），跑完才给一个 `tool_result`。你在 Claude Code 自己的 TUI 里能看到 Bash 滚动输出，是因为管道握在 CLI 手里，不往外发。

绕不过去，就自己开一条：插件挂了一个**进程内 MCP server**（名字 `dsh`），工具叫 `mcp__dsh__shell`。命令由插件自己 spawn（`bash -lc`），所以每一行都先经过我们的手——逐行进面板，同时按需回给模型。

| 参数 | 说明 |
|---|---|
| `command`（必填） | 要跑的命令 |
| `cwd` | 在哪儿跑，默认用委派的工作目录 |
| `timeoutMs` | 本命令的超时，默认 15 分钟；到点**连整棵进程树一起杀**（Windows 走 `taskkill /T /F`） |
| `purpose` | 一句话说明这条命令在干什么，显示在面板的命令行上 |

为了让模型真的用它，插件会把规矩注入委派的系统提示：**预计超过 20 秒的命令走 `mcp__dsh__shell`**。其余细节：

- 输出**只进面板，不进 `job_output`**——几千行构建日志不该灌进上下文。所以不管跑了什么命令，结论仍必须写在回复正文里。
- 编码兜底：整块先按 UTF-8 解，出现替换字符就按 **GBK** 重解（中文 Windows 不会变问号）。
- 每条命令都是**一次性进程**：`cd` / `export` 不跨调用保留。短命令、需要连续 shell 状态的命令，继续用内置 Bash。想要 100% 都有实时输出，把 `shellChannelOnly` 打开（它会禁用内置 Bash，代价就是失去这个状态）。
- 找不到 bash 时，工具会直接告诉模型"改用内置 Bash"，不静默失败。

---

## 技能：装插件即装

插件在运行时注册技能（`source: runtime`），所以**不用**再往 `~/.dsh/skills/` 放副本——放副本反而会变成两份说明书互相打架。

| 技能 | 里面是什么 |
|---|---|
| `claude-code-delegation` | 任务书模板（🔒 硬约束）+ 开派前置检查三条 + `outputSchema` 骨架 + 回传后怎么验收 + 本插件的参数 / 后台作业 / 实时通道 / 面板 / 两级超时 / 什么时候别派 |
| `parallel-dev` | 并行开发编排：多任务分派、worktree 与分支、事后集成 |

---

## 安全与合规

- ✅ 走的是官方 CLI 与 Agent SDK，符合 Anthropic 的认证与订阅政策。
- ❌ 本插件**不是**"把 Claude 当裸模型接进 DSH"——那要求提取 Claude Code 的 OAuth token 直连 `api.anthropic.com`，属于明令禁止、会封号的做法。
- ⚠️ 权限边界：Claude Code **自己**执行工具，DSH 的沙箱不套在它的调用上。`cwd` 和 `permissionMode` 请收敛在你信任的范围内。
- 📌 表述要准：插件运行的是 **Claude Code CLI 外壳**，底层模型由本机 `~/.claude/settings.json`（`ANTHROPIC_BASE_URL` 与别名映射）决定，**不一定是 Anthropic 的模型**。所以别说"来自 Claude"，准确说法是"以 Claude Code 方式（外壳）运行"。

---

## 排障速查

| 你看到的 | 怎么办 |
|---|---|
| `claude executable not found` | 没装 CLI：`npm install -g @anthropic-ai/claude-code`；或把 `pathToClaudeCodeExecutable` 指对 |
| 变量通道说找不到 bash | Windows 上要 Git Bash：装 Git，或把 `shellPath` 指到 `…\Git\bin\bash.exe`（PATH 上那个 `WindowsApps\bash.exe` 是 WSL 假壳，别用） |
| `cwd does not exist or is not a directory` | `cwd` 得是存在的绝对路径；不传会落到宿主进程目录 |
| 认证失败 / 计费报错 | 先在终端手动跑一次 `claude` 完成登录；再查订阅状态 |
| 限流、过载 | 稍后重试，或降 `effort`、把任务拆小 |
| 403（出网 IP 是数据中心 IP） | 配 `proxy` 指向本机代理（如 `http://127.0.0.1:7890`），或给 DSH 进程设 `HTTPS_PROXY` 后重启 |
| `bypassPermissions` 被拒 | 这是有意的：要真用就在配置里显式写 `allowDangerouslySkipPermissions: true`，否则改用 `acceptEdits` / `auto` |
| 达到 `maxBudgetUsd` | 调高预算，或把任务拆小 |
| `resume` 报 `no conversation found` | 那个会话已被清理，去掉 `resume` 重开一轮 |
| 后台作业报 `session "[object Object]" has no live agent` | 0.2 之前的老毛病（owner 传了对象而非 id），0.7.1 起已修 |
| 面板任务条空了 | 面板空态会写一行 `行来源: roster N · tracker M`——把它发出来就能定位是哪一路断的 |

---

## FAQ

**一定要配 `cwd` 吗？** 强烈建议配。不配时它落到宿主进程的 cwd，可能连带加载出错误的项目配置。

**`permissionMode: acceptEdits` 为什么跑不了构建？** 因为 `acceptEdits` 只放行文件编辑。要跑命令就在调用里传 `allowedTools` 预授权。

**它会停下来问我吗？** 不会。插件没有审批桥，未授权的操作直接失败。审核请放在任务书里的验收标准上。

**为什么面板看不到某些长命令的滚动输出？** 那条命令没走实时通道（模型用了内置 Bash）。SDK 转发不了内置 Bash 的 stdout，所以退化成一个 `⏳ 运行中` 心跳。想彻底避免，开 `shellChannelOnly`。

**重启后为什么任务条空了？** 设计如此：作业记录是进程内的，每会话留最近 20 条。历史结果在对话的工具卡片里。

**能用别的模型吗？** 能，但那是 `~/.claude/settings.json` 的别名映射说了算（`model` 传的是别名或完整 id）。本机把 `sonnet` 映到 DeepSeek-V4-Flash 之类的第三方端点时，委派拿到的就不是 Anthropic 模型——这属于配置事实，不是插件行为。

---

## 自己改插件

```bash
npm install --legacy-peer-deps   # 直接 npm install 会因 peer 冲突 ERESOLVE
npm run build                    # 两个半边都构建，然后断言产物齐全
npm run typecheck                # node + client 两个 tsconfig 都查
```

| 半边 | 入口 | 产物 | 怎么构建 |
|---|---|---|---|
| host | `src/index.ts`（+ `tracker.ts` / `remote.ts` / `live-shell.ts` / `delegate-model.ts` / `delegation-skill.ts`） | `lib/*.js` + `lib/types/**` | `tsc -p tsconfig.json` |
| client | `src/client/index.ts` | `lib/client.js`（单文件 CJS，外层包 `window.__ModuleLoader__.load(...)`） | `tsc -p tsconfig.client.json`（只出 d.ts）+ `scripts/build-client.mjs`（esbuild） |

`scripts/assert-artifacts.mjs` 逐个断言产物存在——**新增模块要同步加进清单**，否则漏文件不会被发现。client bundle 只能 `require` shell 给的白名单（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives` 等），构建脚本会检查；其他依赖必须打进 bundle。

本地装上自己改的版本：

```bash
npm run build
cp -R lib/* ~/.dsh/profiles/<profile>/node_modules/dsh-claude-delegate/lib/   # 新模块文件也要一起拷
# 重启 dsh
```

发布：`npm publish`（`publishConfig.access` 已是 public）。发完给 GitHub 仓库打个 **dsh-plugin** topic，就会出现在 github.com/topics/dsh-plugin。

变更记录见 [CHANGELOG.md](CHANGELOG.md)。
