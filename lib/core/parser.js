// parser.js - 解析 AGENTS.md 规则容器。
// 纯 Node，可独立测试。把 AGENTS.md 解析为规则列表，规则正文保留四要素原文。
import { readFileSync, statSync } from "node:fs";
import { agentsFilePath } from "./paths.js";

// 与 rules-manager 解析口径一致：标题剥离「（来源：…）」后缀（P1-4），避免 /guard rules 显示带尾巴
const RULE_HEADER_RE = /^###\s*\[规则\s*([0-9A-Za-z]+)\]\s*(.+?)\s*(?:（来源[^）]*）)?\s*$/;
const SECTION_RE = /^##\s+(.+?)\s*$/;
const FREE_ZONE_START_RE = /^\s*<!--\s*free-zone:start\s*-->\s*$/;
const FREE_ZONE_END_RE = /^\s*<!--\s*free-zone:end\s*-->\s*$/;

/**
 * 从 AGENTS.md 解析全部规则。
 * @returns {{ok: boolean, missing: boolean, error?: string, rules: Array, raw: string, mtimeMs: number}}
 */
export function loadRules() {
  const file = agentsFilePath();
  let raw;
  let mtimeMs = 0;
  try {
    raw = readFileSync(file, "utf8");
    mtimeMs = statSync(file).mtimeMs;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { ok: false, missing: true, error: `未找到 ${file}`, rules: [], raw: "", mtimeMs: 0 };
    }
    return { ok: false, missing: false, error: String(error), rules: [], raw: "", mtimeMs: 0 };
  }
  const bom = raw.charCodeAt(0) === 0xfeff;
  const text = bom ? raw.slice(1) : raw;
  const lines = text.split("\n");
  const rules = [];
  let currentSection = "未分区";
  let current = null;
  let inFreeZone = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 自由区域边界：区内内容完全不解析（不产生规则、不切换分区），对引擎透明
    if (FREE_ZONE_START_RE.test(line)) {
      if (current) rules.push(finalize(current, lines));
      current = null;
      inFreeZone = true;
      continue;
    }
    if (FREE_ZONE_END_RE.test(line)) {
      inFreeZone = false;
      continue;
    }
    if (inFreeZone) continue;
    const sec = line.match(SECTION_RE);
    if (sec) {
      if (current) rules.push(finalize(current, lines));
      currentSection = sec[1].trim();
      current = null;
      continue;
    }
    const rule = line.match(RULE_HEADER_RE);
    if (rule) {
      if (current) rules.push(finalize(current, lines));
      current = {
        index: rule[1],
        title: rule[2].trim(),
        section: currentSection,
        startLine: i,
        endLine: i + 1
      };
    } else if (current) {
      current.endLine = i + 1;
    }
  }
  if (current) rules.push(finalize(current, lines));
  return { ok: true, missing: false, error: null, rules, raw: text, mtimeMs };
}

function finalize(rule, lines) {
  const body = lines.slice(rule.startLine + 1, rule.endLine).join("\n").trim();
  const levelMatch = rule.title.match(/执行等级[：:]\s*([A-DM+]+(?:\s*[强弱])?)/);
  return {
    index: rule.index,
    title: rule.title,
    section: rule.section,
    startLine: rule.startLine,
    endLine: rule.endLine,
    level: levelMatch ? levelMatch[1].replace(/\s+/g, "") : "",
    body
  };
}

/** 从规则正文提取四要素 */
export function extractElements(body) {
  const out = { trigger: "", check: "", action: "", exemption: "" };
  const grab = (label) => {
    const re = new RegExp(`\\*\\*${label}(?:（[^）]*）)?\\*\\*[：:]\\s*([^\\n]*(?:\\n(?!\\s*\\*\\*)[^\\n]*)*)`, "i");
    const m = body.match(re);
    return m ? m[1].trim() : "";
  };
  out.trigger = grab("触发");
  out.check = grab("检查");
  out.action = grab("动作");
  out.exemption = grab("豁免");
  return out;
}
