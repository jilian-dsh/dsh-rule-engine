// understander.js - 规则理解器（模式库兜底版）。
// 输入 parser 解析出的规则，输出结构化执行配置。
// LLM 理解器可在后续版本接入 ctx.llm，当前先保证确定性与可测试性。
import { extractElements, levelFromTitle } from "./parser.js";
import {
  BOM_WRITE,
  DESTRUCTIVE_CMD,
  dshKeywordsRe,
  INLINE_CMD,
  SENSITIVE_CMD,
  timeWordsRe,
  promiseWordsRe,
  URL_RE,
  sourceMarkRe
} from "./patterns.js";
import { normalizeHandlerName } from "./measure-kinds.js";

// 2026-08-31（残余1 剥离，用户定稿）：本机默认偏好表从代码下沉到本机配置——
// rule-engine.json 的 handlerDefaultMap（可选键，可整体替换/清空）。代码层默认表为空
// （通用版=零本机编号）；本机偏好经 state 注入（understandRule/understandAll 的 opts.defaultMap）。

/**
 * 覆盖自省（一致性预防机制）：
 *  - dead：defaultMap 映射了但 AGENTS.md 无此规则 ID（死映射，应清理）
 *  - uncovered：A/C/M（deny/ask/meta）级但无 handler 的规则（规则声称会被机器执行，实际不会）
 * 在 /guard status 与一致性测试/脚本中使用；规则 21④/19⑦ 的体检触发条件之一。
 * 剥离后 defaultMap 由调用方传入（本机=配置表；通用=空表）；缺省空表 → dead 恒 0。
 * @param {object} configs 理解产物
 * @param {object} [defaultMap] 生效的默认偏好表（{ruleId: handlerName}）
 */
export function analyzeCoverage(configs, defaultMap = {}) {
  const dead = new Map(); // ruleId -> handler（映射存在但规则不存在）
  const uncovered = []; // A/C/M 级规则但引擎无执行 handler
  const present = new Set();
  for (const cfg of configs || []) {
    if (cfg && cfg.ruleId !== undefined && cfg.ruleId !== null) present.add(String(cfg.ruleId));
  }
  for (const [id, handler] of Object.entries(defaultMap || {})) {
    if (!present.has(String(id))) dead.set(String(id), handler);
  }
  for (const cfg of configs || []) {
    if (cfg.disabled) continue;
    const acts = cfg.actions || [];
    const hard = acts.some((a) => a === "deny" || a === "ask" || a === "meta");
    if (hard && !cfg.handler) {
      uncovered.push({ ruleId: String(cfg.ruleId), title: cfg.title, actions: acts });
    }
  }
  return { dead, uncovered };
}

/** 根据执行等级推导动作（容忍空白/强弱/连接符：如 "B + D"、"A 弱 + D"、"D 强"） */
export function actionsForLevel(level) {
  const s = String(level || "").toUpperCase().replace(/\s+/g, "");
  const actions = [];
  if (s.includes("A")) actions.push("deny");
  if (s.includes("B")) actions.push("correct");
  if (s.includes("C")) actions.push("ask");
  if (s.includes("D")) actions.push("self-certify");
  if (s.includes("M")) actions.push("meta");
  if (actions.length === 0) actions.push("self-certify");
  return [...new Set(actions)];
}

function splitKeywords(text) {
  if (!text) return [];
  return text
    .split(/[，。；、,\n；:：/\\()（）]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 20);
}

/** 从检查文本提取机器可用的提示词 */
function hintPatterns(checkText) {
  const hints = [];
  if (/node\s+-e|node\s+-p|pwsh\s+-c|--eval|--print|-Command\b/i.test(checkText)) hints.push("inline-command");
  if (/set-content|out-file|add-content|writealltext|utf8bom/i.test(checkText)) hints.push("bom-write");
  if (/ask_user_question|授权|弹框/i.test(checkText)) hints.push("ask");
  if (/get-date|时间词|昨天|今天/i.test(checkText)) hints.push("time");
  if (/skill|技能/i.test(checkText)) hints.push("skill");
  if (/git\s+(push|commit)|敏感操作|授权/i.test(checkText)) hints.push("sensitive");
  if (/删除|覆盖|备份|验证/i.test(checkText)) hints.push("backup");
  if (/手册/i.test(checkText)) hints.push("manual");
  if (/重试|连续失败|第\s*3\s*次/i.test(checkText)) hints.push("retry");
  if (/运行时验证|mock|启动|实测/i.test(checkText)) hints.push("runtime-verify");
  if (/URL|来源|出处|引用/i.test(checkText)) hints.push("source");
  if (/中文|英文|语言/i.test(checkText)) hints.push("language");
  return [...new Set(hints)];
}

/** 规则正文内联 handler 声明（T3）：`<!-- handler: <kind> -->`（kind 名或历史内部名皆可） */
const HANDLER_DECL_RE = /<!--\s*handler\s*:\s*([a-z0-9][a-z0-9-]*)\s*-->/i;

/**
 * 措施类型归一（架构 v3 P1，2026-09-10）：
 *   注册表（MEASURE_KINDS）+ 兼容别名表（LEGACY_HANDLER_ALIASES）+ 归一入口（kindOf）
 *   已迁至 ./measure-kinds.js —— 本文件自此不含任何规则号字面量。
 *   归一语义：历史内部名 → kind；kind 名 → 原样（幂等）；未知名 → 原样（覆盖自省提示未覆盖）。
 */
export { normalizeHandlerName, kindOf, MEASURE_KINDS, LEGACY_HANDLER_ALIASES } from "./measure-kinds.js";

/**
 * handler 绑定解析（T3 通用化，2026-08-31）——优先级：
 *  ① opts.handlerOverrides[ruleId] （rule-engine.json 配置覆盖，集中管理）
 *  ② 规则正文内联声明 <!-- handler: xxx --> （随规则走，可声明任意已实现执行器）
 *  ③ opts.defaultMap || HANDLER_BY_RULE （本机默认偏好表；defaultMap 可整体替换）
 *  ④ "" （未绑定=纯自证规则，README「局限 4」分流——规则仍参与匹配/自证，不参与硬拦）
 * 所有来源经 normalizeHandlerName 归一（语义名/内部名均可；本机零行为变化）。
 */
export function resolveHandler(rule, opts = {}) {
  const id = String(rule?.index ?? "");
  const overrides = opts?.handlerOverrides;
  if (overrides && typeof overrides === "object" && overrides[id] !== undefined) return normalizeHandlerName(overrides[id]);
  const body = String(rule?.body || "");
  const decl = body.match(HANDLER_DECL_RE);
  if (decl) return normalizeHandlerName(decl[1]);
  // 剥离后（2026-08-31）：代码层无默认表；defaultMap 由调用方注入（本机=配置 handlerDefaultMap）
  const map = opts?.defaultMap || {};
  return normalizeHandlerName(map[rule?.index] || "");
}

/**
 * 理解一条规则。
 * @param {object} rule parser 输出
 * @param {object} [opts] 绑定选项（handlerOverrides/defaultMap，见 resolveHandler）
 * @returns {object} 执行配置
 */
export function understandRule(rule, opts = {}) {
  const elems = extractElements(rule.body || "");
  const level = rule.level || "";
  const actions = actionsForLevel(level);
  const hints = hintPatterns(elems.check);
  const triggerKeywords = splitKeywords(elems.trigger);
  const confidence = level && elems.trigger && elems.check && (elems.action || level.toUpperCase().includes("D")) ? "high" : level ? "medium" : "low";
  const handler = resolveHandler(rule, opts);
  const config = {
    ruleId: rule.index,
    title: rule.title,
    section: rule.section,
    level,
    actions,
    confidence,
    handler,
    triggerKeywords,
    hints,
    elements: elems,
    disabled: false
  };
  return config;
}

/** 批量理解。opts：
 *  - disabledEntries: dsh-rules-manager 禁用存档条目（数组）。正文已移走、不在 rules 中的
 *    禁用规则用存档正文重建占位 cfg（disabled=true）——禁用=存在但休眠，恢复自动生效。
 *    在理解层重建保证所有调用方（state/consistency-live/运行时）口径一致。
 *  - handlerOverrides: { ruleId: handlerName } 声明式绑定覆盖（T3，通用化通道）。
 *  - defaultMap: 覆盖 HANDLER_BY_RULE 默认偏好表（T3；缺省=本机默认表）。
 */
export function understandAll(rules, opts = {}) {
  const configs = (rules || []).map((r) => understandRule(r, opts));
  const entries = opts?.disabledEntries;
  if (Array.isArray(entries) && entries.length) {
    const disabledIds = new Set(entries.map((d) => String(d.index)).filter(Boolean));
    // 在场禁用规则：只标 disabled（保留 AGENTS.md 正文，不被存档覆盖）
    for (const cfg of configs) {
      if (disabledIds.has(String(cfg.ruleId))) cfg.disabled = true;
    }
    // 缺场禁用规则：用存档正文重建占位（正文已移走的规则不再"消失"）
    const present = new Set(configs.map((c) => String(c.ruleId)));
    for (const entry of entries) {
      const key = String(entry.index);
      if (present.has(key)) continue;
      const cfg = understandRule({
        index: entry.index,
        title: entry.title || "",
        section: entry.section || "",
        level: levelFromTitle(entry.header || entry.title || ""),
        body: entry.body || ""
      }, opts);
      cfg.disabled = true;
      configs.push(cfg);
    }
  }
  return configs;
}

/** 导出常用正则供测试/调试（P8 小批 B：可配置项经访问器取当前生效值） */
export const REGEX = {
  INLINE_CMD,
  BOM_WRITE,
  DESTRUCTIVE_CMD,
  SENSITIVE_CMD,
  get TIME_WORDS() { return timeWordsRe(); },
  get PROMISE_WORDS() { return promiseWordsRe(); },
  URL_RE,
  get SOURCE_MARK() { return sourceMarkRe(); },
  get DSH_KEYWORDS_RE() { return dshKeywordsRe(); }
};
