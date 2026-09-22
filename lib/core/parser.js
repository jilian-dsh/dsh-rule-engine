// parser.js - 解析 AGENTS.md 规则容器。
// 纯 Node，可独立测试。把 AGENTS.md 解析为规则列表，规则正文保留四要素原文。
import { readFileSync, statSync } from "node:fs";
import { agentsFilePath } from "./paths.js";
import { getFormatRe, getFormatCapture, getFormatLabels, getFormat } from "./formats.js";

// 五处格式预设已迁到格式描述对象（formats.js，顶键 `formats`）——本文件**不再写死任何格式正则**：
//   规则标题行 rule_header ／ 分区标题 section ／ 自由区域起止 free_zone ／ 执行等级 level ／ 四要素 elements。
// 取用一律经 getFormatRe(key[, part])（带缓存；配置注入后自动生效——**禁止在本文件缓存正则对象**）。
// 注：elements 的**取词**用 formats.elements.labels（标签词）；**编译**用 formats.elements.source——
// 其中的占位符 `__LABEL__` 逐个代成标签词后编译（flags 取该描述对象的 flags）；正文按 capture.body 取组
//（默认具名组 body）。
// 与 rules-manager 解析口径一致：标题剥离「（来源：…）」后缀（P1-4），避免 /guard rules 显示带尾巴——
// 该剥离仍在默认 rule_header.source 内（可经 formats.rule_header.source 覆盖）。
//
// 捕获组引用口径：capture 的值经 formats.js 白名单校验，只有两种合法形态——
//   · 具名组名（`(?<id>…)` 那种）：按 `m.groups[name]` 取值；
//   · 编号字符串（"1"）：按 `m[Number("1")]` 取值。
// 取不到＝该字段为空串，绝不让一行格式异常的规则把头一份规则文件整个读崩。
//
// elements 的编译口径：**用 elements.source 编译**，把其中的占位符 `__LABEL__` 逐标签代入
// （labels.trigger／check／action／exemption）；flags 取描述对象的 flags（不写死 i）。

/** 单一取值口径：按 capture 的引用形态从匹配结果取组值（具名 → 编号 → 兜底） */
function pick(match, ref, fallback = "") {
  if (!match) return fallback;
  const byName = match.groups?.[ref];
  if (byName !== undefined) return byName;
  const byIndex = match[Number(ref)];
  return byIndex === undefined ? fallback : byIndex;
}

/**
 * 从 AGENTS.md 解析全部规则。
 * @returns {{ok: boolean, missing: boolean, error?: string, rules: Array, raw: string, mtimeMs: number}}
 */
export function loadRules() {
  // 每次取用（不缓存正则对象）：配置注入 formats 后立即生效
  const freeZoneStartRe = getFormatRe("free_zone", "start");
  const freeZoneEndRe = getFormatRe("free_zone", "end");
  const sectionRe = getFormatRe("section");
  const ruleHeaderRe = getFormatRe("rule_header");
  const sectionCap = getFormatCapture("section");
  const ruleCap = getFormatCapture("rule_header");
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
    if (freeZoneStartRe?.test(line)) {
      if (current) rules.push(finalize(current, lines));
      current = null;
      inFreeZone = true;
      continue;
    }
    if (freeZoneEndRe?.test(line)) {
      inFreeZone = false;
      continue;
    }
    if (inFreeZone) continue;
    const sec = sectionRe?.exec(line);
    if (sec) {
      if (current) rules.push(finalize(current, lines));
      currentSection = String(pick(sec, sectionCap.title)).trim();
      current = null;
      continue;
    }
    const rule = ruleHeaderRe?.exec(line);
    if (rule) {
      if (current) rules.push(finalize(current, lines));
      current = {
        index: String(pick(rule, ruleCap.id)).trim(),
        title: String(pick(rule, ruleCap.title)).trim(),
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

/**
 * 从标题/表头提取执行等级（支持空格/顿号连接的组合等级，如 "B + D"、"A 弱 + D"）。
 * 单一真源：AGENTS.md 解析（finalize）与 disabled-rules.json 存档重建（state.js）共用，
 * 保证禁用占位规则的 level/actions 与在场规则口径一致。
 */
export function levelFromTitle(title) {
  const cap = getFormatCapture("level");
  const m = getFormatRe("level")?.exec(String(title || ""));
  if (!m) return "";
  return String(pick(m, cap.level)).replace(/\s+/g, "");
}

function finalize(rule, lines) {
  const body = lines.slice(rule.startLine + 1, rule.endLine).join("\n").trim();
  return {
    index: rule.index,
    title: rule.title,
    section: rule.section,
    startLine: rule.startLine,
    endLine: rule.endLine,
    level: levelFromTitle(rule.title),
    body
  };
}

/** 从规则正文提取四要素（标签词与格式经 formats.elements 描述） */
export function extractElements(body) {
  const out = { trigger: "", check: "", action: "", exemption: "" };
  const labels = getFormatLabels("elements");
  const elCap = getFormatCapture("elements");
  const base = getFormatRe("elements");
  if (!base) return out; // 格式不可用：四要素全空，不抛
  for (const key of ["trigger", "check", "action", "exemption"]) {
    const label = labels[key];
    if (typeof label !== "string" || label.length === 0) continue;
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = base.source.split("__LABEL__");
    const source = parts.length > 1 ? parts.join(escaped) : base.source; // 无占位符：照描述对象原样编译
    const re = new RegExp(source, base.flags);
    const m = String(body || "").match(re);
    if (!m) continue;
    out[key] = String(pick(m, elCap.body)).trim();
  }
  return out;
}
