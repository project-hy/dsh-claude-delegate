window.__ModuleLoader__.load({
	id: "dsh-claude-delegate",
	factory: (require) => {
var module = { exports: {} };
var exports = module.exports;

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/api.ts
var ClaudeCodeApiError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ClaudeCodeApiError";
  }
};
function isResult(value) {
  return typeof value === "object" && value !== null && "ok" in value;
}
function text(value) {
  return typeof value === "string" ? value : "";
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : void 0;
}
function toEvent(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const event = raw;
  switch (event["type"]) {
    case "text":
      return { type: "text", text: text(event["text"]) };
    case "thinking":
      return {
        type: "thinking",
        thinking: text(event["thinking"]),
        ...typeof event["signature"] === "string" ? { signature: event["signature"] } : {}
      };
    case "tool_use":
      return {
        type: "tool_use",
        ...typeof event["id"] === "string" ? { id: event["id"] } : {},
        name: text(event["name"]) || "tool",
        input: event["input"]
      };
    case "tool_result": {
      const totalChars = finite(event["totalChars"]);
      const omittedChars = finite(event["omittedChars"]);
      return {
        type: "tool_result",
        tool_use_id: typeof event["tool_use_id"] === "string" ? event["tool_use_id"] : null,
        content: text(event["content"]),
        ...event["isError"] === true ? { isError: true } : {},
        ...totalChars !== void 0 ? { totalChars } : {},
        ...omittedChars !== void 0 ? { omittedChars } : {},
        ...typeof event["outputPath"] === "string" ? { outputPath: event["outputPath"] } : {}
      };
    }
    case "tool_progress":
      return {
        type: "tool_progress",
        tool_use_id: typeof event["tool_use_id"] === "string" ? event["tool_use_id"] : "",
        tool_name: text(event["tool_name"]) || "tool",
        elapsedSeconds: typeof event["elapsedSeconds"] === "number" ? event["elapsedSeconds"] : 0
      };
    case "console":
      return {
        type: "console",
        stream: event["stream"] === "stderr" ? "stderr" : event["stream"] === "meta" ? "meta" : "stdout",
        text: text(event["text"]),
        ...typeof event["run"] === "string" ? { run: event["run"] } : {},
        ...event["phase"] === "start" || event["phase"] === "end" ? { phase: event["phase"] } : {}
      };
    case "result":
      return {
        type: "result",
        text: text(event["text"]),
        ...typeof event["costUsd"] === "number" ? { costUsd: event["costUsd"] } : {},
        ...typeof event["numTurns"] === "number" ? { numTurns: event["numTurns"] } : {},
        ...typeof event["durationMs"] === "number" ? { durationMs: event["durationMs"] } : {},
        ...event["isError"] === true ? { isError: true } : {},
        ...finite(event["totalChars"]) !== void 0 ? { totalChars: finite(event["totalChars"]) } : {},
        ...finite(event["omittedChars"]) !== void 0 ? { omittedChars: finite(event["omittedChars"]) } : {}
      };
    default:
      return null;
  }
}
function toWorkstream(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw;
  const str = (key) => typeof value[key] === "string" ? value[key] : "";
  const opt = (key) => str(key) === "" ? void 0 : str(key);
  const sessionId = str("sessionId");
  if (sessionId === "") return null;
  const name = opt("name");
  const description = opt("description");
  const lastTask = opt("lastTask");
  return {
    key: str("key") === "" ? sessionId : str("key"),
    sessionId,
    cwd: str("cwd"),
    runs: finite(value["runs"]) ?? 0,
    createdAt: str("createdAt"),
    updatedAt: str("updatedAt"),
    summary: str("summary"),
    ...name === void 0 ? {} : { name },
    ...description === void 0 ? {} : { description },
    ...lastTask === void 0 ? {} : { lastTask }
  };
}
function createApi(connection) {
  async function call(method, args, signal) {
    let raw;
    try {
      raw = await connection.rpc.call("/api", `claudeCode/${method}`, { args }, signal);
    } catch (error) {
      throw new ClaudeCodeApiError("network", error instanceof Error ? error.message : String(error));
    }
    if (!isResult(raw)) throw new ClaudeCodeApiError("protocol", `malformed response for claudeCode/${method}`);
    if (!raw.ok) throw new ClaudeCodeApiError(raw.error?.code ?? "internal", raw.error?.message ?? `claudeCode/${method} failed`);
    return raw.value;
  }
  return {
    listJobs: (sessionId, signal) => call("listJobs", { sessionId }, signal),
    listWorkstreams: async (signal) => {
      const raw = await call("listWorkstreams", {}, signal);
      const rows = [];
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const row = toWorkstream(item);
          if (row !== null) rows.push(row);
        }
      }
      return rows;
    },
    readOutput: (sessionId, jobId, fromOffset, signal) => call("readOutput", { sessionId, jobId, fromOffset }, signal),
    readEvents: async (sessionId, jobId, fromOffset, signal) => {
      const raw = await call(
        "readEvents",
        { sessionId, jobId, fromOffset },
        signal
      );
      const events = [];
      if (Array.isArray(raw.events)) {
        for (const item of raw.events) {
          const event = toEvent(item);
          if (event !== null) events.push(event);
        }
      }
      return {
        events,
        nextOffset: typeof raw.nextOffset === "number" ? raw.nextOffset : fromOffset,
        truncated: raw.truncated === true,
        status: raw.status ?? "running"
      };
    },
    readOutputFile: async (sessionId, filePath, fromOffset, limit, signal) => {
      const raw = await call("readOutputFile", { sessionId, filePath, fromOffset, limit }, signal);
      return {
        text: text(raw.text),
        offset: finite(raw.offset) ?? 0,
        prevOffset: finite(raw.prevOffset) ?? 0,
        totalBytes: finite(raw.totalBytes) ?? 0,
        hasMoreBefore: raw.hasMoreBefore === true
      };
    },
    cancel: (sessionId, jobId) => call("cancel", { sessionId, jobId })
  };
}

// src/client/ClaudeCodeView.tsx
var import_react6 = require("react");

// src/client/EventView.tsx
var import_react3 = require("react");

// src/client/styles.ts
var CSS = {
  root: "ccp-root",
  body: "ccp-body",
  tabs: "ccp-tabs",
  tab: "ccp-tab",
  tabActive: "ccp-tabActive",
  tabMain: "ccp-tabMain",
  tabDot: "ccp-tabDot",
  tabDotRunning: "ccp-tabDotRunning",
  tabDotDone: "ccp-tabDotDone",
  tabDotFailed: "ccp-tabDotFailed",
  tabDotKilled: "ccp-tabDotKilled",
  tabLabel: "ccp-tabLabel",
  tabCount: "ccp-tabCount",
  tabInfo: "ccp-tabInfo",
  modalOverlay: "ccp-modalOverlay",
  modal: "ccp-modal",
  modalHead: "ccp-modalHead",
  modalTitle: "ccp-modalTitle",
  modalClose: "ccp-modalClose",
  modalBody: "ccp-modalBody",
  modalRow: "ccp-modalRow",
  modalKey: "ccp-modalKey",
  modalValue: "ccp-modalValue",
  modalTask: "ccp-modalTask",
  modalFailure: "ccp-modalFailure",
  modalFoot: "ccp-modalFoot",
  pane: "ccp-pane",
  paneMulti: "ccp-paneMulti",
  paneHead: "ccp-paneHead",
  stats: "ccp-stats",
  stat: "ccp-stat",
  groupHead: "ccp-groupHead",
  registerBar: "ccp-registerBar",
  registerToggle: "ccp-registerToggle",
  registerList: "ccp-registerList",
  registerRow: "ccp-registerRow",
  registerEmpty: "ccp-registerEmpty",
  userRow: "ccp-userRow",
  userStack: "ccp-userStack",
  bubble: "ccp-bubble",
  output: "ccp-output",
  outputBody: "ccp-outputBody",
  outputLine: "ccp-outputLine",
  outputTool: "ccp-outputTool",
  outputNotice: "ccp-outputNotice",
  events: "ccp-events",
  eventsBody: "ccp-eventsBody",
  evText: "ccp-evText",
  evTextRaw: "ccp-evTextRaw",
  md: "ccp-md",
  mdRaw: "ccp-mdRaw",
  mdP: "ccp-mdP",
  mdH1: "ccp-mdH1",
  mdH2: "ccp-mdH2",
  mdH3: "ccp-mdH3",
  mdH4: "ccp-mdH4",
  mdH5: "ccp-mdH5",
  mdH6: "ccp-mdH6",
  mdStrong: "ccp-mdStrong",
  mdEm: "ccp-mdEm",
  mdCode: "ccp-mdCode",
  mdPre: "ccp-mdPre",
  mdPreCode: "ccp-mdPreCode",
  mdQuote: "ccp-mdQuote",
  mdList: "ccp-mdList",
  mdItem: "ccp-mdItem",
  mdLink: "ccp-mdLink",
  mdHr: "ccp-mdHr",
  evThinking: "ccp-evThinking",
  evThinkingHead: "ccp-evThinkingHead",
  evThinkingBody: "ccp-evThinkingBody",
  evTool: "ccp-evTool",
  evToolHead: "ccp-evToolHead",
  evToolBadge: "ccp-evToolBadge",
  evToolParams: "ccp-evToolParams",
  evToolParamsFull: "ccp-evToolParamsFull",
  evToolResult: "ccp-evToolResult",
  evToolResultHead: "ccp-evToolResultHead",
  evToolResultBody: "ccp-evToolResultBody",
  evToolError: "ccp-evToolError",
  evConsole: "ccp-evConsole",
  evConsoleHead: "ccp-evConsoleHead",
  evConsoleBody: "ccp-evConsoleBody",
  evConsoleErr: "ccp-evConsoleErr",
  evConsoleMeta: "ccp-evConsoleMeta",
  evTerminalCmd: "ccp-evTerminalCmd",
  evTerminalBody: "ccp-evTerminalBody",
  evPersisted: "ccp-evPersisted",
  evPersistedHead: "ccp-evPersistedHead",
  evPersistedBody: "ccp-evPersistedBody",
  evResultActions: "ccp-evResultActions",
  evResult: "ccp-evResult",
  evWarning: "ccp-evWarning",
  evMore: "ccp-evMore",
  follow: "ccp-follow",
  actions: "ccp-actions",
  button: "ccp-button",
  danger: "ccp-danger",
  empty: "ccp-empty",
  emptyTitle: "ccp-emptyTitle",
  error: "ccp-error",
  mono: "ccp-mono"
};
var TOOL_TONES = 6;
function toolToneClass(name) {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = hash * 31 + name.charCodeAt(index) >>> 0;
  }
  return `ccp-evTone${hash % TOOL_TONES}`;
}
var STYLE_ID = "dsh-claude-delegate-panel";
var CSS_TEXT = `
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
/* A conversation of several runs flows in one scroller \u2014 the pane itself \u2014 and
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
/* The channel's header/footer lines ($ command / exit 0 \xB7 12.3s): dim, no box. */
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
`;
function installStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID) !== null) return;
  const tag = document.createElement("style");
  tag.id = STYLE_ID;
  tag.dataset["plugin"] = "dsh-claude-delegate";
  tag.textContent = CSS_TEXT;
  document.head.appendChild(tag);
}

// src/client/md.ts
var import_react = require("react");
var HEADING = /^(#{1,6})\s+(.*)$/;
var FENCE = /^\s{0,3}(?:```|~~~)\s*([\w+#.-]*)\s*$/;
var FENCE_END = /^\s{0,3}(?:```|~~~)\s*$/;
var RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
var QUOTE = /^\s{0,3}>\s?(.*)$/;
var BULLET = /^(\s*)[-*+]\s+(.*)$/;
var ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
var HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"];
var HEADING_CLASSES = [CSS.mdH1, CSS.mdH2, CSS.mdH3, CSS.mdH4, CSS.mdH5, CSS.mdH6];
var MAX_DEPTH = 4;
function startsBlock(line) {
  return HEADING.test(line) || FENCE.test(line) || RULE.test(line) || QUOTE.test(line) || BULLET.test(line) || ORDERED.test(line);
}
function safeHref(target) {
  const trimmed = target.trim();
  return /^https?:\/\/[^\s<>"']+$/i.test(trimmed) ? trimmed : null;
}
function parseInline(source, depth) {
  const out = [];
  let plain = "";
  let index = 0;
  let seq = 0;
  const nextKey = () => {
    seq += 1;
    return `i${seq}`;
  };
  const flush = () => {
    if (plain !== "") {
      out.push(plain);
      plain = "";
    }
  };
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === "`") {
      const end = source.indexOf("`", index + 1);
      if (end > index + 1) {
        flush();
        out.push((0, import_react.createElement)("code", { key: nextKey(), className: CSS.mdCode }, source.slice(index + 1, end)));
        index = end + 1;
        continue;
      }
    }
    if (char === "[") {
      const link = /^\[([^\]\n]*)\]\(([^()\s]*)\)/.exec(source.slice(index));
      if (link !== null) {
        const href = safeHref(link[2] ?? "");
        if (href === null) {
          plain += link[0];
        } else {
          flush();
          out.push((0, import_react.createElement)(
            "a",
            { key: nextKey(), className: CSS.mdLink, href, target: "_blank", rel: "noopener noreferrer" },
            ...parseInline(link[1] ?? "", Math.min(depth + 1, MAX_DEPTH))
          ));
        }
        index += link[0].length;
        continue;
      }
    }
    if ((char === "*" || char === "_") && depth < MAX_DEPTH) {
      const double = source.startsWith(char + char, index);
      const marker = double ? char + char : char;
      const end = source.indexOf(marker, index + marker.length);
      const body = end < 0 ? "" : source.slice(index + marker.length, end);
      if (body !== "" && body === body.trim()) {
        flush();
        out.push((0, import_react.createElement)(
          double ? "strong" : "em",
          { key: nextKey(), className: double ? CSS.mdStrong : CSS.mdEm },
          ...parseInline(body, depth + 1)
        ));
        index = end + marker.length;
        continue;
      }
    }
    plain += char;
    index += 1;
  }
  flush();
  return out;
}
function paragraph(lines, key) {
  const children = [];
  lines.forEach((line, at) => {
    if (at > 0) children.push((0, import_react.createElement)("br", { key: `${key}br${at}` }));
    children.push(...parseInline(line, 0));
  });
  return (0, import_react.createElement)("p", { key, className: CSS.mdP }, ...children);
}
function parseBlocks(lines, depth) {
  const out = [];
  let index = 0;
  let seq = 0;
  const nextKey = () => {
    seq += 1;
    return `b${seq}`;
  };
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const lang = fence[1] ?? "";
      const body = [];
      index += 1;
      while (index < lines.length && !FENCE_END.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      const codeClass = lang === "" ? CSS.mdPreCode : `${CSS.mdPreCode} language-${lang}`;
      out.push((0, import_react.createElement)(
        "pre",
        { key: nextKey(), className: CSS.mdPre },
        (0, import_react.createElement)("code", { className: codeClass }, body.join("\n"))
      ));
      continue;
    }
    if (RULE.test(line)) {
      out.push((0, import_react.createElement)("hr", { key: nextKey(), className: CSS.mdHr }));
      index += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = Math.min((heading[1] ?? "#").length, HEADING_TAGS.length);
      out.push((0, import_react.createElement)(
        HEADING_TAGS[level - 1] ?? "h6",
        { key: nextKey(), className: HEADING_CLASSES[level - 1] ?? CSS.mdH6 },
        ...parseInline(heading[2] ?? "", 0)
      ));
      index += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner = [];
      while (index < lines.length) {
        const quoted = QUOTE.exec(lines[index] ?? "");
        if (quoted === null) break;
        inner.push(quoted[1] ?? "");
        index += 1;
      }
      const children = depth < MAX_DEPTH ? parseBlocks(inner, depth + 1) : [paragraph(inner, "q")];
      out.push((0, import_react.createElement)("blockquote", { key: nextKey(), className: CSS.mdQuote }, ...children));
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered2 = bullet === null ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered2 !== null) {
      const isOrdered = bullet === null;
      const items = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const match = isOrdered ? ORDERED.exec(current) : BULLET.exec(current);
        if (match !== null) {
          items.push([(isOrdered ? match[3] : match[2]) ?? ""]);
          index += 1;
          continue;
        }
        const last = items[items.length - 1];
        if (last !== void 0 && current.trim() !== "" && !startsBlock(current)) {
          last.push(current.trim());
          index += 1;
          continue;
        }
        break;
      }
      const children = items.map((item, at) => (0, import_react.createElement)(
        "li",
        { key: `li${at}`, className: CSS.mdItem },
        ...parseInline(item.join(" "), 0)
      ));
      const start = isOrdered ? Number(ordered2?.[2] ?? "1") : void 0;
      out.push((0, import_react.createElement)(
        isOrdered ? "ol" : "ul",
        { key: nextKey(), className: CSS.mdList, ...start !== void 0 && start !== 1 ? { start } : {} },
        ...children
      ));
      continue;
    }
    const chunk = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (current.trim() === "") break;
      if (chunk.length > 0 && startsBlock(current)) break;
      chunk.push(current);
      index += 1;
    }
    out.push(paragraph(chunk, nextKey()));
  }
  return out;
}
var Markdown = (0, import_react.memo)(function Markdown2({ text: text2 }) {
  let blocks;
  try {
    blocks = parseBlocks(text2.replace(/\r\n?/g, "\n").split("\n"), 0);
  } catch {
    return (0, import_react.createElement)("div", { className: CSS.mdRaw }, text2);
  }
  return (0, import_react.createElement)("div", { className: CSS.md }, ...blocks);
});

// src/client/locales.ts
var zh = {
  "view.label": "Claude Code",
  "list.title": "\u59D4\u6D3E\u4EFB\u52A1",
  "list.empty.title": "\u6682\u65E0 Claude Code \u59D4\u6D3E\u4EFB\u52A1",
  "list.empty.hint": "\u5728\u5BF9\u8BDD\u91CC\u8BA9\u6211\u7528 run_in_background: true \u6D3E\u4E00\u4E2A\u8BD5\u8BD5\u3002",
  "list.empty.note": "\u4EFB\u52A1\u53EA\u5B58\u5728\u4E8E\u5F53\u524D DSH \u8FDB\u7A0B\u5185\uFF0C\u91CD\u542F\u540E\u5217\u8868\u4E3A\u7A7A\uFF1B\u5386\u53F2\u7ED3\u679C\u770B\u5BF9\u8BDD\u91CC\u7684\u5DE5\u5177\u5361\u7247\u3002",
  "status.running": "\u8FD0\u884C\u4E2D",
  "status.completed": "\u5DF2\u5B8C\u6210",
  "status.failed": "\u5DF2\u5931\u8D25",
  "status.killed": "\u5DF2\u53D6\u6D88",
  "detail.job": "\u4EFB\u52A1 id",
  "detail.session": "Claude \u4F1A\u8BDD",
  "detail.session.hint": "\u4F5C\u4E3A resume \u53C2\u6570\u53EF\u7EED\u63A5\u8BE5\u4F1A\u8BDD",
  "detail.title": "\u4EFB\u52A1\u8BE6\u60C5",
  "detail.open": "\u8BE6\u60C5",
  "detail.close": "\u5173\u95ED",
  "detail.task": "\u4EFB\u52A1\u5185\u5BB9",
  "detail.model": "\u6A21\u578B",
  "detail.status": "\u72B6\u6001",
  "detail.startedAt": "\u5F00\u59CB\u4E8E",
  "detail.finishedAt": "\u7ED3\u675F\u4E8E",
  "detail.duration": "\u8017\u65F6",
  "detail.cost": "\u8D39\u7528",
  "detail.turns": "\u8F6E\u6570",
  "detail.failure": "\u5931\u8D25\u539F\u56E0",
  "stats.turns": "\u8F6E",
  "stats.cost": "\u8D39\u7528",
  "stats.duration": "\u8017\u65F6",
  "action.cancel": "\u53D6\u6D88",
  "action.cancel.confirm": "\u786E\u5B9A\u53D6\u6D88\u8FD9\u4E2A\u4EFB\u52A1\uFF1FClaude Code \u4F1A\u88AB\u4E2D\u6B62\u3002",
  "action.copyOutput": "\u590D\u5236\u8F93\u51FA",
  "action.copySession": "\u590D\u5236\u4F1A\u8BDD id",
  "action.copied": "\u5DF2\u590D\u5236",
  "output.title": "\u5B9E\u65F6\u8F93\u51FA",
  "output.empty": "\u8FD8\u6CA1\u6709\u8F93\u51FA\u2026",
  "output.truncated": "\u2026\u66F4\u65E9\u7684\u8F93\u51FA\u5DF2\u88AB\u622A\u65AD\u2026",
  "output.follow": "\u2193 \u56DE\u5230\u5E95\u90E8",
  "output.collapse": "\u6536\u8D77",
  "output.expand": "\u5C55\u5F00",
  "output.raw": "\u539F\u6587",
  "output.preview": "\u9884\u89C8",
  "events.title": "Claude Code \u8F93\u51FA",
  "events.empty": "\u8FD8\u6CA1\u6709\u8F93\u51FA\u2026",
  "events.truncated": "\u2026\u66F4\u65E9\u7684\u4E8B\u4EF6\u5DF2\u88AB\u622A\u65AD\u2026",
  "events.thinking": "\u{1F4AD} \u601D\u8003\u4E2D\u2026\uFF08\u70B9\u51FB\u5C55\u5F00\uFF09",
  "events.thinkingLabel": "\u601D\u8003",
  "events.toolResult": "\u7ED3\u679C",
  "events.toolError": "\u51FA\u9519",
  "events.toolRunning": "\u8FD0\u884C\u4E2D",
  "events.shellOut": "\u25B6 \u5B9E\u65F6\u8F93\u51FA",
  "events.headOmitted": "\u2026\u5F00\u5934\u7701\u7565 {n} \u5B57\u7B26",
  "events.persistedOpen": "\u5B8C\u6574\u8F93\u51FA",
  "events.persistedHead": "\u5B8C\u6574\u8F93\u51FA\uFF08Claude Code \u843D\u76D8\uFF09",
  "events.persistedEarlier": "\u2191 \u52A0\u8F7D\u66F4\u65E9\u7684",
  "events.persistedLoading": "\u52A0\u8F7D\u4E2D\u2026",
  "events.persistedFailed": "\u5B8C\u6574\u8F93\u51FA\u8BFB\u53D6\u5931\u8D25",
  "events.result": "\u5B8C\u6210",
  "error.prefix": "\u8BFB\u53D6\u5931\u8D25",
  "select.empty": "\u9009\u62E9\u4E0A\u65B9\u7684\u4EFB\u52A1\u67E5\u770B\u8F93\u51FA",
  "select.sources": "\u884C\u6765\u6E90",
  "group.runs": "\u5171 {n} \u8F6E",
  "group.run": "\u7B2C {n} \u8F6E",
  "prompt.head": "\u8FD9\u4E00\u8F6E\u53D1\u7ED9\u5B83\u7684\u4EFB\u52A1",
  "register.title": "\u5DE5\u4F5C\u6D41\u6CE8\u518C\u8868",
  "register.empty": "\u8FD8\u6CA1\u6709\u6CE8\u518C\u8FC7\u5DE5\u4F5C\u6D41\uFF1A\u7B2C\u4E00\u6B21\u5E26 conversation: <\u540D\u5B57> \u6D3E\u9063\u65F6\u4F1A\u81EA\u52A8\u767B\u8BB0",
  "register.line": "\u5DE5\u4F5C\u6D41"
};
var en = {
  "view.label": "Claude Code",
  "list.title": "Delegations",
  "list.empty.title": "No Claude Code delegations yet",
  "list.empty.hint": "Ask me to delegate one with run_in_background: true.",
  "list.empty.note": "Jobs live only inside the current DSH process; the list is empty after a restart. Past results stay in the conversation tool cards.",
  "status.running": "running",
  "status.completed": "completed",
  "status.failed": "failed",
  "status.killed": "cancelled",
  "detail.job": "job id",
  "detail.session": "Claude session",
  "detail.session.hint": "pass it back as resume to continue this session",
  "detail.title": "Job details",
  "detail.open": "Details",
  "detail.close": "Close",
  "detail.task": "Task",
  "detail.model": "Model",
  "detail.status": "Status",
  "detail.startedAt": "Started",
  "detail.finishedAt": "Finished",
  "detail.duration": "Took",
  "detail.cost": "Cost",
  "detail.turns": "Turns",
  "detail.failure": "Failure",
  "stats.turns": "turns",
  "stats.cost": "cost",
  "stats.duration": "took",
  "action.cancel": "Cancel",
  "action.cancel.confirm": "Cancel this job? Claude Code will be aborted.",
  "action.copyOutput": "Copy output",
  "action.copySession": "Copy session id",
  "action.copied": "Copied",
  "output.title": "Live output",
  "output.empty": "No output yet\u2026",
  "output.truncated": "\u2026earlier output truncated\u2026",
  "output.follow": "\u2193 Back to bottom",
  "output.collapse": "Collapse",
  "output.expand": "Expand",
  "output.raw": "Raw",
  "output.preview": "Preview",
  "events.title": "Claude Code output",
  "events.empty": "No output yet\u2026",
  "events.truncated": "\u2026earlier events truncated\u2026",
  "events.thinking": "\u{1F4AD} Thinking\u2026 (click to expand)",
  "events.thinkingLabel": "Thinking",
  "events.toolResult": "Result",
  "events.toolError": "Error",
  "events.toolRunning": "Running",
  "events.shellOut": "\u25B6 live output",
  "events.headOmitted": "\u2026{n} chars omitted from the head",
  "events.persistedOpen": "Full output",
  "events.persistedHead": "Full output (persisted by Claude Code)",
  "events.persistedEarlier": "\u2191 Load earlier",
  "events.persistedLoading": "Loading\u2026",
  "events.persistedFailed": "Could not read the persisted output",
  "events.result": "Completed",
  "error.prefix": "Read failed",
  "select.empty": "Pick a job above to see its output",
  "select.sources": "row sources",
  "group.runs": "{n} runs",
  "group.run": "Run {n}",
  "prompt.head": "Task sent to it in this run",
  "register.title": "Workstream register",
  "register.empty": "No workstreams registered yet \u2014 the first call with a conversation name registers one",
  "register.line": "Workstream"
};
function isChinese() {
  const documentLang = typeof document !== "undefined" ? document.documentElement.lang : "";
  const navigatorLang = typeof navigator !== "undefined" ? navigator.language : "";
  const lang = (documentLang || navigatorLang || "zh").toLowerCase();
  return lang.startsWith("zh") || lang === "";
}
function t(key) {
  return (isChinese() ? zh : en)[key];
}
function tf(key, value) {
  return t(key).replace("{n}", String(value));
}

// src/client/PersistedOutput.tsx
var import_react2 = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var WINDOW_BYTES = 2e5;
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function describe(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}
function PersistedOutput({ filePath, read }) {
  const [text2, setText] = (0, import_react2.useState)("");
  const [start, setStart] = (0, import_react2.useState)(0);
  const [totalBytes, setTotalBytes] = (0, import_react2.useState)(0);
  const [loading, setLoading] = (0, import_react2.useState)(true);
  const [error, setError] = (0, import_react2.useState)("");
  const reader = (0, import_react2.useRef)(read);
  reader.current = read;
  (0, import_react2.useEffect)(() => {
    let cancelled = false;
    setLoading(true);
    reader.current(filePath, -WINDOW_BYTES, WINDOW_BYTES).then((window2) => {
      if (cancelled) return;
      setText(window2.text);
      setStart(window2.offset);
      setTotalBytes(window2.totalBytes);
      setError("");
    }).catch((cause) => {
      if (!cancelled) setError(`${t("events.persistedFailed")}: ${describe(cause)}`);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);
  const loadEarlier = (0, import_react2.useCallback)(() => {
    if (start <= 0 || loading) return;
    setLoading(true);
    const from = Math.max(0, start - WINDOW_BYTES);
    reader.current(filePath, from, start - from).then((window2) => {
      setText((current) => window2.text + current);
      setStart(window2.offset);
      setTotalBytes(window2.totalBytes);
      setError("");
    }).catch((cause) => {
      setError(`${t("events.persistedFailed")}: ${describe(cause)}`);
    }).finally(() => {
      setLoading(false);
    });
  }, [filePath, loading, start]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: CSS.evPersisted, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: CSS.evPersistedHead, children: [
      t("events.persistedHead"),
      " \xB7 ",
      formatBytes(totalBytes)
    ] }),
    start > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: CSS.evMore, disabled: loading, onClick: loadEarlier, children: loading ? t("events.persistedLoading") : `${t("events.persistedEarlier")} (${formatBytes(start)})` }) : null,
    error !== "" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: CSS.evWarning, children: error }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { className: CSS.evPersistedBody, children: text2 })
  ] });
}

// src/client/EventView.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var MAX_RENDER_EVENTS = 1e3;
var PARAM_PREVIEW = 200;
var RESULT_PREVIEW = 800;
var MAX_CONSOLE_LINES = 400;
var SHELL_TOOL = "mcp__dsh__shell";
var TERMINAL_TOOLS = /* @__PURE__ */ new Set(["Bash", "BashOutput", "PowerShell"]);
var STICKY_SLACK_PX = 24;
function formatInput(input) {
  if (input === void 0 || input === null) return { preview: "", full: "" };
  if (typeof input === "string") return { preview: input, full: input };
  let compact;
  let full;
  try {
    compact = JSON.stringify(input) ?? String(input);
    full = JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    compact = String(input);
    full = compact;
  }
  return { preview: compact, full };
}
function shellParams(input) {
  const formatted = formatInput(input);
  if (input === null || typeof input !== "object") return formatted;
  const record = input;
  const command = typeof record["command"] === "string" ? record["command"] : "";
  if (command === "") return formatted;
  const purpose = typeof record["purpose"] === "string" ? record["purpose"] : "";
  return { preview: purpose === "" ? command : `${purpose} \u2014 ${command}`, full: formatted.full };
}
function bashParams(input) {
  const formatted = formatInput(input);
  if (input === null || typeof input !== "object") return formatted;
  const record = input;
  const command = typeof record["command"] === "string" ? record["command"] : "";
  if (command === "") return formatted;
  return { preview: `$ ${command}`, full: formatted.full, command };
}
function formatDuration(durationMs) {
  const total = Math.max(0, Math.floor(durationMs / 1e3));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}
function resultSummary(event) {
  const parts = [event.isError === true ? `\u274C ${t("status.failed")}` : `\u2705 ${t("events.result")}`];
  if (typeof event.costUsd === "number") parts.push(`$${event.costUsd.toFixed(2)}`);
  if (typeof event.numTurns === "number") parts.push(`${event.numTurns} turns`);
  if (typeof event.durationMs === "number") parts.push(formatDuration(event.durationMs));
  return parts.join(" \xB7 ");
}
function toNodes(events) {
  const nodes = [];
  const byToolUse = /* @__PURE__ */ new Map();
  let openConsole;
  const byRun = /* @__PURE__ */ new Map();
  events.forEach((event, index) => {
    const key = `e${index}`;
    switch (event.type) {
      case "text": {
        if (event.text.trim() === "") break;
        const last = nodes[nodes.length - 1];
        if (last !== void 0 && last.kind === "text") last.text += event.text;
        else nodes.push({ kind: "text", key, text: event.text });
        break;
      }
      case "thinking": {
        nodes.push({ kind: "thinking", key, thinking: event.thinking });
        break;
      }
      case "tool_use": {
        const terminal = TERMINAL_TOOLS.has(event.name);
        const formatted = terminal ? bashParams(event.input) : event.name === SHELL_TOOL ? shellParams(event.input) : formatInput(event.input);
        nodes.push({
          kind: "tool",
          key,
          name: event.name,
          preview: formatted.preview,
          full: formatted.full,
          terminal,
          ...formatted.command !== void 0 ? { command: formatted.command } : {},
          results: []
        });
        if (event.id !== void 0) byToolUse.set(event.id, nodes.length - 1);
        break;
      }
      case "tool_progress": {
        const at = byToolUse.get(event.tool_use_id);
        const owner = at === void 0 ? void 0 : nodes[at];
        if (owner !== void 0 && owner.kind === "tool") owner.progress = event.elapsedSeconds;
        break;
      }
      case "console": {
        if (event.text === "") break;
        const run = event.run;
        const known = run === void 0 ? void 0 : byRun.get(run);
        const at = known ?? openConsole;
        const open = at === void 0 ? void 0 : nodes[at];
        if (event.stream === "meta") {
          if (event.phase === "start" || event.phase === void 0 && event.text.startsWith("$ ")) {
            nodes.push({ kind: "console", key, lines: [] });
            const index2 = nodes.length - 1;
            if (run !== void 0) byRun.set(run, index2);
            openConsole = index2;
            break;
          }
          if (open !== void 0 && open.kind === "console" && open.footer === void 0) {
            open.footer = event.text;
            if (run !== void 0) byRun.delete(run);
            if (at === openConsole) openConsole = void 0;
            break;
          }
          nodes.push({ kind: "meta", key, text: event.text });
          break;
        }
        const err = event.stream === "stderr";
        if (open !== void 0 && open.kind === "console" && open.footer === void 0) open.lines.push({ text: event.text, err });
        else {
          nodes.push({ kind: "console", key, lines: [{ text: event.text, err }] });
          const index2 = nodes.length - 1;
          if (run !== void 0) byRun.set(run, index2);
          openConsole = index2;
        }
        break;
      }
      case "tool_result": {
        const at = event.tool_use_id === null ? void 0 : byToolUse.get(event.tool_use_id);
        const owner = at === void 0 ? void 0 : nodes[at];
        if (owner !== void 0 && owner.kind === "tool" && owner.name === SHELL_TOOL && event.content.trimStart().startsWith("exit ")) break;
        const result = {
          content: event.content,
          isError: event.isError === true,
          ...event.omittedChars !== void 0 && event.omittedChars > 0 ? { omittedChars: event.omittedChars } : {},
          ...event.outputPath !== void 0 ? { outputPath: event.outputPath } : {}
        };
        if (owner !== void 0 && owner.kind === "tool") owner.results.push(result);
        else nodes.push({ kind: "orphanResult", key, result });
        break;
      }
      case "result": {
        nodes.push({ kind: "result", key, summary: resultSummary(event), isError: event.isError === true });
        break;
      }
      case "warning": {
        nodes.push({ kind: "warning", key, text: event.text });
        break;
      }
    }
  });
  return nodes;
}
function EventView({ events, truncated, jobId, live = false, readFile }) {
  const bodyRef = (0, import_react3.useRef)(null);
  const [following, setFollowing] = (0, import_react3.useState)(true);
  const [expanded, setExpanded] = (0, import_react3.useState)(() => /* @__PURE__ */ new Set());
  const clipped = events.length > MAX_RENDER_EVENTS;
  const visible = (0, import_react3.useMemo)(
    () => clipped ? events.slice(events.length - MAX_RENDER_EVENTS) : events,
    [events, clipped]
  );
  const nodes = (0, import_react3.useMemo)(() => toNodes(visible), [visible]);
  (0, import_react3.useEffect)(() => {
    setFollowing(true);
    setExpanded(/* @__PURE__ */ new Set());
  }, [jobId]);
  (0, import_react3.useLayoutEffect)(() => {
    const body = bodyRef.current;
    if (!body || !following) return;
    body.scrollTop = body.scrollHeight;
  }, [nodes, following]);
  const onScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight <= STICKY_SLACK_PX;
    setFollowing(atBottom);
  };
  const backToBottom = () => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
    setFollowing(true);
  };
  const toggle = (key) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const renderResult = (key, result, terminal = false) => {
    const open = expanded.has(key);
    const long = result.content.length > RESULT_PREVIEW;
    const body = open || !long ? result.content : `${result.content.slice(0, RESULT_PREVIEW)}\u2026`;
    const fileKey = `${key}:file`;
    const fileOpen = expanded.has(fileKey);
    const readable = result.outputPath !== void 0 && readFile !== void 0;
    const canExpand = long || readable;
    const bodyClass = terminal ? `${CSS.evToolResultBody} ${CSS.evTerminalBody}` : CSS.evToolResultBody;
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: CSS.evToolResult, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: result.isError ? `${CSS.evToolResultHead} ${CSS.evToolError}` : CSS.evToolResultHead, children: result.isError ? t("events.toolError") : t("events.toolResult") }),
      result.omittedChars !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: CSS.evToolResultHead, children: tf("events.headOmitted", result.omittedChars) }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: result.isError ? `${bodyClass} ${CSS.evToolError}` : bodyClass, children: body }),
      canExpand ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: CSS.evResultActions, children: [
        long ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: CSS.evMore, onClick: () => {
          toggle(key);
        }, children: open ? t("output.collapse") : t("output.expand") }) : null,
        readable ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: CSS.evMore, onClick: () => {
          toggle(fileKey);
        }, children: fileOpen ? t("output.collapse") : t("events.persistedOpen") }) : null
      ] }) : null,
      fileOpen && result.outputPath !== void 0 && readFile !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(PersistedOutput, { filePath: result.outputPath, read: readFile }) : null
    ] }, key);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: CSS.events, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { ref: bodyRef, className: CSS.eventsBody, onScroll, role: "log", "aria-label": t("events.title"), children: [
      truncated || clipped ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: CSS.outputNotice, children: t("events.truncated") }) : null,
      nodes.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: CSS.outputNotice, children: t("events.empty") }) : null,
      nodes.map((node) => {
        if (node.kind === "text") {
          const rawKey = `${node.key}:raw`;
          const raw = expanded.has(rawKey);
          return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: CSS.evText, children: [
            raw ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: CSS.evTextRaw, children: node.text }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Markdown, { text: node.text }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: CSS.evMore, onClick: () => {
              toggle(rawKey);
            }, children: raw ? t("output.preview") : t("output.raw") })
          ] }, node.key);
        }
        if (node.kind === "thinking") {
          const open2 = expanded.has(node.key);
          return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: CSS.evThinking, children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              "button",
              {
                type: "button",
                className: CSS.evThinkingHead,
                "aria-expanded": open2,
                onClick: () => {
                  toggle(node.key);
                },
                children: open2 ? `\u{1F4AD} ${t("events.thinkingLabel")}\uFF08${t("output.collapse")}\uFF09` : t("events.thinking")
              }
            ),
            open2 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: CSS.evThinkingBody, children: node.thinking }) : null
          ] }, node.key);
        }
        if (node.kind === "orphanResult") {
          return renderResult(`${node.key}:r0`, node.result);
        }
        if (node.kind === "console") {
          const shown = node.lines.length > MAX_CONSOLE_LINES ? node.lines.slice(-MAX_CONSOLE_LINES) : node.lines;
          const cut = shown.length < node.lines.length;
          const failed = node.footer !== void 0 && !/^exit 0\b/.test(node.footer);
          return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: CSS.evConsole, children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: CSS.evConsoleHead, children: [
              t("events.shellOut"),
              cut ? ` \xB7 ${t("events.truncated")}` : ""
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: CSS.evConsoleBody, children: shown.map((line, at) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: line.err ? CSS.evConsoleErr : void 0, children: [
              line.text,
              "\n"
            ] }, at)) }),
            node.footer === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: failed ? `${CSS.evConsoleMeta} ${CSS.evConsoleErr}` : CSS.evConsoleMeta, children: node.footer })
          ] }, node.key);
        }
        if (node.kind === "meta") {
          return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: CSS.evConsoleMeta, children: node.text }, node.key);
        }
        if (node.kind === "result") {
          return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: node.isError ? `${CSS.evResult} ${CSS.evToolError}` : CSS.evResult, children: node.summary }, node.key);
        }
        if (node.kind === "warning") {
          return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { role: "status", className: CSS.evWarning, children: node.text }, node.key);
        }
        const paramsKey = `${node.key}:p`;
        const open = expanded.has(paramsKey);
        const preview = node.terminal ? node.preview : node.preview.length > PARAM_PREVIEW ? `${node.preview.slice(0, PARAM_PREVIEW)}\u2026` : node.preview;
        return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: CSS.evTool, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
            "button",
            {
              type: "button",
              className: CSS.evToolHead,
              "aria-expanded": open,
              onClick: () => {
                toggle(paramsKey);
              },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: `${CSS.evToolBadge} ${toolToneClass(node.name)}`, children: [
                  "[",
                  node.name,
                  "]"
                ] }),
                open ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: node.terminal ? CSS.evTerminalCmd : CSS.evToolParams, children: preview }),
                node.results.length === 0 && (node.progress !== void 0 || live) ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: CSS.evToolParams, children: [
                  "\u23F3 ",
                  t("events.toolRunning"),
                  node.progress !== void 0 ? ` ${formatDuration(node.progress * 1e3)}` : "",
                  "\u2026"
                ] }) : null
              ]
            }
          ),
          open && node.full !== "" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: CSS.evToolParamsFull, children: node.full }) : null,
          node.results.map((result, index) => renderResult(`${node.key}:r${index}`, result, node.terminal))
        ] }, node.key);
      })
    ] }),
    following ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: CSS.follow, onClick: backToBottom, children: t("output.follow") })
  ] });
}

// src/client/OutputView.tsx
var import_react4 = require("react");
var import_jsx_runtime3 = require("react/jsx-runtime");
var MAX_CHARS = 5e5;
var MAX_LINES = 2e3;
var STICKY_SLACK_PX2 = 24;
function toLines(text2) {
  let body = text2;
  let clipped = false;
  if (body.length > MAX_CHARS) {
    body = body.slice(body.length - MAX_CHARS);
    clipped = true;
  }
  let lines = body.split("\n");
  if (lines.length > MAX_LINES) {
    lines = lines.slice(lines.length - MAX_LINES);
    clipped = true;
  }
  return { lines, clipped };
}
function OutputView({ text: text2, truncated, jobId }) {
  const bodyRef = (0, import_react4.useRef)(null);
  const [following, setFollowing] = (0, import_react4.useState)(true);
  const { lines, clipped } = (0, import_react4.useMemo)(() => toLines(text2), [text2]);
  (0, import_react4.useEffect)(() => {
    setFollowing(true);
  }, [jobId]);
  (0, import_react4.useLayoutEffect)(() => {
    const body = bodyRef.current;
    if (!body || !following) return;
    body.scrollTop = body.scrollHeight;
  }, [lines, following]);
  const onScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight <= STICKY_SLACK_PX2;
    setFollowing(atBottom);
  };
  const backToBottom = () => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
    setFollowing(true);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: CSS.output, children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { ref: bodyRef, className: CSS.outputBody, onScroll, role: "log", "aria-label": t("output.title"), children: [
      truncated || clipped ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: CSS.outputNotice, children: [
        t("output.truncated"),
        "\n"
      ] }) : null,
      text2 === "" ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: CSS.outputNotice, children: t("output.empty") }) : null,
      lines.map((line, index) => /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
        "span",
        {
          className: line.startsWith("[tool] ") ? CSS.outputTool : CSS.outputLine,
          children: [
            line,
            index === lines.length - 1 ? "" : "\n"
          ]
        },
        index
      ))
    ] }),
    following ? null : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", className: CSS.follow, onClick: backToBottom, children: t("output.follow") })
  ] });
}

// src/client/JobDetailModal.tsx
var import_react5 = require("react");

// src/client/format.ts
function formatDuration2(elapsedMs) {
  const total = Math.max(0, Math.floor(elapsedMs / 1e3));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
function formatClock(at) {
  if (at === void 0 || !Number.isFinite(at)) return "-";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (value) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const sameDay = date.toDateString() === (/* @__PURE__ */ new Date()).toDateString();
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}
function statusLabel(status) {
  const key = status === "completed" ? "status.completed" : status === "failed" ? "status.failed" : status === "running" ? "status.running" : "status.killed";
  return t(key);
}

// src/client/JobDetailModal.tsx
var import_jsx_runtime4 = require("react/jsx-runtime");
function Row({ label, value, danger }) {
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: CSS.modalRow, children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: CSS.modalKey, children: label }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: danger === true ? `${CSS.modalValue} ${CSS.modalFailure}` : CSS.modalValue, children: value === null || value === void 0 || value === "" ? "-" : value })
  ] });
}
function JobDetailModal({ job, detail, now, onClose, onCopySession, copyLabel }) {
  (0, import_react5.useEffect)(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const live = job.status === "running" || job.status === "stopping";
  const elapsed = detail?.durationMs ?? (live ? now - job.startedAt : (job.finishedAt ?? job.startedAt) - job.startedAt);
  const sessionId = detail?.claudeSessionId;
  const model = detail?.model ?? null;
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "div",
    {
      className: CSS.modalOverlay,
      role: "presentation",
      onClick: (event) => {
        if (event.target === event.currentTarget) onClose();
      },
      children: /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: CSS.modal, role: "dialog", "aria-modal": "true", "aria-label": t("detail.title"), children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: CSS.modalHead, children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: CSS.modalTitle, children: t("detail.title") }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("button", { type: "button", className: CSS.modalClose, onClick: onClose, children: t("detail.close") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { className: CSS.modalBody, children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Row, { label: t("detail.job"), value: job.id }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Row, { label: t("detail.model"), value: model }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Row, { label: t("detail.status"), value: statusLabel(job.status) }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Row, { label: t("detail.startedAt"), value: formatClock(job.startedAt) }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Row, { label: t("detail.finishedAt"), value: live ? "-" : formatClock(job.finishedAt) }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Row, { label: t("detail.duration"), value: formatDuration2(elapsed) }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            Row,
            {
              label: t("detail.cost"),
              value: detail?.costUsd === void 0 ? null : `$${detail.costUsd.toFixed(2)}`
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Row, { label: t("detail.turns"), value: detail?.numTurns === void 0 ? null : String(detail.numTurns) }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Row, { label: t("detail.session"), value: sessionId }),
          detail?.failureDetail === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Row, { label: t("detail.failure"), value: detail.failureDetail, danger: true }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: CSS.modalRow, children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: CSS.modalKey, children: t("detail.task") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("pre", { className: CSS.modalTask, children: detail?.task ?? job.label })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: CSS.modalFoot, children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "button",
          {
            type: "button",
            className: CSS.button,
            disabled: sessionId === void 0 || onCopySession === void 0,
            title: t("detail.session.hint"),
            onClick: () => {
              if (sessionId !== void 0) onCopySession?.(sessionId);
            },
            children: copyLabel ?? t("action.copySession")
          }
        ) })
      ] })
    }
  );
}

// src/client/ClaudeCodeView.tsx
var import_jsx_runtime5 = require("react/jsx-runtime");
var NO_JOBS = [];
var NO_LINES = [];
var JOB_KIND = "claude-code";
var PANEL_KINDS = [JOB_KIND, "subagent"];
var TRACKED_POLL_MS = 2e3;
var NO_ROSTER = (select) => select({ rows: {} });
function mergeRows(...lists) {
  const byId = /* @__PURE__ */ new Map();
  for (const list of lists) {
    for (const job of list) if (!byId.has(job.id)) byId.set(job.id, job);
  }
  return [...byId.values()];
}
function trackedRow(job) {
  return {
    id: job.jobId,
    kind: JOB_KIND,
    label: job.label,
    status: job.status,
    ...job.failureDetail !== void 0 ? { detail: job.failureDetail } : {},
    startedAt: job.startedAt,
    ...job.finishedAt !== void 0 ? { finishedAt: job.finishedAt } : {},
    // Only our own rows carry a conversation; it is what folds them together.
    ...job.claudeSessionId !== void 0 ? { claudeSessionId: job.claudeSessionId } : {}
  };
}
var POLL_MS = 1e3;
var MAX_CACHED_SESSIONS = 8;
var panels = /* @__PURE__ */ new Map();
function panelOf(sessionId) {
  let panel = panels.get(sessionId);
  if (panel === void 0) {
    panel = { outputs: /* @__PURE__ */ new Map(), events: /* @__PURE__ */ new Map() };
    panels.set(sessionId, panel);
    while (panels.size > MAX_CACHED_SESSIONS) {
      const oldest = panels.keys().next();
      if (oldest.done === true) break;
      panels.delete(oldest.value);
    }
  }
  return panel;
}
function isLive(job) {
  return job.status === "running" || job.status === "stopping";
}
function ordered(jobs) {
  return [...jobs].sort((left, right) => {
    const liveLeft = isLive(left);
    if (liveLeft !== isLive(right)) return liveLeft ? -1 : 1;
    if (liveLeft) return left.startedAt - right.startedAt;
    const finished = (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt);
    return finished !== 0 ? finished : left.startedAt - right.startedAt;
  });
}
function groupsOf(rows) {
  const byKey = /* @__PURE__ */ new Map();
  for (const job of rows) {
    const key = job.claudeSessionId ?? job.id;
    const group = byKey.get(key);
    if (group === void 0) byKey.set(key, { key, jobs: [job] });
    else group.jobs.push(job);
  }
  for (const group of byKey.values()) {
    group.jobs.sort((left, right) => left.startedAt - right.startedAt);
  }
  return [...byKey.values()];
}
function headOf(group) {
  const live = group.jobs.filter(isLive);
  return live[live.length - 1] ?? group.jobs[group.jobs.length - 1];
}
function dotClass(status) {
  switch (status) {
    case "running":
    case "stopping":
      return `${CSS.tabDot} ${CSS.tabDotRunning}`;
    case "completed":
      return `${CSS.tabDot} ${CSS.tabDotDone}`;
    case "killed":
      return `${CSS.tabDot} ${CSS.tabDotKilled}`;
    default:
      return `${CSS.tabDot} ${CSS.tabDotFailed}`;
  }
}
var TAB_LABEL_CHARS = 14;
function clip(label) {
  const flat = label.replace(/\s+/g, " ").trim();
  return flat.length > TAB_LABEL_CHARS ? `${flat.slice(0, TAB_LABEL_CHARS)}\u2026` : flat;
}
function defaultSelection(groups) {
  const running = groups.filter((group) => group.jobs.some(isLive));
  if (running.length) return running[running.length - 1]?.key;
  return groups[0]?.key;
}
async function copy(text2) {
  try {
    await navigator.clipboard.writeText(text2);
    return true;
  } catch {
    return false;
  }
}
function createClaudeCodeView(api, jobs) {
  return function ClaudeCodeView({ sessionId, useSessions }) {
    const native = (jobs?.state ?? NO_ROSTER)((state) => state.rows[sessionId]);
    const mirrored = useSessions((state) => state.jobsBySession?.[sessionId]) ?? NO_JOBS;
    const panel = panelOf(sessionId);
    const [tracked, setTracked] = (0, import_react6.useState)(() => panel.rows ?? NO_JOBS);
    const rows = (0, import_react6.useMemo)(
      () => ordered(mergeRows(native ?? NO_JOBS, mirrored, tracked).filter((job) => PANEL_KINDS.includes(job.kind))),
      [native, mirrored, tracked]
    );
    const readFile = (0, import_react6.useCallback)(
      (filePath, fromOffset, limit) => api.readOutputFile(sessionId, filePath, fromOffset, limit),
      [api, sessionId]
    );
    (0, import_react6.useEffect)(() => {
      if (jobs?.watchRows === void 0) return void 0;
      return jobs.watchRows(sessionId);
    }, [jobs, sessionId]);
    (0, import_react6.useEffect)(() => {
      let alive = true;
      const load = () => {
        api.listJobs(sessionId).then(
          (list) => {
            if (!alive) return;
            const mapped = list.map(trackedRow);
            setTracked(mapped);
            panel.rows = mapped;
          },
          // Never swallow this: an empty tab strip is exactly what a failing
          // list RPC looks like, and silence made it undiagnosable.
          (failure) => {
            if (!alive) return;
            setError(`${t("error.prefix")}: ${failure instanceof Error ? failure.message : String(failure)}`);
          }
        );
      };
      load();
      const timer = setInterval(load, TRACKED_POLL_MS);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }, [api, native, sessionId]);
    (0, import_react6.useEffect)(() => {
      if (rows.length > 0) panel.rows = rows;
    }, [rows, panel]);
    const groups = (0, import_react6.useMemo)(() => groupsOf(rows), [rows]);
    const [selected, setSelected] = (0, import_react6.useState)(() => panel.selected ?? defaultSelection(groups));
    const [meta, setMeta] = (0, import_react6.useState)({});
    const [register, setRegister] = (0, import_react6.useState)(NO_LINES);
    const [registerOpen, setRegisterOpen] = (0, import_react6.useState)(false);
    const lineOf = (0, import_react6.useMemo)(() => {
      const map = /* @__PURE__ */ new Map();
      for (const row of register) map.set(row.sessionId, row);
      return map;
    }, [register]);
    const [error, setError] = (0, import_react6.useState)(null);
    const [now, setNow] = (0, import_react6.useState)(() => Date.now());
    const [copied, setCopied] = (0, import_react6.useState)(null);
    const [detailFor, setDetailFor] = (0, import_react6.useState)(void 0);
    const [revision, setRevision] = (0, import_react6.useState)(0);
    const bumpRef = (0, import_react6.useRef)(() => {
      setRevision((value) => value + 1);
    });
    const paneRef = (0, import_react6.useRef)(null);
    const panePinnedRef = (0, import_react6.useRef)(true);
    (0, import_react6.useEffect)(() => {
      const stillThere = selected !== void 0 && groups.some((group) => group.key === selected);
      const next = stillThere ? selected : defaultSelection(groups);
      if (next !== selected) setSelected(next);
      panel.selected = next;
    }, [groups, selected, panel]);
    const current = groups.find((group) => group.key === selected);
    const currentJobs = current?.jobs ?? NO_JOBS;
    const currentLine = current === void 0 ? void 0 : lineOf.get(current.key);
    const currentJob = current === void 0 ? void 0 : headOf(current);
    const currentId = currentJob?.id;
    const currentStatus = currentJob?.status;
    const ours = currentJob === void 0 || currentJob.kind === JOB_KIND;
    const observed = (jobs?.state ?? NO_ROSTER)((state) => ours || currentId === void 0 ? void 0 : state.observed?.[currentId]);
    (0, import_react6.useEffect)(() => {
      if (jobs?.observe === void 0 || ours || currentId === void 0) return void 0;
      return jobs.observe(sessionId, currentId);
    }, [jobs, ours, sessionId, currentId]);
    const lifecycle = rows.map((job) => `${job.id}:${job.status}`).join(",");
    (0, import_react6.useEffect)(() => {
      const abort = new AbortController();
      api.listJobs(sessionId, abort.signal).then(
        (jobs2) => {
          const next = {};
          for (const job of jobs2) next[job.jobId] = job;
          setMeta(next);
          setError(null);
        },
        (failure) => {
          if (abort.signal.aborted) return;
          setError(`${t("error.prefix")}: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
      );
      api.listWorkstreams(abort.signal).then(
        (lines) => {
          setRegister(lines);
        },
        () => {
        }
      );
      return () => {
        abort.abort();
      };
    }, [sessionId, lifecycle]);
    (0, import_react6.useEffect)(() => {
      if (current === void 0 || !ours) return;
      const runIds = currentJobs.map((job) => job.id);
      const abort = new AbortController();
      let timer;
      const onFailure = (failure) => {
        if (abort.signal.aborted) return;
        setError(`${t("error.prefix")}: ${failure instanceof Error ? failure.message : String(failure)}`);
      };
      const pullText = (jobId) => {
        const state = panel.outputs.get(jobId) ?? { text: "", offset: 0, truncated: false };
        api.readOutput(sessionId, jobId, state.offset, abort.signal).then(
          (chunk) => {
            if (chunk.text === "" && !chunk.truncated) return;
            panel.outputs.set(jobId, {
              text: state.text + chunk.text,
              offset: chunk.nextOffset,
              truncated: state.truncated || chunk.truncated
            });
            bumpRef.current();
          },
          onFailure
        );
      };
      const pullEvents = (jobId) => {
        const state = panel.events.get(jobId) ?? { list: [], offset: 0, truncated: false };
        api.readEvents(sessionId, jobId, state.offset, abort.signal).then(
          (chunk) => {
            if (chunk.events.length === 0 && !chunk.truncated) return;
            panel.events.set(jobId, {
              list: state.list.concat(chunk.events),
              offset: chunk.nextOffset,
              truncated: state.truncated || chunk.truncated
            });
            bumpRef.current();
          },
          onFailure
        );
      };
      const pull = () => {
        for (const jobId of runIds) {
          pullEvents(jobId);
          pullText(jobId);
        }
      };
      pull();
      if (currentJobs.some(isLive)) {
        timer = setInterval(pull, POLL_MS);
      }
      return () => {
        abort.abort();
        if (timer !== void 0) clearInterval(timer);
      };
    }, [sessionId, current, currentJobs, currentStatus, panel, ours]);
    (0, import_react6.useEffect)(() => {
      const pane = paneRef.current;
      panePinnedRef.current = true;
      if (pane === null) return void 0;
      const onScroll = () => {
        panePinnedRef.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48;
      };
      pane.addEventListener("scroll", onScroll, { passive: true });
      return () => {
        pane.removeEventListener("scroll", onScroll);
      };
    }, [selected]);
    (0, import_react6.useEffect)(() => {
      const pane = paneRef.current;
      if (pane === null || !panePinnedRef.current) return;
      pane.scrollTop = pane.scrollHeight;
    }, [revision, currentJobs, currentStatus, selected]);
    const liveCount = rows.filter(isLive).length;
    (0, import_react6.useEffect)(() => {
      if (liveCount === 0) return;
      setNow(Date.now());
      const timer = setInterval(() => {
        setNow(Date.now());
      }, 1e3);
      return () => {
        clearInterval(timer);
      };
    }, [liveCount]);
    const onCancel = (0, import_react6.useCallback)((jobId) => {
      if (!window.confirm(t("action.cancel.confirm"))) return;
      const row = rows.find((job) => job.id === jobId);
      if (row !== void 0 && row.kind !== JOB_KIND && jobs?.kill !== void 0) {
        Promise.resolve(jobs.kill(sessionId, jobId)).catch((failure) => {
          setError(`${t("error.prefix")}: ${failure instanceof Error ? failure.message : String(failure)}`);
        });
        return;
      }
      api.cancel(sessionId, jobId).catch((failure) => {
        setError(`${t("error.prefix")}: ${failure instanceof Error ? failure.message : String(failure)}`);
      });
    }, [sessionId, rows, jobs]);
    const flashCopied = (0, import_react6.useCallback)((token) => {
      setCopied(token);
      window.setTimeout(() => {
        setCopied((value) => value === token ? null : value);
      }, 1500);
    }, []);
    const detail = currentId === void 0 ? void 0 : meta[currentId];
    const copyText = ours ? currentJobs.map((job) => panel.outputs.get(job.id)?.text ?? meta[job.id]?.finalOutput ?? "").filter((text2) => text2 !== "").join("\n\n") : observed?.text ?? "";
    const copySessionId = current !== void 0 && current.key !== currentJob?.id ? current.key : meta[currentId ?? ""]?.claudeSessionId;
    const renderRun = (job) => {
      const runEvents = panel.events.get(job.id);
      const runOutput = panel.outputs.get(job.id);
      const runDetail = meta[job.id];
      if (runEvents !== void 0 && runEvents.list.length > 0) {
        return /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
          EventView,
          {
            jobId: job.id,
            events: runEvents.list,
            truncated: runEvents.truncated,
            live: isLive(job),
            readFile
          }
        );
      }
      return /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
        OutputView,
        {
          jobId: job.id,
          text: runOutput?.text ?? (runDetail?.finalOutput ?? ""),
          truncated: runOutput?.truncated ?? false
        }
      );
    };
    void revision;
    const modalJob = detailFor === void 0 ? void 0 : rows.find((job) => job.id === detailFor);
    const closeDetail = (0, import_react6.useCallback)(() => {
      setDetailFor(void 0);
    }, []);
    const copySession = (0, import_react6.useCallback)((sessionId2) => {
      void copy(sessionId2).then((done) => {
        if (done) flashCopied("session");
      });
    }, [flashCopied]);
    if (rows.length === 0) {
      return /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.root, "data-conversation-composer-overlay": "", children: /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: CSS.empty, children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.emptyTitle, children: t("list.empty.title") }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { children: t("list.empty.hint") }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { children: t("list.empty.note") })
      ] }) });
    }
    return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: CSS.root, "data-conversation-composer-overlay": "", children: [
      /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: CSS.body, children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.registerBar, children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
          "button",
          {
            type: "button",
            className: CSS.registerToggle,
            "aria-expanded": registerOpen,
            onClick: () => {
              setRegisterOpen((open) => !open);
            },
            children: `${registerOpen ? "\u25BE" : "\u25B8"} ${t("register.title")} \xB7 ${register.length}`
          }
        ) }),
        registerOpen ? register.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.registerEmpty, children: t("register.empty") }) : /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.registerList, children: register.map((row) => /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.registerRow, children: row.summary }, row.key)) }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.tabs, role: "tablist", "aria-label": t("list.title"), children: groups.map((group) => {
          const head = headOf(group);
          if (head === void 0) return null;
          const active = group.key === selected;
          const count = group.jobs.length;
          const runs = tf("group.runs", String(count));
          const line = lineOf.get(group.key);
          const label = line?.name === void 0 ? head.label : line.name;
          return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { role: "presentation", className: active ? `${CSS.tab} ${CSS.tabActive}` : CSS.tab, children: [
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(
              "button",
              {
                type: "button",
                role: "tab",
                "aria-selected": active,
                className: CSS.tabMain,
                title: line === void 0 ? count > 1 ? `${label} \xB7 ${runs}` : label : `${label} \xB7 ${line.summary.replace(/^· /, "")}`,
                onClick: () => {
                  setSelected(group.key);
                  panel.selected = group.key;
                },
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: dotClass(head.status) }),
                  /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: CSS.tabLabel, children: clip(label) }),
                  count > 1 ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: CSS.tabCount, children: count }) : null
                ]
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
              "button",
              {
                type: "button",
                className: CSS.tabInfo,
                title: t("detail.open"),
                "aria-label": t("detail.open"),
                onClick: (event) => {
                  event.stopPropagation();
                  setDetailFor(head.id);
                },
                children: "\u24D8"
              }
            )
          ] }, group.key);
        }) }),
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { ref: paneRef, className: currentJobs.length > 1 ? `${CSS.pane} ${CSS.paneMulti}` : CSS.pane, children: current === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: CSS.empty, children: [
          t("select.empty"),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.emptyTitle, children: `${t("select.sources")}: roster ${native?.length ?? 0} \xB7 tracker ${tracked.length}` })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(import_jsx_runtime5.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.paneHead, children: /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: CSS.stats, children: [
            currentLine?.name === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: CSS.stat, children: [
              t("register.line"),
              ": ",
              currentLine.name
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: CSS.stat, children: [
              t("detail.job"),
              ": ",
              /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: CSS.mono, children: currentId ?? "\u2014" })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: CSS.stat, children: statusLabel(currentJob?.status ?? "completed") }),
            currentJobs.length > 1 ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: CSS.stat, children: tf("group.runs", String(currentJobs.length)) }) : null,
            detail?.numTurns !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: CSS.stat, children: [
              detail.numTurns,
              " ",
              t("stats.turns")
            ] }) : null,
            detail?.costUsd !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: CSS.stat, children: [
              t("stats.cost"),
              " $",
              detail.costUsd.toFixed(4)
            ] }) : null,
            /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("span", { className: CSS.stat, children: [
              t("stats.duration"),
              " ",
              currentJob === void 0 ? "\u2014" : formatDuration2(isLive(currentJob) ? now - currentJob.startedAt : (currentJob.finishedAt ?? currentJob.startedAt) - currentJob.startedAt)
            ] }),
            currentJob?.detail !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("span", { className: CSS.stat, children: currentJob.detail }) : null
          ] }) }),
          error !== null ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.error, children: error }) : null,
          !ours ? /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(import_jsx_runtime5.Fragment, { children: [
            observed?.gapBefore === true ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.error, children: t("events.truncated") }) : null,
            observed?.error !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.error, children: observed.error }) : null,
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(OutputView, { jobId: currentId ?? "", text: observed?.text ?? "", truncated: false })
          ] }) : currentJobs.map((job, index) => /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(import_react6.Fragment, { children: [
            currentJobs.length > 1 ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.groupHead, children: `${tf("group.run", String(index + 1))} \xB7 ${statusLabel(job.status)}` }) : null,
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.userRow, "aria-label": t("prompt.head"), children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.userStack, children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("div", { className: CSS.bubble, children: meta[job.id]?.task ?? job.label }) }) }),
            renderRun(job)
          ] }, job.id)),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)("div", { className: CSS.actions, children: [
            currentJob !== void 0 && isLive(currentJob) ? /* @__PURE__ */ (0, import_jsx_runtime5.jsx)("button", { type: "button", className: `${CSS.button} ${CSS.danger}`, onClick: () => {
              onCancel(currentJob.id);
            }, children: t("action.cancel") }) : null,
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
              "button",
              {
                type: "button",
                className: CSS.button,
                disabled: copyText === "",
                onClick: () => {
                  void copy(copyText).then((done) => {
                    if (done) flashCopied("output");
                  });
                },
                children: copied === "output" ? t("action.copied") : t("action.copyOutput")
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
              "button",
              {
                type: "button",
                className: CSS.button,
                disabled: copySessionId === void 0,
                title: t("detail.session.hint"),
                onClick: () => {
                  void copy(copySessionId ?? "").then((done) => {
                    if (done) flashCopied("session");
                  });
                },
                children: copied === "session" ? t("action.copied") : t("action.copySession")
              }
            )
          ] })
        ] }) })
      ] }),
      modalJob === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
        JobDetailModal,
        {
          job: modalJob,
          detail: meta[modalJob.id],
          now,
          onClose: closeDetail,
          onCopySession: copySession,
          copyLabel: copied === "session" ? t("action.copied") : t("action.copySession")
        }
      )
    ] });
  };
}

// src/client/index.ts
var inject = ["slots", "connection"];
function apply(ctx) {
  installStyles();
  const jobs = ctx.get?.("jobs");
  const ClaudeCodeView = createClaudeCodeView(createApi(ctx.connection), jobs);
  ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "claude-code",
    order: 100,
    label: () => t("view.label")
  }, ClaudeCodeView));
}

return module.exports;
}
});

