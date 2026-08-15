// state.js - 插件运行时状态（内存态）。
// 所有会话级状态以 sessionId 为 key；turn 级状态在 turn/start 重置。
import { statSync } from "node:fs";
import { loadRules } from "./parser.js";
import { agentsFilePath } from "./paths.js";
import { understandAll } from "./understander.js";
import { AUTH_TTL_MS } from "./authorization.js";

const MAX_SESSIONS = 200;
const MAX_RETRY_KEYS = 500;
const MAX_INJECT_KEYS = 500;
const MTIME_CHECK_INTERVAL_MS = 2000;

export function createState() {
  return {
    loadedAt: 0,
    enabled: true,
    rules: [],
    configs: [],
    configOk: true,
    configError: null,
    bypassUntil: 0,
    unlockUntil: 0,
    mtimeMs: 0,
    lastMtimeCheck: 0,
    sessions: new Map(),
    retryCounts: new Map(),
    injectCounts: new Map(),
    skillNames: null,
    llmEnrichedKeys: new Set(),
    lastActive: [],
    lastEvent: null,
    reloadCount: 0
  };
}

/** AGENTS.md mtime 变化时自动重解析（规则 21：规则是流动数据） */
export function maybeReloadIfChanged(state, now = Date.now()) {
  if (now - state.lastMtimeCheck < MTIME_CHECK_INTERVAL_MS) return false;
  state.lastMtimeCheck = now;
  pruneState(state);
  try {
    const mtime = statSync(agentsFilePath()).mtimeMs;
    if (mtime !== state.mtimeMs) {
      reloadRules(state);
      return true;
    }
  } catch {
    // AGENTS.md 暂时不可读时保持旧规则，不崩
  }
  return false;
}

/** 清理过期/超量内存状态：会话、重试计数、注入计数 */
export function pruneState(state) {
  const now = Date.now();
  if (state.sessions.size > MAX_SESSIONS) {
    const entries = [...state.sessions.entries()].sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
    const excess = entries.slice(0, state.sessions.size - MAX_SESSIONS);
    for (const [key] of excess) state.sessions.delete(key);
  }
  if (state.retryCounts.size > MAX_RETRY_KEYS) {
    const keys = [...state.retryCounts.keys()];
    for (let i = 0; i < keys.length - MAX_RETRY_KEYS; i++) state.retryCounts.delete(keys[i]);
  }
  if (state.injectCounts.size > MAX_INJECT_KEYS) {
    const keys = [...state.injectCounts.keys()];
    for (let i = 0; i < keys.length - MAX_INJECT_KEYS; i++) state.injectCounts.delete(keys[i]);
  }
  // 清理过期授权（顺便释放内存）
  for (const s of state.sessions.values()) {
    s.authorizations = s.authorizations.filter((a) => !a.expiresAt || a.expiresAt > now);
  }
}

export function getSessionState(state, sessionId) {
  const key = sessionId || "global";
  let s = state.sessions.get(key);
  if (!s) {
    s = {
      id: key,
      manualReadSeen: false,
      lastUserText: "",
      selfCertCount: new Map(),
      authorizations: [],
      backups: [],
      lastCommandOutput: "",
      lastSeen: Date.now(),
      turn: freshTurn()
    };
    state.sessions.set(key, s);
  }
  s.lastSeen = Date.now();
  return s;
}

/** 记录一条授权证据（结构化：type/pathPrefix/at/source/expiresAt） */
export function recordAuthorization(state, sessionId, auth) {
  const s = getSessionState(state, sessionId);
  s.authorizations.push({
    at: Date.now(),
    source: "ask",
    expiresAt: Date.now() + AUTH_TTL_MS,
    ...auth
  });
  return s.authorizations;
}

/** 记录一条备份证据（目标路径 → 备份路径） */
export function recordBackup(state, sessionId, targetPath, backupPath) {
  const s = getSessionState(state, sessionId);
  s.backups.push({
    targetPath: normalizeBackupPath(targetPath),
    backupPath: normalizeBackupPath(backupPath),
    at: Date.now()
  });
  return s.backups;
}

function normalizeBackupPath(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase();
}

/** 查找目标路径是否已有对应备份 */
export function findBackupForPath(state, sessionId, targetPath) {
  const s = getSessionState(state, sessionId);
  const t = normalizeBackupPath(targetPath);
  return s.backups.find((b) => b.targetPath === t) || null;
}

export function freshTurn() {
  return {
    number: 0,
    userText: "",
    askSeen: false,
    questionOnly: false,
    pendingAsk: null,
    pendingToolCalls: new Map(),
    getDateSeen: false,
    backupSeen: false,
    toolCount: 0,
    firstToolName: "",
    skillNames: [],
    toolNames: [],
    commands: [],
    reasoningText: ""
  };
}

export function resetTurn(state, sessionId, turnNumber) {
  const s = getSessionState(state, sessionId);
  s.turn = freshTurn();
  s.turn.number = typeof turnNumber === "number" ? turnNumber : 0;
  s.turn.userText = s.lastUserText || "";
  return s.turn;
}

/** 重新加载并理解 AGENTS.md */
export function reloadRules(state) {
  const parsed = loadRules();
  state.rules = parsed.ok ? parsed.rules : [];
  state.configs = understandAll(state.rules);
  state.configOk = parsed.ok;
  state.configError = parsed.error || null;
  state.mtimeMs = parsed.mtimeMs || 0;
  state.loadedAt = Date.now();
  state.lastMtimeCheck = Date.now();
  state.reloadCount++;
  return state;
}

/** 获取某条理解配置 */
export function findConfig(state, ruleId) {
  return state.configs.find((c) => String(c.ruleId) === String(ruleId));
}
