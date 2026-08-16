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
  12: "rule12-approval",
  "12A": "rule12a-approval",
  "12B": "rule12b-skill",
  "12C": "rule12c-network",
  "12D": "rule12d-sensitive",
  13: "rule13-backup",
  "13A": "rule13a-backup",
  "13B": "rule13b-session",
  14: "rule14-report",
  18: "rule18-manual-first",
  21: "rule21-meta",
  22: "rule22-direct",
  23: "rule23-runtime-verify",
  24: "rule24-assembly-type",
  25: "rule25-tool-coverage",
  26: "rule26-release-asset",
  27: "rule27-mount-audit"
};

/** 根据执行等级推导动作 */
export function actionsForLevel(level) {
  const s = String(level || "").toUpperCase();
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
  if (/set-content|out-file|add-content|writealltext|utf8/i.test(checkText)) hints.push("bom-write");
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
  const confidence = level && elems.trigger && elems.check && elems.action ? "high" : level ? "medium" : "low";
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
