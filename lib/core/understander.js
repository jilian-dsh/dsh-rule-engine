// understander.js - 规则理解器（模式库兜底版）。
// 输入 parser 解析出的规则，输出结构化执行配置。
// LLM 理解器可在后续版本接入 ctx.llm，当前先保证确定性与可测试性。
import { extractElements } from "./parser.js";
import {
  BOM_WRITE,
  DESTRUCTIVE_CMD,
  DSH_KEYWORDS_RE,
  INLINE_CMD,
  SENSITIVE_CMD,
  TIME_WORDS,
  PROMISE_WORDS,
  URL_RE,
  SOURCE_MARK
} from "./patterns.js";

const HANDLER_BY_RULE = {
  1: "rule1-retry",
  2: "rule2-time",
  5: "rule5-source",
  7: "rule7-promise",
  9: "rule9-inline-bom",
  11: "rule11-language",
  "12A": "rule12a-approval",
  "12B": "rule12b-skill",
  "12C": "rule12c-network",
  "13A": "rule13a-backup",
  // 13B 已于 2026-08-24 外移至手册（规则正文删除，映射一并清理，防死映射）
  // 14 为纯 D 级自证规则，无对应 handler（0.5.11：删除空转映射 registry）
  18: "rule18-manual-first",
  21: "rule21-meta",
  22: "rule22-7-direct",
  23: "rule23-runtime-verify",
  24: "rule24-assembly-type",
  26: "rule26-release-asset",
  27: "rule27-mount-audit"
};

/**
 * 覆盖自省（一致性预防机制）：
 *  - dead：HANDLER_BY_RULE 映射了但 AGENTS.md 无此规则 ID（死映射，应清理）
 *  - uncovered：A/C/M（deny/ask/meta）级但无 handler 的规则（规则声称会被机器执行，实际不会）
 * 在 /guard status 与一致性测试/脚本中使用；规则 21④/19⑦ 的体检触发条件之一。
 */
export function analyzeCoverage(configs) {
  const dead = new Map(); // ruleId -> handler（映射存在但规则不存在）
  const uncovered = []; // A/C/M 级规则但引擎无执行 handler
  const present = new Set();
  for (const cfg of configs || []) {
    if (cfg && cfg.ruleId !== undefined && cfg.ruleId !== null) present.add(String(cfg.ruleId));
  }
  for (const [id, handler] of Object.entries(HANDLER_BY_RULE)) {
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

/**
 * 理解一条规则。
 * @param {object} rule parser 输出
 * @returns {object} 执行配置
 */
export function understandRule(rule) {
  const elems = extractElements(rule.body || "");
  const level = rule.level || "";
  const actions = actionsForLevel(level);
  const hints = hintPatterns(elems.check);
  const triggerKeywords = splitKeywords(elems.trigger);
  const confidence = level && elems.trigger && elems.check && (elems.action || level.toUpperCase().includes("D")) ? "high" : level ? "medium" : "low";
  const handler = HANDLER_BY_RULE[rule.index] || "";
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

/** 批量理解 */
export function understandAll(rules) {
  return rules.map(understandRule);
}

/** 导出常用正则供测试/调试 */
export const REGEX = {
  INLINE_CMD,
  BOM_WRITE,
  DESTRUCTIVE_CMD,
  SENSITIVE_CMD,
  TIME_WORDS,
  PROMISE_WORDS,
  URL_RE,
  SOURCE_MARK,
  DSH_KEYWORDS_RE
};
