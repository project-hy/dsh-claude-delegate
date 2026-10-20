/**
 * Panel stylesheet, injected once per page as a plain `<style>` tag (the same
 * shape the harness's own bundles use for their CSS modules). Every colour is a
 * primitives theme variable so light/dark follow the app; nothing is hardcoded.
 *
 * The root carries `data-conversation-composer-overlay`, which makes the
 * conversation shell stop scrolling the view area and float the composer over
 * the bottom instead — so the panel owns its own scrolling and reserves the
 * composer's height itself (`--ccp-composer-clearance`).
 */

/** Class-name prefix shared by every rule below. */
export const CSS = {
  root: 'ccp-root',
  body: 'ccp-body',
  tabs: 'ccp-tabs',
  tab: 'ccp-tab',
  tabActive: 'ccp-tabActive',
  tabMain: 'ccp-tabMain',
  tabDot: 'ccp-tabDot',
  tabDotRunning: 'ccp-tabDotRunning',
  tabDotDone: 'ccp-tabDotDone',
  tabDotFailed: 'ccp-tabDotFailed',
  tabDotKilled: 'ccp-tabDotKilled',
  tabLabel: 'ccp-tabLabel',
  tabCount: 'ccp-tabCount',
  tabInfo: 'ccp-tabInfo',
  modalOverlay: 'ccp-modalOverlay',
  modal: 'ccp-modal',
  modalHead: 'ccp-modalHead',
  modalTitle: 'ccp-modalTitle',
  modalClose: 'ccp-modalClose',
  modalBody: 'ccp-modalBody',
  modalRow: 'ccp-modalRow',
  modalKey: 'ccp-modalKey',
  modalValue: 'ccp-modalValue',
  modalTask: 'ccp-modalTask',
  modalFailure: 'ccp-modalFailure',
  modalFoot: 'ccp-modalFoot',
  pane: 'ccp-pane',
  paneMulti: 'ccp-paneMulti',
  paneHead: 'ccp-paneHead',
  stats: 'ccp-stats',
  stat: 'ccp-stat',
  groupHead: 'ccp-groupHead',
  registerBar: 'ccp-registerBar',
  registerToggle: 'ccp-registerToggle',
  registerList: 'ccp-registerList',
  registerRow: 'ccp-registerRow',
  registerEmpty: 'ccp-registerEmpty',
  userRow: 'ccp-userRow',
  userStack: 'ccp-userStack',
  bubble: 'ccp-bubble',
  output: 'ccp-output',
  outputBody: 'ccp-outputBody',
  outputLine: 'ccp-outputLine',
  outputTool: 'ccp-outputTool',
  outputNotice: 'ccp-outputNotice',
  events: 'ccp-events',
  eventsBody: 'ccp-eventsBody',
  evText: 'ccp-evText',
  evTextRaw: 'ccp-evTextRaw',
  md: 'ccp-md',
  mdRaw: 'ccp-mdRaw',
  mdP: 'ccp-mdP',
  mdH1: 'ccp-mdH1',
  mdH2: 'ccp-mdH2',
  mdH3: 'ccp-mdH3',
  mdH4: 'ccp-mdH4',
  mdH5: 'ccp-mdH5',
  mdH6: 'ccp-mdH6',
  mdStrong: 'ccp-mdStrong',
  mdEm: 'ccp-mdEm',
  mdCode: 'ccp-mdCode',
  mdPre: 'ccp-mdPre',
  mdPreCode: 'ccp-mdPreCode',
  mdQuote: 'ccp-mdQuote',
  mdList: 'ccp-mdList',
  mdItem: 'ccp-mdItem',
  mdLink: 'ccp-mdLink',
  mdHr: 'ccp-mdHr',
  evThinking: 'ccp-evThinking',
  evThinkingHead: 'ccp-evThinkingHead',
  evThinkingBody: 'ccp-evThinkingBody',
  evTool: 'ccp-evTool',
  evToolHead: 'ccp-evToolHead',
  evToolBadge: 'ccp-evToolBadge',
  evToolParams: 'ccp-evToolParams',
  evToolParamsFull: 'ccp-evToolParamsFull',
  evToolResult: 'ccp-evToolResult',
  evToolResultHead: 'ccp-evToolResultHead',
  evToolResultBody: 'ccp-evToolResultBody',
  evToolError: 'ccp-evToolError',
  evConsole: 'ccp-evConsole',
  evConsoleHead: 'ccp-evConsoleHead',
  evConsoleBody: 'ccp-evConsoleBody',
  evConsoleErr: 'ccp-evConsoleErr',
  evConsoleMeta: 'ccp-evConsoleMeta',
  evTerminalCmd: 'ccp-evTerminalCmd',
  evTerminalBody: 'ccp-evTerminalBody',
  evPersisted: 'ccp-evPersisted',
  evPersistedHead: 'ccp-evPersistedHead',
  evPersistedBody: 'ccp-evPersistedBody',
  evResultActions: 'ccp-evResultActions',
  evResult: 'ccp-evResult',
  evWarning: 'ccp-evWarning',
  evMore: 'ccp-evMore',
  follow: 'ccp-follow',
  actions: 'ccp-actions',
  button: 'ccp-button',
  danger: 'ccp-danger',
  empty: 'ccp-empty',
  emptyTitle: 'ccp-emptyTitle',
  error: 'ccp-error',
  mono: 'ccp-mono',
} as const

/** How many tool-badge tints the stylesheet defines. */
const TOOL_TONES = 6

/**
 * Stable tint for one tool name, so `Edit` always reads the same colour within
 * and across runs. A tiny FNV-ish hash keeps it deterministic and dependency-free.
 */
export function toolToneClass(name: string): string {
  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0
  }
  return `ccp-evTone${hash % TOOL_TONES}`
}

const STYLE_ID = 'dsh-claude-delegate-panel'

const CSS_TEXT = `
.ccp-root {
  --ccp-composer-clearance: 148px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  padding: 12px 16px var(--ccp-composer-clearance);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
}
.ccp-root * { box-sizing: border-box; }
/* Task tab strip on top, output pane below. */
.ccp-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
}

/* --- task tab strip --- */
.ccp-tabs {
  display: flex;
  align-items: stretch;
  gap: 6px;
  flex: none;
  min-width: 0;
  padding-bottom: 4px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}
.ccp-tab {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
  max-width: 200px;
  padding: 0 4px 0 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--dsw-alias-fill-l1);
  transition: background 120ms ease, border-color 120ms ease;
}
.ccp-tab:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ccp-tabActive {
  background: var(--dsw-alias-fill-l2);
  border-color: var(--dsw-alias-state-business-primary);
}
.ccp-tabMain {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 5px 2px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.ccp-tabLabel {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ccp-tabActive .ccp-tabMain { font-weight: 600; }
/* Run counter on a tab that holds a whole conversation, not a single call. */
.ccp-tabCount {
  flex: none;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--dsw-alias-fill-l2);
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
  line-height: 14px;
  font-variant-numeric: tabular-nums;
}
.ccp-tabDot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--dsw-alias-label-tertiary);
}
.ccp-tabDotRunning {
  background: var(--dsw-alias-state-info, var(--dsw-alias-state-business-primary, #3b82f6));
  animation: ccp-breathe 1.6s ease-in-out infinite;
}
.ccp-tabDotDone { background: var(--dsw-alias-state-success, #3d9970); }
.ccp-tabDotFailed { background: var(--dsw-alias-state-error, #d05353); }
.ccp-tabDotKilled { background: var(--dsw-alias-label-tertiary); }
@keyframes ccp-breathe {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.78); }
}
.ccp-tabInfo {
  flex: none;
  padding: 0 3px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.ccp-tabInfo:hover {
  background: var(--dsw-alias-fill-l2);
  color: var(--dsw-alias-state-business-primary);
}

/* --- job detail modal --- */
.ccp-modalOverlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.42);
}
.ccp-modal {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(560px, 90vw);
  max-height: min(72vh, 640px);
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-shadow-lv3);
}
.ccp-modalHead { display: flex; align-items: center; gap: 8px; flex: none; }
.ccp-modalTitle { flex: 1; font-size: 14px; line-height: 20px; font-weight: 600; }
.ccp-modalClose {
  flex: none;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.ccp-modalClose:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ccp-modalBody {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.ccp-modalRow { display: flex; gap: 10px; align-items: baseline; font-size: 12px; line-height: 18px; }
.ccp-modalKey {
  flex: none;
  width: 84px;
  color: var(--dsw-alias-label-tertiary);
}
.ccp-modalValue {
  flex: 1;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  word-break: break-word;
  font-variant-numeric: tabular-nums;
}
.ccp-modalTask {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-fill-l1);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-word;
}
.ccp-modalFailure { color: var(--dsw-alias-state-error, #d05353); }
.ccp-modalFoot { display: flex; flex: none; flex-wrap: wrap; gap: 8px; }
.ccp-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
/* A conversation of several runs flows in one scroller — the pane itself — and
   each run keeps its natural height. Without this every run's own scroll box
   shares one fixed pane height and the earlier replies are squeezed to a sliver. */
.ccp-paneMulti { overflow-y: auto; }
.ccp-paneMulti > * { flex: none; }
.ccp-paneMulti .ccp-events,
.ccp-paneMulti .ccp-output {
  flex: none;
  overflow: visible;
  border: none;
  border-radius: 0;
  background: transparent;
}
.ccp-paneMulti .ccp-eventsBody,
.ccp-paneMulti .ccp-outputBody {
  height: auto;
  overflow: visible;
  padding: 0;
}
/* The per-run "back to bottom" pill belongs to a scroll box, not to the pane. */
.ccp-paneMulti .ccp-follow { display: none; }
.ccp-paneHead { display: flex; flex-direction: column; gap: 4px; flex: none; }
/* Separates the runs of one conversation inside the pane. */
.ccp-registerBar {
  display: flex;
  align-items: center;
  padding: 2px 10px 4px;
  flex: none;
}

.ccp-registerToggle {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 18px;
  cursor: pointer;
  padding: 0;
}

.ccp-registerToggle:hover {
  color: var(--dsw-alias-label-primary);
}

.ccp-registerList {
  margin: 0 10px 6px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-fill-l2);
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: none;
}

.ccp-registerRow {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.ccp-registerEmpty {
  margin: 0 10px 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}

.ccp-groupHead {
  flex: none;
  margin-top: 6px;
  padding: 4px 8px;
  border-left: 2px solid var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-fill-l2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
}
/* --- the task each run was given, drawn the way the main chat draws a user turn --- */
.ccp-userRow {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex: none;
}
.ccp-userStack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  min-width: 0;
  max-width: min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%);
}
.ccp-bubble {
  max-width: 100%;
  padding: 10px 16px;
  border-radius: 22px;
  background: var(--dsw-specific-bubble, var(--dsw-alias-fill-l2));
  color: var(--dsw-alias-label-primary);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(22px + var(--dsh-content-font-delta, 0px));
  white-space: pre-wrap;
  word-break: break-word;
}
.ccp-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.ccp-stat { white-space: nowrap; }
.ccp-output {
  position: relative;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-fill-l1);
  overflow: hidden;
}
.ccp-outputBody {
  height: 100%;
  overflow: auto;
  padding: 10px 12px;
  margin: 0;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-word;
}
.ccp-outputLine { display: block; }
.ccp-outputTool {
  display: block;
  font-weight: 600;
  color: var(--dsw-alias-state-business-primary);
}
.ccp-outputNotice { display: block; color: var(--dsw-alias-label-tertiary); }

/* --- structured event stream (native-style rendering) --- */
.ccp-events {
  position: relative;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-fill-l1);
  overflow: hidden;
}
.ccp-eventsBody {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  overflow: auto;
  padding: 10px 12px;
}
/* Assistant text is rendered Markdown, so the container is ordinary block flow
   (the block elements md.ts emits own their own spacing) rather than pre-wrap. */
.ccp-evText {
  word-break: break-word;
  /* Same size and rhythm as the main chat's assistant prose. */
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-primary);
}
.ccp-evTextRaw {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

/* --- rendered markdown (see md.ts) --- */
.ccp-md {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  /* The main chat's own prose metrics, so replies read the same here. */
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-primary);
}
/* Fallback when the parser refused the source: show it verbatim. */
.ccp-mdRaw {
  white-space: pre-wrap;
  word-break: break-word;
}
.ccp-mdP { margin: 0; }
.ccp-mdH1, .ccp-mdH2, .ccp-mdH3, .ccp-mdH4, .ccp-mdH5, .ccp-mdH6 {
  margin: 0;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.ccp-mdH1 { font-size: 17px; line-height: 24px; }
.ccp-mdH2 { font-size: 15px; line-height: 22px; }
.ccp-mdH3 { font-size: 14px; line-height: 20px; }
.ccp-mdH4 { font-size: 13px; line-height: 20px; }
.ccp-mdH5 { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.ccp-mdH6 { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.ccp-mdStrong { font-weight: 600; }
.ccp-mdEm { font-style: italic; }
.ccp-mdCode {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--dsw-alias-fill-l2);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  word-break: break-word;
}
.ccp-mdPre {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-fill-l2);
  overflow-x: auto;
}
.ccp-mdPreCode {
  display: block;
  white-space: pre;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
}
.ccp-mdQuote {
  margin: 0;
  padding: 2px 0 2px 10px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}
.ccp-mdQuote > * + * { margin-top: 6px; }
/* Not a flex container: flex items lose their list markers. */
.ccp-mdList { margin: 0; padding-left: 20px; }
.ccp-mdItem { margin: 0; }
.ccp-mdItem + .ccp-mdItem { margin-top: 2px; }
.ccp-mdLink {
  color: var(--dsw-alias-state-business-primary);
  text-decoration: underline;
  word-break: break-all;
}
.ccp-mdHr {
  margin: 2px 0;
  border: none;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.ccp-evThinking {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 8px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
  font-style: italic;
}
.ccp-evThinkingHead {
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.ccp-evThinkingHead:hover { color: var(--dsw-alias-label-secondary); }
.ccp-evThinkingBody {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
}
/* A tool call reads as one line of the conversation, not as a card. */
.ccp-evTool {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ccp-evToolHead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ccp-evToolBadge {
  flex: none;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  font-weight: 500;
}
.ccp-evTone0 { color: var(--dsw-alias-state-business-primary); }
.ccp-evTone1 { color: var(--dsw-alias-state-success, #3d9970); }
.ccp-evTone2 { color: var(--dsw-alias-state-warning, #c98a2e); }
.ccp-evTone3 { color: var(--dsw-alias-state-error, #d05353); }
.ccp-evTone4 { color: var(--dsw-alias-label-secondary); }
.ccp-evTone5 { color: var(--dsw-alias-state-business-secondary, #7a6ff0); }
.ccp-evToolParams {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.ccp-evToolParamsFull {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.ccp-evToolResult {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* The main chat indents a tool's detail by 22px under its summary line. */
  margin-left: 22px;
  padding-left: 8px;
  border-left: 2px solid var(--dsw-alias-border-l2);
}
.ccp-evToolResultHead {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.ccp-evToolResultBody {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.ccp-evToolError { color: var(--dsw-alias-state-error, #d05353); }

/* --- live shell channel (mcp__dsh__shell): the command's own output, live --- */
.ccp-evConsole {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-fill-l1);
  overflow: hidden;
}
.ccp-evConsoleHead {
  padding: 3px 8px;
  background: var(--dsw-alias-fill-l2);
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.ccp-evConsoleBody {
  margin: 0;
  max-height: 320px;
  overflow: auto;
  padding: 6px 8px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
/* The channel's header/footer lines ($ command / exit 0 · 12.3s): dim, no box. */
.ccp-evConsoleMeta {
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  white-space: pre-wrap;
  word-break: break-word;
}
.ccp-evConsoleErr { color: var(--dsw-alias-state-error, #d05353); }

/* --- built-in Bash / PowerShell: command line + output read as a terminal --- */
.ccp-evTerminalCmd {
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
/* Modifier on .ccp-evToolResultBody: a bordered, scrollable terminal pane. */
.ccp-evTerminalBody {
  max-height: 320px;
  overflow: auto;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-fill-l1);
}
/* --- the CLI's own persisted output file, read back on demand --- */
.ccp-evPersisted {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-fill-l1);
}
.ccp-evPersistedHead {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.ccp-evPersistedBody {
  margin: 0;
  max-height: 420px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.ccp-evResultActions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.ccp-evWarning {
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-state-warning, #c98a1f);
  border-radius: 6px;
  background: color-mix(in srgb, var(--dsw-alias-state-warning, #c98a1f) 12%, transparent);
  color: var(--dsw-alias-state-warning, #c98a1f);
  font-size: 12px;
  line-height: 18px;
  font-weight: 600;
}
.ccp-evResult {
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-fill-l2);
  color: var(--dsw-alias-state-business-primary);
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}
.ccp-evMore {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--dsw-alias-state-business-primary);
  font: inherit;
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
}
.ccp-evMore:hover { text-decoration: underline; }

.ccp-follow {
  position: absolute;
  right: 12px;
  bottom: 12px;
  padding: 4px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
  box-shadow: var(--dsw-shadow-lv3);
}
.ccp-actions { display: flex; flex: none; flex-wrap: wrap; gap: 8px; }
.ccp-button {
  padding: 4px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.ccp-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ccp-button:disabled { opacity: 0.5; cursor: default; }
.ccp-danger { color: var(--dsw-alias-state-error, #d05353); }
.ccp-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
}
.ccp-emptyTitle { font-size: 14px; color: var(--dsw-alias-label-secondary); }
.ccp-error {
  flex: none;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--dsw-alias-fill-l2);
  color: var(--dsw-alias-state-error, #d05353);
  font-size: 12px;
  line-height: 18px;
}
.ccp-mono {
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
`

/** Install the stylesheet once; safe to call on every activation. */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.dataset['plugin'] = 'dsh-claude-delegate'
  tag.textContent = CSS_TEXT
  document.head.appendChild(tag)
}
