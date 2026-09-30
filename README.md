[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-blue?logo=github)](https://github.com/topics/dsh-plugin) [![npm](https://img.shields.io/npm/v/dsh-claude-delegate)](https://www.npmjs.com/package/dsh-claude-delegate) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

# dsh-claude-delegate

DeepSeek Harness（以下简称 DSH）工具插件：将**边界清晰、自包含的编码子任务**委派给本机 Claude Code 执行，并回收结构化结果。

插件安装后向 DSH 注册一个工具 `claude_code` 与一个监控面板。DSH 负责定义任务目标与验收标准，Claude Code 负责在指定工作目录内完成代码阅读、修改与验证。插件通过官方 [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 驱动本机安装的 `claude` CLI，**不提取、不转发任何 OAuth 凭据**。

本文档依次说明功能特性、安装与配置、参数语义、运行机制、故障处置与开发方式。

---

## 目录

1. [功能特性](#1-功能特性)
2. [系统要求与兼容性](#2-系统要求与兼容性)
3. [安装](#3-安装)
4. [快速开始](#4-快速开始)
5. [工具参数参考](#5-工具参数参考)
6. [插件配置参考](#6-插件配置参考)
7. [监控面板](#7-监控面板)
8. [长命令实时输出通道](#8-长命令实时输出通道)
9. [内置技能](#9-内置技能)
10. [安全与合规](#10-安全与合规)
11. [运行机制](#11-运行机制)
12. [故障排查](#12-故障排查)
13. [常见问题](#13-常见问题)
14. [派生来源与改动说明](#14-派生来源与改动说明)
15. [开发与发布](#15-开发与发布)
16. [许可证](#16-许可证)

---

## 1. 功能特性

| 特性 | 说明 |
|---|---|
| **完整参数控制** | 模型、思考强度、权限模式、允许工具、轮次上限、预算上限、超时、追加系统提示、自定义 subagent 均可按次指定 |
| **后台异步执行** | `run_in_background: true` 立即返回 `jobId`，通过 DSH 原生作业工具增量读取输出，完成后收到通知 |
| **跨轮次续跑** | 结果正文末尾回传 `session: <id>`，将其作为 `resume` 参数传回即可在同一 Claude Code 会话中继续 |
| **长命令实时输出** | 内置独立 shell 通道 `mcp__dsh__shell`，长时间运行的构建/测试命令逐行实时进入面板 |
| **结构化输出** | 传入 JSON Schema（`outputSchema`）即返回符合该模式的 `structuredOutput` |
| **成本可计量** | 结果包含费用、Token 用量与轮次统计，支持 `maxBudgetUsd` 硬上限 |
| **监控面板** | 会话内新增「Claude Code」标签页：任务列表、结构化过程视图、实时输出块、一键取消 |
| **运行时技能注册** | 随插件注册 `claude-code-delegation` 与 `parallel-dev` 技能，安装插件即安装技能，无需在用户目录维护副本 |

## 2. 系统要求与兼容性

| 项 | 要求 |
|---|---|
| DSH 版本 | `>=0.1.0-rc.6 <0.3.0`，已在 `@deepseek-ai/dsh-*@0.2.0-rc.2` 上完成类型检查与构建验证 |
| Node.js | 与 DSH 运行时一致（本仓库使用 Node.js 24 验证） |
| Claude Code CLI | 需在本机安装并完成登录：`npm install -g @anthropic-ai/claude-code` |
| 后台作业 | 依赖 DSH 的作业服务（`dsh-tool-jobs`）；未提供时后台模式返回 `background jobs unavailable` |
| Shell 通道 | 需要 POSIX bash；Windows 下建议安装 Git for Windows 并使用其 `bash.exe` |

## 3. 安装

推荐通过 DSH 插件命令安装（包内自带 `dsh.bundle` 接线清单，安装后自动接线）：

```bash
dsh plugin --profile <profile> add dsh-claude-delegate
```

等价的手动方式：

```bash
cd ~/.dsh/profiles
npm install dsh-claude-delegate
```

随后在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 中确认存在以下接线：

```yaml
- insert:
    - id: claude-code
      name: dsh-claude-delegate
      config:
        model: sonnet
        permissionMode: acceptEdits
        maxTurns: 100
        timeoutMs: 7200000
```

安装后需要重启 DSH。插件自带的接线为**安全默认值**：权限模式为 `acceptEdits`，且不预设代理；仅当本机出网 IP 被判定为数据中心 IP、Anthropic 返回 403 时，才需要自行配置 `proxy`。

### 从源码安装

```bash
npm install --legacy-peer-deps   # 直接 npm install 会因 dsh-system-prompt → dsh-invariants 的 peer 冲突失败
npm run build
cp -R lib/* ~/.dsh/profiles/<profile>/node_modules/dsh-claude-delegate/lib/
```

## 4. 快速开始

在需要委派的工作目录中调用工具：

```json
{
  "task": "修复 src/parser.ts 中 parse() 对空输入崩溃的问题，并补充对应单元测试",
  "cwd": "/absolute/path/to/repo"
}
```

后台执行：

```json
{
  "task": "将 src/ 全量迁移到新的 logger API，并确保 npm run build 通过",
  "cwd": "/absolute/path/to/repo",
  "run_in_background": true
}
```

返回值为 `{ "kind": "background", "jobId": "claude-code-1" }`。随后可使用 DSH 原生作业工具读取增量输出：

```
job_output  { "jobId": "claude-code-1" }   # 读取上次调用之后的新输出
job_list    { }                            # 列出当前作业
job_kill    { "jobId": "claude-code-1" }   # 终止作业
```

作业完成时 DSH 会推送完成通知，无需轮询。继续上一轮会话：

```json
{
  "task": "上一步的修复遗漏了边界情况，请补充并重新运行测试",
  "resume": "<上一轮结果中的 session id>"
}
```

## 5. 工具参数参考

工具名：`claude_code`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `task` | string | 是 | — | 任务描述。应包含目标、涉及文件、约束条件与验收标准 |
| `cwd` | string | 否 | 宿主进程工作目录 | 执行目录，**建议始终传入绝对路径** |
| `model` | string | 否 | 配置值（默认 `sonnet`） | 模型别名或完整模型 ID |
| `permissionMode` | string | 否 | 配置值（默认 `acceptEdits`） | `default` / `acceptEdits` / `bypassPermissions` / `plan` / `dontAsk` / `auto` |
| `allowedTools` | string[] | 否 | 配置值 | 允许 Claude Code 使用的内置工具，例如 `["Read","Write","Edit","Bash","Glob","Grep"]` |
| `maxTurns` | number | 否 | 配置值（默认 `100`） | 最大对话轮次 |
| `effort` | string | 否 | 配置值（默认 `high`） | 思考强度 |
| `thinkingMode` | string | 否 | 配置值 | `adaptive` 或 `disabled` |
| `maxThinkingTokens` | number | 否 | 配置值 | 思考 Token 上限 |
| `maxBudgetUsd` | number | 否 | 配置值 | 美元成本上限，达到后停止 |
| `timeoutMs` | number | 否 | 配置值（默认 `7200000`） | 单次执行硬超时 |
| `appendSystemPrompt` | string | 否 | 配置值 | 追加到系统提示的指令 |
| `run_in_background` | boolean | 否 | `false` | 是否作为后台作业运行 |
| `resume` | string | 否 | — | 续跑指定的 Claude Code 会话 ID |
| `outputSchema` | object | 否 | — | 结构化输出模式（JSON Schema） |
| `subagents` | object | 否 | 配置值 | 自定义 subagent 定义 |
| `proxy` | string | 否 | 配置值 | 传给 claude 子进程的代理地址 |
| `shellChannelOnly` | boolean | 否 | 配置值（默认 `false`） | 设为 `true` 时禁用内置 Bash，所有命令必须经实时通道执行 |

返回内容包含：最终文本、`sessionId`、Token 用量、费用、轮次、耗时与调用过的工具；提供 `outputSchema` 时额外返回 `structuredOutput`。

> **权限说明**：`permissionMode: acceptEdits` 仅自动放行文件编辑，命令执行仍需通过 `allowedTools` 预授权。本插件**未实现审批桥**（`canUseTool`），未授权的操作会直接失败，不会等待人工确认。

## 6. 插件配置参考

在 profile 的 `cordis.patch.yml` 中配置：

```yaml
- insert:
    - id: claude-code
      name: dsh-claude-delegate
      config:
        model: sonnet                # sonnet | opus | haiku | 完整模型 ID
        permissionMode: acceptEdits  # default | acceptEdits | bypassPermissions | plan | dontAsk | auto
        maxTurns: 100
        timeoutMs: 600000
        # cwd: /absolute/path/to/repo
        # maxBudgetUsd: 2
        # appendSystemPrompt: 提交信息一律使用中文；不要修改 lib/ 目录。
        # proxy: http://127.0.0.1:7890
        # allowDangerouslySkipPermissions: true
        # subagents:
        #   reviewer:
        #     description: 复核补丁，仅报告实质问题
        #     prompt: 你是严格的代码复核者，按严重程度排序输出结论。
        #     tools: [Read, Grep, Glob]
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `model` | `sonnet` | 模型别名或完整 ID |
| `effort` | `high` | 思考强度 |
| `permissionMode` | `acceptEdits` | 权限模式 |
| `allowDangerouslySkipPermissions` | `false` | 显式开关；为 `false` 时 `bypassPermissions` 不生效 |
| `maxTurns` | `100` | 轮次上限 |
| `timeoutMs` | `7200000` | 单次硬超时（毫秒） |
| `warnTimeoutMs` | `3600000` | 超时预警阈值；`0` 表示关闭 |
| `warnIntervalMs` | `1800000` | 预警重复间隔；`0` 表示关闭 |
| `cwd` | 未设置 | 默认工作目录 |
| `allowedTools` | 未设置 | 默认允许的工具集合 |
| `pathToClaudeCodeExecutable` | 自动探测 | `claude` 可执行文件路径 |
| `proxy` | 未设置 | 写入子进程的 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` |
| `subagents` | 未设置 | 自定义 subagent 定义表 |
| `shellChannel` | `true` | 是否启用长命令实时输出通道 |
| `shellChannelOnly` | `false` | 是否禁用内置 Bash（仅保留实时通道） |
| `shellPath` | 自动探测 | bash 可执行文件路径 |
| `shellTimeoutMs` | `900000` | 实时通道单条命令默认超时（毫秒） |

## 7. 监控面板

DSH 会话顶部「对话 / 轨迹」旁新增 **Claude Code** 标签页，用于观察当前会话内所有后台委派任务。

- **任务列表**：每条后台作业一个标签，颜色指示状态（运行中、完成、失败、已取消）；运行中的任务排在最前，已结束的任务按时间倒序排列。
- **详情弹窗**：标签上的 `ⓘ` 打开，显示完整任务文本、模型、状态、起止时间、耗时、费用、轮次、Claude Code 会话 ID（可复制后直接用作 `resume`）与失败原因。
- **过程视图**：助手文本以 Markdown 渲染（标题、粗体、行内代码、代码块、列表、引用、链接，可切换原文/预览）；思考块默认折叠；每次工具调用显示为一张卡片（工具名、参数、结果、运行时长），任务结束时显示汇总行。
- **实时输出块**：经实时通道执行的命令显示为终端块，包含命令行、逐行输出（stderr 单独着色）与退出码、耗时。
- **取消**：确认后终止子进程树，作业按 `killed` 结算，模型侧同样收到完成通知。

实现约定：

- 面板按**绝对偏移**读取输出，与模型侧 `job_output` 的游标相互独立，各自翻阅互不影响。
- 作业记录保存在当前 DSH 进程内，每个会话保留最近 20 条，进程重启后清空；历史结果仍可在对话的工具卡片中查看。
- 修改插件的客户端部分后**必须重启 DSH**，桌面端不提供硬刷新。

## 8. 长命令实时输出通道

### 设计动因

Claude Agent SDK 的消息联合中**不包含工具输出帧**：工具执行期间只产生进度心跳（`tool_progress`），执行结束后才返回一次 `tool_result`。CLI 自身持有 Bash 的管道，不向 SDK 转发增量输出。因此，若要让用户看到长时间命令的实时输出，插件必须自行创建执行通道。

### 实现方式

插件注册一个进程内 MCP Server（名称 `dsh`），对外提供工具 `mcp__dsh__shell`。命令由插件自身 `spawn`（`bash -lc`），输出因此可以先进入插件的事件流，再按需提供给模型。插件的系统提示会提示模型：**预计运行超过 20 秒的命令应通过该通道执行**。

| 参数 | 必填 | 说明 |
|---|---|---|
| `command` | 是 | 待执行命令 |
| `cwd` | 否 | 执行目录，默认使用委派的工作目录 |
| `timeoutMs` | 否 | 单条命令超时，默认 15 分钟；超时终止整棵进程树（Windows 使用 `taskkill /T /F`） |
| `purpose` | 否 | 一句话说明，显示在面板的命令行上 |

### 行为约束

- 通道输出**仅进入面板，不进入 `job_output`**，避免大量构建日志占用模型上下文；因此无论执行何种命令，**结论与关键输出必须在回复正文中给出**。
- 输出解码优先使用 UTF-8，出现替换字符时回退到 GBK，以适配中文 Windows 环境。
- 每次调用均为**独立进程**，`cd`、`export` 等状态不跨调用保留；短命令与需要保持 shell 状态的命令仍应使用内置 Bash。
- 将 `shellChannelOnly` 设为 `true` 可禁用内置 Bash，使所有命令都经实时通道执行，代价是失去 shell 状态连续性。
- 未检测到可用 bash 时，工具会明确提示模型改用内置 Bash，不会静默失败。

## 9. 内置技能

插件在运行时注册以下技能（`source: runtime`），因此**无需**向 `~/.dsh/skills/` 放置副本，避免出现两份内容不一致的说明：

| 技能 | 内容 |
|---|---|
| `claude-code-delegation` | 任务书模板与硬约束、开派前置检查、`outputSchema` 骨架、回传验收流程，以及本插件的参数、后台作业、实时通道、面板与超时机制 |
| `parallel-dev` | 并行开发编排：任务拆分、worktree 与分支管理、并行分派与结果集成 |

## 10. 安全与合规

- 插件通过官方 CLI 与官方 Agent SDK 调用 Claude Code，符合 Anthropic 的认证与订阅要求。
- 插件**不读取、不转发、不落盘**任何 OAuth 凭据；不存在将 Claude 订阅当作裸模型接入的实现。
- Claude Code 在本地以当前用户权限执行工具，DSH 的沙箱与权限策略**不作用于**其工具调用。请将 `cwd` 与 `permissionMode` 限制在可信范围内。
- 插件没有审批交互：未授权的操作直接失败，不会暂停等待人工确认。审核应体现在任务书的验收标准中。
- **模型来源须如实说明**：插件驱动的是 Claude Code CLI 外壳，其底层模型由本机 `~/.claude/settings.json`（`ANTHROPIC_BASE_URL` 与模型别名映射）决定，**不一定是 Anthropic 的模型**。因此不应将结果表述为「来自 Claude」，准确表述是「以 Claude Code 方式（外壳）运行」。

## 11. 运行机制

| 部分 | 入口 | 产物 | 构建方式 |
|---|---|---|---|
| 宿主侧 | `src/index.ts`，以及 `tracker.ts`、`remote.ts`、`live-shell.ts`、`delegate-model.ts`、`delegation-skill.ts` | `lib/*.js` 与 `lib/types/**` | `tsc -p tsconfig.json` |
| 客户端侧 | `src/client/index.ts` | 单文件 `lib/client.js`（CJS，外层为 `window.__ModuleLoader__.load(...)`） | `tsc -p tsconfig.client.json`（仅生成声明）+ `scripts/build-client.mjs`（esbuild） |

- 委派执行：宿主侧创建 SDK 会话，将 SDK 消息转写为面板事件（文本、思考块、工具卡片、进度、结果），并把实时输出增量镜像到事件流。
- 作业管理：后台作业通过 DSH 作业服务登记，插件自有的 tracker 维护每个作业的元数据与输出缓冲；面板行数据由作业服务名册、0.1.x 镜像与插件 tracker 三路合并得到。
- 客户端侧仅允许 `require` DSH shell 提供的白名单依赖（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives` 等），其余依赖必须打包进产物；构建脚本会对此进行断言。
- `scripts/assert-artifacts.mjs` 逐个断言产物存在；**新增模块时必须同步更新该清单**，否则遗漏文件不会被发现。

## 12. 故障排查

| 现象 | 处理方式 |
|---|---|
| `claude executable not found` | 安装 CLI（`npm install -g @anthropic-ai/claude-code`），或通过 `pathToClaudeCodeExecutable` 指定路径 |
| 实时通道提示找不到 bash | Windows 下安装 Git for Windows，或通过 `shellPath` 指向其 `bash.exe`；不要使用 `WindowsApps\bash.exe`（WSL 占位程序） |
| `cwd does not exist or is not a directory` | 传入存在的绝对路径；未传时使用宿主进程工作目录 |
| 认证失败或计费错误 | 先在终端手动执行一次 `claude` 完成登录，并确认订阅状态 |
| 限流或过载 | 稍后重试，或降低 `effort`、拆分任务 |
| 返回 403（出网 IP 被判定为数据中心 IP） | 通过 `proxy` 指定本机代理，或为 DSH 进程设置 `HTTPS_PROXY` 后重启 |
| `bypassPermissions` 未生效 | 设计如此：需同时显式设置 `allowDangerouslySkipPermissions: true`，否则请改用 `acceptEdits` 或 `auto` |
| 达到 `maxBudgetUsd` | 提高预算上限，或拆分任务 |
| `resume` 报 `no conversation found` | 该会话已被清理，去掉 `resume` 重新开始 |
| 后台作业报 `session "[object Object]" has no live agent` | DSH 0.2 之前的兼容问题，0.7.1 起已修复 |
| 面板任务列表为空 | 空状态会显示 `row sources: roster N · tracker M`，据此判断是作业服务名册还是插件 tracker 未返回数据 |

## 13. 常见问题

**是否必须指定 `cwd`？**
建议始终指定。省略时会使用宿主进程的工作目录，可能加载到与目标项目无关的配置。

**为什么 `acceptEdits` 下无法执行构建或测试？**
`acceptEdits` 仅放行文件编辑。需要在调用中通过 `allowedTools` 显式预授权命令执行。

**执行过程中会请求确认吗？**
不会。插件未实现审批桥，未授权的操作直接失败。审核应在任务书的验收标准中完成。

**为什么某些长命令在面板中没有实时输出？**
该命令经内置 Bash 执行，而 SDK 不转发内置 Bash 的输出，面板只能显示运行中状态。将 `shellChannelOnly` 设为 `true` 可强制所有命令经实时通道执行。

**重启后任务列表为什么为空？**
作业记录保存在进程内，每个会话保留最近 20 条。历史结果可在对话的工具卡片中查看。

**可以指定其他模型吗？**
可以，但最终生效的模型由本机 `~/.claude/settings.json` 的别名映射决定。`model` 参数传入的是别名或完整 ID。

## 14. 派生来源与改动说明

本仓库是衍生项目，上游为 [zhangjunjesse/dsh-claude-code](https://github.com/zhangjunjesse/dsh-claude-code)（其 npm 包仅发布至 0.1.2），本仓库在其 0.6.0 基础上继续开发。为避免与上游重名，**包名与仓库名均改为 `dsh-claude-delegate`**；上游保留在 `upstream` remote，可通过 `git fetch upstream` 获取。

相对上游的主要改动：

| 类别 | 内容 |
|---|---|
| 平台适配 | 适配 DSH 0.2 线（作业 owner 传 session id、结算文本读取 `outcome.result`、客户端从 `ctx.jobs` 读取作业名册、文本增量逐字进入事件流） |
| 新增能力 | 长命令实时输出通道 `mcp__dsh__shell`；监控面板（任务列表、结构化过程视图、实时输出块、取消操作） |
| 修复 | `resume` 参数回传与 `session: <id>` 输出；面板切换标签后任务列表丢失的问题 |
| 结构调整 | 技能改为运行时注册；移除额度与用量相关工具、面板与 RPC |
| 默认值修正 | 移除上游随包的开发机 `proxy: 127.0.0.1:7897`（本机无该服务，会导致委派必然失败）与 `bypassPermissions` + `allowDangerouslySkipPermissions` 默认值 |

## 15. 开发与发布

```bash
npm install --legacy-peer-deps
npm run typecheck     # 宿主侧与客户端侧类型检查
npm run build         # 构建两侧并断言产物完整
```

本地部署与发布：

```bash
npm run build
cp -R lib/* ~/.dsh/profiles/<profile>/node_modules/dsh-claude-delegate/lib/   # 新增模块文件需一并复制
# 重启 DSH
npm publish --access public
```

发布后建议为 GitHub 仓库添加 `dsh-plugin` 主题标签，以便出现在 [github.com/topics/dsh-plugin](https://github.com/topics/dsh-plugin)；如需进入社区插件市场（dshmarket），需向精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提交条目。

变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 16. 许可证

[MIT](LICENSE)
