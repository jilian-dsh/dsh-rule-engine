// state.js - 插件运行时状态（内存态）。
// 所有会话级状态以 sessionId 为 key；turn 级状态在 turn/start 重置。
import { appendFileSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { loadRules } from "./parser.js";
import { agentsFilePath, disabledRulesFilePath, turnCardsFilePath } from "./paths.js";
import { understandAll } from "./understander.js";
import { writeUnderstanding } from "./understanding-store.js";
import { AUTH_TTL_MS } from "./authorization.js";
import { initSessionContract } from "./contract.js";
import { loadLabelsFromDisk, saveLabelsToDisk } from "./label-fingerprint.js";
import { dshHome } from "./paths.js";
import { join } from "node:path";

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
    injectAt: new Map(), // v0.5.7：key `${sessionId}:${ruleId}` → 首次投递时间（提醒一次并记住）
    injectBudget: new Map(), // v0.5.7：sessionId → 投递时间戳数组（会话每小时预算）
    judgeCache: new Map(), // v0.5.7：sha256(ruleId+text) → 裁决结果（同文本不重复调用）
    judgeBudget: new Map(), // v0.5.7：`${sessionId}:${UTC日期}` → {count}（每日裁决预算）
    judgeFn: null, // v0.5.7：可注入裁决函数（生产=judge.js LLM 实现；测试=stub）
    globalAuthorizations: [],
    skillNames: null,
    llmEnrichedKeys: new Set(),
    lastActive: [],
    lastEvent: null,
    reloadCount: 0,
    mountRevision: 0,
    mountSignature: "",
    taskContract: {
      taskContractEnabled: false,
      askEnabled: false,
      taskContractMode: "observe"
    },
    labels: new Map(),
    // 0.5.12（F2）：打标指纹台账持久化行（磁盘 ~/.dsh/rule-engine-labels.json；内存态副本）
    labelRows: loadLabelsFromDisk(join(dshHome(), "rule-engine-labels.json")),
    // 0.5.15：回合末裁决卡片索引——closing assistant messageId → card 摘要
    // （index.js 在 turn/end 时登记；service.getTurnCard 倒查供 client assistant-actions 拉取）
    // 2026-09-02：持久化（从磁盘加载）——判例是教学数据，重启不丢（历史按钮/判例恢复）
    cardByMessage: loadTurnCardsFromDisk(),
    askRejections: [], // { sessionId, at }（ask 被拒记录，弹窗消减/节流）
    llmIntentCache: new Map(), // sha256(text) → verdict（LRU 上限 cfg.cacheSize）
    llmIntentBudget: new Map(), // sessionId → 当日调用数（上限 cfg.dailyLimitPerSession）
    llmIntentHits: 0, // LLM 缓存命中计数（/guard status 观测）
    llmIntentLast: null, // { text, verdict, at }（最近一次 LLM 采用/失败，/guard status 观测）
    verifyPass: [], // { at, sessionId, what }（测试通过/冷加载探针输出采集，交付闸门 M3 用）
    deniedKeys: new Set(), // 引擎 deny 的调用 key（规则 1 计数解耦）
    unknownToolApproved: new Set(), // 机制 B：已 ask 过的未归类工具（本会话内批准后不再重复询问）
    unknownToolApprovedMeta: new Map(), // v0.5.9：name → {name,time,session}（持久化元数据，/guard tools 可视化）
    unknownToolSessionAdded: new Set(), // v0.5.9：本会话新增的批准（与永久加载区分，/guard tools 展示）
    // T3 通用化（2026-08-31）：声明式 handler 绑定覆盖表 { ruleId: handlerName }
    // 由 apply() 从插件配置（rule-engine.json 可选键 handlerOverrides）注入；重载时经理解层生效
    handlerOverrides: {},
    // 残余1 剥离（2026-08-31）：本机默认偏好表（rule-engine.json 可选键 handlerDefaultMap）
    // 由 apply() 注入；重载时经理解层生效（通用部署=空表，零本机编号）
    handlerDefaultMap: {}
  };
}

/** 把插件配置中的任务契约设置同步到运行时状态 */
export function applyTaskContractConfig(state, conf) {
  state.taskContract = {
    taskContractEnabled: conf?.taskContractEnabled === true,
    askEnabled: conf?.askEnabled === true,
    taskContractMode: conf?.taskContractMode === "armed" ? "armed" : "observe",
    defaults: conf?.taskContractDefaults || {}
  };
  return state.taskContract;
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
  // v0.5.7：投递资格/裁决状态超限清理（优先保留新 key 语义——按插入序删最旧）
  for (const m of [state.injectAt, state.judgeCache]) {
    if (m.size > MAX_INJECT_KEYS) {
      const keys = [...m.keys()];
      for (let i = 0; i < keys.length - MAX_INJECT_KEYS; i++) m.delete(keys[i]);
    }
  }
  if (state.injectBudget.size > MAX_SESSIONS) {
    const keys = [...state.injectBudget.keys()];
    for (let i = 0; i < keys.length - MAX_SESSIONS; i++) state.injectBudget.delete(keys[i]);
  }
  if (state.judgeBudget.size > MAX_SESSIONS * 2) {
    const keys = [...state.judgeBudget.keys()];
    for (let i = 0; i < keys.length - MAX_SESSIONS * 2; i++) state.judgeBudget.delete(keys[i]);
  }
  // 清理过期授权（顺便释放内存）
  for (const s of state.sessions.values()) {
    s.authorizations = s.authorizations.filter((a) => !a.expiresAt || a.expiresAt > now);
  }
  if (Array.isArray(state.globalAuthorizations)) {
    state.globalAuthorizations = state.globalAuthorizations.filter((a) => !a.expiresAt || a.expiresAt > now);
  }
}

export function getSessionState(state, sessionId) {
  const key = sessionId || "global";
  let s = state.sessions.get(key);
  if (!s) {
    s = {
      id: key,
      ruleStats: {}, // C2：每规则 detected/suppressed/injected 统计（会话级，跨回合累计）
      manualReadSeen: false,
      lastQueryTurn: -1, // 规则 5/31（2026-09-01）：最近一次查询类工具调用所在回合号（判定"近 3 回合有据"）
      lastUserText: "",
      selfCertCount: new Map(),
      authorizations: [],
      backups: [],
      mountAuditRevision: 0,
      mountAuditSignature: "",
      lastCommandOutput: "",
      lastSeen: Date.now(),
      turn: freshTurn(),
      // 批次 4（阶段 3 默认武装）：global 会话自身不继承（防循环）；其他会话继承 global 模板（/guard 命令写入）
      contract: key === "global"
        ? initSessionContract(state.taskContract, null)
        : initSessionContract(state.taskContract, getSessionState(state, "global").contract),
      recentActions: []
    };
    state.sessions.set(key, s);
  }
  s.lastSeen = Date.now();
  return s;
}

/**
 * 记录一条授权证据（结构化：type/pathPrefix/at/source/expiresAt）。
 * 2026-08-24（R1 统一授权存储）：自动来源（执行分点/用户消息/ask）**绝不同步进 globalAuthorizations**——
 * 全局池仅显式白名单可写（recordGlobalAuth），杜绝"一个会话的授权被其它会话复用"与 revoke 残留。
 */
export function recordAuthorization(state, sessionId, auth) {
  const record = {
    at: Date.now(),
    source: "ask",
    expiresAt: Date.now() + AUTH_TTL_MS,
    ...auth
  };
  const s = getSessionState(state, sessionId);
  s.authorizations.push(record);
  return s.authorizations;
}

/**
 * 显式白名单授权（用户明确选择"记住此授权"时写入；当前无 UI 入口，结构预留）。
 * 这是 globalAuthorizations 的唯一写入通道。
 */
export function recordGlobalAuth(state, sessionId, auth) {
  const list = recordAuthorization(state, sessionId, auth);
  const record = list[list.length - 1];
  state.globalAuthorizations.push(record);
  return list;
}

/**
 * revoke 全清（R1.3，2026-08-24）：session.authorizations + turn.scopes + globalAuthorizations + askRejections。
 * @returns {number} 清理的授权/范围条目数（供审计描述）
 */
export function clearAuthorizations(state) {
  let count = 0;
  for (const s of state.sessions.values()) {
    count += (s.authorizations || []).length + ((s.turn && s.turn.scopes) ? s.turn.scopes.length : 0);
    s.authorizations = [];
    if (s.turn) s.turn.scopes = [];
  }
  count += (state.globalAuthorizations || []).length;
  state.globalAuthorizations = [];
  if (Array.isArray(state.askRejections)) state.askRejections = [];
  return count;
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
    realUserSeen: false, // v0.5.7：本回合是否有真实用户消息（注入轮不检测的依据）
    askSeen: false,
    askRejected: false, // 本回合 ask 已被拒（防连环 ask，弹窗消减）
    askApproved: false, // 2026-09-06 M7 修复：本回合已获 ask 授权答复（M7 approval-gap 豁免信号）
    questionOnly: false,
    intents: null,
    intentState: "lexicon", // lexicon | llm-pending | llm-ready（LLM 意图兜底状态）
    llmIntent: null, // { raw, verdict, reason, confidence, at }（LLM 裁决，非高置信时词表兜底）
    pendingAsk: null,
    pendingToolCalls: new Map(),
    getDateSeen: false,
    backupSeen: false,
    toolCount: 0,
    firstToolName: "",
    skillNames: [],
    toolNames: [],
    cardHits: [], // 0.5.15：本回合 guard 命中缓冲（回合末裁决卡片数据源）
    lastAssistantMessageId: "", // 0.5.15：本回合最后 assistant 消息 id（卡片索引锚点）
    commands: [],
    reasoningText: "",
    // 规则 22 粒度升级（2026-08-24）：本回合已获授权范围（execute 子句 + ask 授权）
    scopes: [],
    // M8 双通道机制（2026-08-24）：统一入口落盘后同轮 engram_store 校验（entryMarker 经配置）
    manualWriteSeen: false,
    engramStoreSeen: false
  };
}

export function resetTurn(state, sessionId, turnNumber) {
  const s = getSessionState(state, sessionId);
  s.turn = freshTurn();
  s.turn.number = typeof turnNumber === "number" ? turnNumber : 0;
  // 2026-08-24（事故复盘 P0-3 根修）：不再继承上一轮 lastUserText——
  // 上一轮若为询问（含“为什么”等）会把旧意图带进新回合导致误拦；
  // turn.userText 只由真实的 user/message 事件写入；无消息回合不做规则 22 判定（12A/13A 仍把关）。
  return s.turn;
}

/** 读取 dsh-rules-manager 的 disabled-rules.json 全部存档条目（禁用=正文移走+原样存档） */
export function loadDisabledRuleEntries() {
  try {
    const raw = readFileSync(disabledRulesFilePath(), "utf8");
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter((d) => d && d.index !== undefined && d.index !== null);
  } catch {
    return [];
  }
}

/** 已禁用规则 id 集合（P0-2；加载失败=空集，保守不误拦） */
export function loadDisabledRuleIds() {
  return new Set(loadDisabledRuleEntries().map((d) => String(d.index)).filter(Boolean));
}

/**
 * 重新加载并理解 AGENTS.md；统一在 reload 后刷新理解产物（P0-3）。
 * 禁用语义（2026-08-31 修复）：禁用规则以 disabled=true 占位存在——不只是标记"在场规则"。
 * 正文已移走的禁用规则由 understandAll（opts.disabledEntries）用存档正文重建占位：
 * ① 禁用不再"消失"（/guard rules 显示（已禁用），恢复=写回 AGENTS.md 后自动重新生效）；
 * ② 死映射消除（HANDLER_BY_RULE 中的 12B 等因规则在场而不再被判 dead，consistency-live 转绿）。
 */
export function reloadRules(state) {
  const parsed = loadRules();
  state.rules = parsed.ok ? parsed.rules : [];
  const archived = loadDisabledRuleEntries();
  // 禁用语义由理解层完整封装：在场标 disabled + 缺场存档占位重建（单真源，见 understandAll）
  state.configs = understandAll(state.rules, {
    disabledEntries: archived,
    handlerOverrides: state.handlerOverrides || {},
    defaultMap: state.handlerDefaultMap || {}
  });
  state.configOk = parsed.ok;
  state.configError = parsed.error || null;
  state.mtimeMs = parsed.mtimeMs || 0;
  state.loadedAt = Date.now();
  state.lastMtimeCheck = Date.now();
  state.reloadCount++;
  if (parsed.ok) writeUnderstanding(state.configs);
  return state;
}

/** 获取某条理解配置 */
export function findConfig(state, ruleId) {
  return state.configs.find((c) => String(c.ruleId) === String(ruleId));
}

// ── 0.5.15：回合末裁决卡片持久化（判例=教学数据，重启不丢）─────────────
/** 卡片索引磁盘上限（防膨胀：只保留最近 N 条） */
export const TURN_CARDS_MAX = 200;

/** 从磁盘加载卡片索引（损坏/缺文件 → 空 Map，容错不崩） */
export function loadTurnCardsFromDisk() {
  try {
    const raw = readFileSync(turnCardsFilePath(), "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Map();
    const m = new Map();
    for (const it of arr) {
      if (it && typeof it.messageId === "string" && it.card) m.set(it.messageId, it.card);
    }
    return m;
  } catch {
    return new Map();
  }
}

/** 判例保护（2026-09-08 第二批 §1.1-①）：带标卡判定——blocks[].label 或顶层 label */
export function hasCardLabel(card) {
  if (!card || typeof card !== "object") return false;
  if (card.label) return true;
  return Array.isArray(card.blocks) && card.blocks.some((b) => b && typeof b === "object" && b.label);
}

/** 被裁卡片归档文件（判例=教学数据；归档文件不参与轮转，只追加） */
export function turnCardsArchiveFilePath() {
  return join(dshHome(), "rule-engine-turn-cards-archive.jsonl");
}

function archiveTurnCards(dropped) {
  try {
    const lines = dropped
      .map(([messageId, card]) => JSON.stringify({ ts: new Date().toISOString(), messageId, card }))
      .join("\n");
    if (lines) appendFileSync(turnCardsArchiveFilePath(), lines + "\n", "utf8");
  } catch {
    // 归档失败不阻断（卡片持久化本身容错）
  }
}

/** 保存卡片索引到磁盘（数组化 + 上限裁剪；失败静默——卡片是增强层）
 *  裁剪保护（2026-09-08）：候选集先排除带标卡——先裁最旧无标卡；无标耗尽后才按最旧裁带标卡；
 *  被裁卡裁剪前完整 JSON 追加写入归档 jsonl（不参与轮转）。 */
export function saveTurnCardsToDisk(state, max = TURN_CARDS_MAX) {
  try {
    let entries = [...(state.cardByMessage || new Map()).entries()];
    if (entries.length > max) {
      const overflow = entries.length - max;
      const plain = entries.filter(([, c]) => !hasCardLabel(c));
      const labeled = entries.filter(([, c]) => hasCardLabel(c));
      const dropPlain = plain.slice(0, Math.min(overflow, plain.length));
      const rest = overflow - dropPlain.length;
      const dropLabeled = rest > 0 ? labeled.slice(0, rest) : [];
      const dropped = [...dropPlain, ...dropLabeled];
      if (dropped.length) archiveTurnCards(dropped);
      const dropSet = new Set(dropped.map(([id]) => id));
      entries = entries.filter(([id]) => !dropSet.has(id));
    }
    writeFileSync(turnCardsFilePath(), JSON.stringify(entries.map(([messageId, card]) => ({ messageId, card })), null, 2) + "\n", "utf8");
  } catch {
    // 持久化失败不阻断主流程（卡片是展示层增强）
  }
}
