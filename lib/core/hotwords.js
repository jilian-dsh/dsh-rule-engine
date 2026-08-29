// hotwords.js - 会话热词学习（B1，2026-08-29 方案甲由用户拍板）。
// 背景：词表是主裁决器（快/免费/可复现），但人工枚举永远补不完（v4.74/82 连补 4 轮仍漏——
// "落/认可/清理/移除/清空"逐个补）；0.5.12 A2 已有 LLM 兜底：词表未命中但 LLM 判为执行分点 → 放行。
// 本模块把"LLM 已确认过"的动作词沉淀为热词：下次同词直接词表命中，不再依赖 LLM（省成本 + 更快 + 可复现）。
//
// 原则：
//   1. 热词只服务"意图判定"（hasAction → execute 分点），绝不 bypass deny/授权——其他拦截链不受影响；
//   2. 学习只在 LLM 兜底明确判 hasExecute=true 且词表未命中时发生（非对称：词表不放行时不学）；
//   3. 持久化 ~/.dsh/rule-engine-hotwords.json（原子写 + 上限 + 容错；写失败静默回退，不影响主流程）；
//   4. 审计留痕 kind=hotword-learn（来源会话/词）；
//   5. 手动补词（lexicon.js）仍保留且优先：热词是自动通道，不替代编译词表。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dshHome } from "./paths.js";
import { audit } from "./audit.js";

const MAX_WORDS = 500;

export function hotwordFilePath() {
  return join(dshHome(), "rule-engine-hotwords.json");
}

function emptyStore() {
  return { versions: 1, words: [], updatedAt: null };
}

/** 读取热词文件（容错：缺失/损坏/非数组 → 空表） */
export function loadHotwords() {
  try {
    const raw = readFileSync(hotwordFilePath(), "utf8");
    const data = JSON.parse(raw);
    const words = Array.isArray(data?.words) ? data.words : [];
    // 元数据迁移容错：老格式 words 可能是字符串数组
    return {
      versions: Number(data?.versions) || 1,
      words: words.filter((w) => typeof w === "string" && w.length >= 2 && w.length <= 12),
      updatedAt: data?.updatedAt || null
    };
  } catch {
    return emptyStore();
  }
}

/** 原子写（tmp + rename）；失败静默（学习不影响主流程） */
export function saveHotwords(store) {
  try {
    const p = hotwordFilePath();
    mkdirSync(dshHome(), { recursive: true });
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
    renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

/** 文本是否命中热词（子串匹配；热词为空直接 false） */
export function hasHotwordAction(text) {
  const t = String(text || "").toLowerCase();
  const { words } = loadHotwords();
  for (const w of words) {
    if (w && t.includes(w.toLowerCase())) return true;
  }
  return false;
}

/**
 * 学习一个动作词（LLM 兜底确认 execute 且词表未命中时调用）。
 * 返回 true=已写入；false=校验失败/写失败。
 * 校验：2-12 字符、去空白、不重复、上限 500（旧→新保留）。
 */
export function learnHotword(word) {
  const clean = String(word || "").replace(/[\s"'“”‘’?,。；：!！?？、]/g, "").trim();
  if (clean.length < 2 || clean.length > 12) return false;
  const store = loadHotwords();
  if (store.words.includes(clean)) return true;
  store.words.push(clean);
  if (store.words.length > MAX_WORDS) store.words = store.words.slice(-MAX_WORDS);
  store.updatedAt = new Date().toISOString();
  const ok = saveHotwords(store);
  if (ok) {
    audit({ kind: "hotword-learn", rule: "22", name: "热词学习", reason: `LLM 确认动作词入热词表：${clean}`, session: "" });
  }
  return ok;
}
