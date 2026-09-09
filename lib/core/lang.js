// lang.js - 首启语言探测（第三批第 1 波 §4）
//
// 设计（DSH 方案 §五③ 选项 (b)）：引擎启动时探测规则集语言——
//   读 AGENTS.md（经调用方传入其解析结果或原文），含 CJK → zh-CN；否则 en。
// 结果只缓存在**内存**，每次启动重探，**不落盘**（无配置文件、无副作用）。
// 用途：报错/提示/自由面/盲区等面向用户的展示语言。
//
// 注意：本模块是**通用层**——它只判断"用什么语言展示"，不携带任何语言内容。
// 文案本身由 messages 层/个人层提供（第 1 批清淤时落地）。
export const LANGS = ["zh-CN", "en"];
const DEFAULT_LANG = "en";
const CJK = /[\u4e00-\u9fff]/;

let current = DEFAULT_LANG;
let detectedFrom = "default";

/**
 * 探测语言：传规则集文本（AGENTS.md 原文或解析结果拼接），含 CJK → zh-CN。
 * @param {string} text 规则集文本
 * @returns {string} 生效语言
 */
export function detectLang(text) {
  const t = String(text || "");
  if (!t.trim()) {
    current = DEFAULT_LANG;
    detectedFrom = "empty";
    return current;
  }
  current = CJK.test(t) ? "zh-CN" : "en";
  detectedFrom = "agents-md";
  return current;
}

/** 当前生效语言 */
export function getLang() {
  return current;
}

/** 探测来源（诊断用：default | empty | agents-md | manual） */
export function getLangSource() {
  return detectedFrom;
}

/** 显式设置（测试/用户覆盖用；不落盘） */
export function setLang(lang) {
  if (!LANGS.includes(lang)) throw new Error(`Unknown language: ${lang} (supported: ${LANGS.join(" / ")})`);
  current = lang;
  detectedFrom = "manual";
  return current;
}

/** 双语选择：pickLang(zh, en) → 按当前语言取 */
export function pickLang(zh, en) {
  return current === "zh-CN" ? zh : en;
}

/** 重置为默认（测试用） */
export function resetLang() {
  current = DEFAULT_LANG;
  detectedFrom = "default";
}
