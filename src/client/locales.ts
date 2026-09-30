/**
 * Self-contained zh/en copy for the monitor panel.
 *
 * The panel deliberately does not inject the `locale` service: it only needs
 * two dictionaries and no live language switching, and staying off that service
 * keeps the bundle's `inject` list to `slots` + `connection`. The active
 * language follows the document, then the browser, and falls back to Chinese.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'view.label': 'Claude Code',
  'list.title': '委派任务',
  'list.empty.title': '暂无 Claude Code 委派任务',
  'list.empty.hint': '在对话里让我用 run_in_background: true 派一个试试。',
  'list.empty.note': '任务只存在于当前 DSH 进程内，重启后列表为空；历史结果看对话里的工具卡片。',
  'status.running': '运行中',
  'status.completed': '已完成',
  'status.failed': '已失败',
  'status.killed': '已取消',
  'detail.job': '任务 id',
  'detail.session': 'Claude 会话',
  'detail.session.hint': '作为 resume 参数可续接该会话',
  'detail.title': '任务详情',
  'detail.open': '详情',
  'detail.close': '关闭',
  'detail.task': '任务内容',
  'detail.model': '模型',
  'detail.status': '状态',
  'detail.startedAt': '开始于',
  'detail.finishedAt': '结束于',
  'detail.duration': '耗时',
  'detail.cost': '费用',
  'detail.turns': '轮数',
  'detail.failure': '失败原因',
  'stats.turns': '轮',
  'stats.cost': '费用',
  'stats.duration': '耗时',
  'action.cancel': '取消',
  'action.cancel.confirm': '确定取消这个任务？Claude Code 会被中止。',
  'action.copyOutput': '复制输出',
  'action.copySession': '复制会话 id',
  'action.copied': '已复制',
  'output.title': '实时输出',
  'output.empty': '还没有输出…',
  'output.truncated': '…更早的输出已被截断…',
  'output.follow': '↓ 回到底部',
  'output.collapse': '收起',
  'output.expand': '展开',
  'output.raw': '原文',
  'output.preview': '预览',
  'events.title': 'Claude Code 输出',
  'events.empty': '还没有输出…',
  'events.truncated': '…更早的事件已被截断…',
  'events.thinking': '💭 思考中…（点击展开）',
  'events.thinkingLabel': '思考',
  'events.toolResult': '结果',
  'events.toolError': '出错',
  'events.toolRunning': '运行中',
  'events.shellOut': '▶ 实时输出',
  'events.result': '完成',
  'error.prefix': '读取失败',
  'select.empty': '选择上方的任务查看输出',
  'select.sources': '行来源',
}

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<keyof typeof zh, string> = {
  'view.label': 'Claude Code',
  'list.title': 'Delegations',
  'list.empty.title': 'No Claude Code delegations yet',
  'list.empty.hint': 'Ask me to delegate one with run_in_background: true.',
  'list.empty.note': 'Jobs live only inside the current DSH process; the list is empty after a restart. Past results stay in the conversation tool cards.',
  'status.running': 'running',
  'status.completed': 'completed',
  'status.failed': 'failed',
  'status.killed': 'cancelled',
  'detail.job': 'job id',
  'detail.session': 'Claude session',
  'detail.session.hint': 'pass it back as resume to continue this session',
  'detail.title': 'Job details',
  'detail.open': 'Details',
  'detail.close': 'Close',
  'detail.task': 'Task',
  'detail.model': 'Model',
  'detail.status': 'Status',
  'detail.startedAt': 'Started',
  'detail.finishedAt': 'Finished',
  'detail.duration': 'Took',
  'detail.cost': 'Cost',
  'detail.turns': 'Turns',
  'detail.failure': 'Failure',
  'stats.turns': 'turns',
  'stats.cost': 'cost',
  'stats.duration': 'took',
  'action.cancel': 'Cancel',
  'action.cancel.confirm': 'Cancel this job? Claude Code will be aborted.',
  'action.copyOutput': 'Copy output',
  'action.copySession': 'Copy session id',
  'action.copied': 'Copied',
  'output.title': 'Live output',
  'output.empty': 'No output yet…',
  'output.truncated': '…earlier output truncated…',
  'output.follow': '↓ Back to bottom',
  'output.collapse': 'Collapse',
  'output.expand': 'Expand',
  'output.raw': 'Raw',
  'output.preview': 'Preview',
  'events.title': 'Claude Code output',
  'events.empty': 'No output yet…',
  'events.truncated': '…earlier events truncated…',
  'events.thinking': '💭 Thinking… (click to expand)',
  'events.thinkingLabel': 'Thinking',
  'events.toolResult': 'Result',
  'events.toolError': 'Error',
  'events.toolRunning': 'Running',
  'events.shellOut': '▶ live output',
  'events.result': 'Completed',
  'error.prefix': 'Read failed',
  'select.empty': 'Pick a job above to see its output',
  'select.sources': 'row sources',
}

/** Translation key set. */
export type LocaleKey = keyof typeof zh

function isChinese(): boolean {
  const documentLang = typeof document !== 'undefined' ? document.documentElement.lang : ''
  const navigatorLang = typeof navigator !== 'undefined' ? navigator.language : ''
  const lang = (documentLang || navigatorLang || 'zh').toLowerCase()
  return lang.startsWith('zh') || lang === ''
}

/** Resolve one copy key in the active language. */
export function t(key: LocaleKey): string {
  return (isChinese() ? zh : en)[key]
}

/** Resolve one copy key and substitute its single `{n}` placeholder. */
export function tf(key: LocaleKey, value: string | number): string {
  return t(key).replace('{n}', String(value))
}
