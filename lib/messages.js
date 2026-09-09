// messages.js - 用户可见文案的集中层（第三批清淤 · 第 1 批 1a）
//
// 为什么有这个文件（分层判据，方案 §一）：
//   「面向用户的文案」随语言变化 → 属个人层。本文件提供**取词机制**（通用层），
//   内置默认用**英文**（发布面零中文的必经步骤），本机中文由 rule-engine.json 的
//   messages 键覆盖。个人层加载后功能完全可用；通用安装者拿到的是可用的英文默认。
//
// Override 语义（同 lexicons / patterns）：
//   键缺省 → 用内置默认；键存在 → 按键完全替换；{} → 回退内置；删键 → 回退。
//
// 用法：
//   import { getMessage } from "./messages.js";
//   getMessage("guard.unlock.done", { minutes: 10 });
//   → "Unlocked config write protection for 10 minutes."（或本机覆盖文案）
//
// 缺失 key 返回 key 本身（可见失败，不静默吞掉）。
let overrides = null;

/** 内置默认文案（英文；通用层）。key 采用 `<域>.<对象>.<动作>` 命名。 */
export const DEFAULT_MESSAGES = {
  // ── /guard 通用 ──
  "guard.usage.header": "Usage:",
  "guard.usage.footer": "Notes:",
  "guard.invalid": "Unknown subcommand. Run /guard help for the list.",
  "guard.rule-hint-fallback": "See /guard rules for this rule's details",
  // ── /guard freedom ──
  "guard.freedom.title": "Guard freedom surface (no authorization required):",
  "guard.freedom.blind.title": "Guard blind spots (invisible/imprecise — this engine is NOT a security boundary):",
  "guard.freedom.tip": "Tip: when blocked, read the \"how to unblock\" segment in the rejection text — it states this turn's exact condition.",
  // ── /guard status ──
  "guard.status.lang": "Display language: {lang} (source {source}; detected from AGENTS.md at startup, not persisted)",
  // ── 逃生门 ──
  "guard.unlock.done": "Config write protection unlocked for {minutes} minutes. You may now let the assistant edit rule-engine.json / rule-understanding.json / AGENTS.md; run /guard lock afterwards or wait for auto-restore.",
  "guard.bypass.done": "All guards suspended for {minutes} minutes (audited).",
  // ── 已知环境坑提示（原 patterns.js KNOWN_PITFALLS 的 hint，第 1 批 1b 迁出）──
  "pitfall.tls": "TLS credential failure (common in sandbox / restricted sessions) — consult your manual's TLS entry; setting NODE_USE_ENV_PROXY may help Node fetch.",
  "pitfall.proxy": "Proxy connection refused — make sure your proxy is running; git/gh often work direct while the npm registry may not (your release script may support DSH_RELEASE_PROXY).",
  "pitfall.sandbox-pipe": "Child-process pipes are restricted in a confined sandbox — run with full filesystem access.",
  "pitfall.module-missing": "Module missing — check the dependency closure / empty package shells.",
  // ── 装配审计提示（原 guard-core/text-detect 写死本机脚本名，1b 去本机化）──
  "pitfall.mount-audit": "Run your mount-consistency audit script (the one configured for this machine) and pass it before continuing.",
  // ── 批评检测引用（原 text-detect 引用本机手册章节号，1b 去本机化）──
  "criticism.strong": "User message matched a strong criticism/rebuke signal (rule 22②, pending adjudication): criticism is NOT authorization — write-class tools are frozen this turn. Respond with the four-part template: 1) stop; 2) attribution questions; 3) facts/cause/plan; 4) wait for instructions.",
  "criticism.weak": "User message looks like a criticism/challenge (rule 22②, pending adjudication): if it really is criticism — it is not authorization. Produce facts/cause/plan via the attribution questions, then wait. Ignore this note if it was just an ordinary question.",
  // ── M8 记忆沉淀提示（原 index.js 引用本机规则号，1b 去本机化）──
  "memory.sediment-missing": "This turn persisted manual/AGENTS changes through the configured entry script but did not call engram_store in the same turn; the memory-sediment chain should complete within one turn.",
  // ── 规则放行提示（原 guard-core RULE_HINTS，1c 迁出）──
  "rule-hint.1": "Analyze the root cause first, then continue once the problem is confirmed",
  "rule-hint.9": "Use a script file, or an explicit UTF-8 (no BOM) flow",
  "rule-hint.12A": "Ask the user for a matching authorization first (ask_user_question)",
  "rule-hint.13A": "Back up the target path first (copy to .bak / .backups/trash-)",
  "rule-hint.18": "Read the configured manual first (path from localIntegrations; unconfigured = this rule has no object)",
  "rule-hint.21": "Confirm per the rule's grading before persisting",
  "rule-hint.22": "Answer/present a plan first, or add an explicit execution clause (tool class + path range); authorized changes must fall inside this turn's clause or ask answer",
  "rule-hint.24": "Confirm the plugin is a dsh.bundle, or switch to the correct mount method",
  "rule-hint.27": "Run your mount-consistency audit script (the one configured for this machine) before continuing",
  // ── 条款自证提示（原 text-detect SELF_CERT_REASONS，1c 迁出）──
  "self-cert.14": "Report completely in one go (rule 14): separate facts from inferences",
  "self-cert.22": "Detected \"noted it\"-style filler; the correct action is to persist and report",
  "self-cert.23": "Delivery/completion claim without runtime verification evidence",
  "self-cert.16": "Use the bound-check format for suggestions (or give an effort-level suggestion with reasons) to avoid interrupting repeatedly",
  "self-cert.12E": "Confirm the UI really exists and state capability boundaries first (rule 12E)",
  "self-cert.26": "Confirm a formal Release Asset (release.assets) with a tgz/zip attached (rule 26)",
  "self-cert.10": "Self-certify per rule 10: state that context is not inherited by default, restore by priority, cite sources",
  "self-cert.12C": "Self-certify per rule 12C: announce proxy needs, stop on failure, verify downloads, test connectivity first",
  "self-cert.13B": "Self-certify per rule 13B: user fully exits DSH before session replacement; run all three verification layers; check mtime",
  "self-cert.15": "Self-certify per rule 15: do not judge recency by mtime/filename; keep and ask when version/purpose is unclear",
  "self-cert.19": "Self-certify per rule 19: sediment per items ①-⑧ and report the synced body locations",
  "self-cert.28": "Self-certify per rule 28: classify new files per the workspace index; check README or use _inbox when unsure",
  "self-cert.29": "Self-certify per rule 29: verify the dependency closure before restarting (non-empty key packages / intact top-level junctions / no dangling)",
  "self-cert.30": "Self-certify per rule 30: prove no dependency breakage + authorization before acting; attach verification evidence afterwards",
  "self-cert.31": "Self-certify per rule 31: state verification target → what hit the wall and why → source of the conclusion; do not keep guessing"
};

/** 当前生效文案快照（诊断用；键 → 文本） */
export function effectiveMessages() {
  const out = {};
  for (const k of Object.keys(DEFAULT_MESSAGES)) out[k] = overrides?.[k] ?? DEFAULT_MESSAGES[k];
  return out;
}

/**
 * 注入个人层文案（rule-engine.json 的 messages 键）。
 * 语义同 setLexicons：undefined/null = 不干预；对象 = 配置即真相；{} = 回退内置默认。
 * @returns {{applied: string[], rejected: Array<{key: string, reason: string}>, noop?: boolean}}
 */
export function setMessages(cfg) {
  const applied = [];
  const rejected = [];
  if (cfg === undefined || cfg === null) return { applied, rejected, noop: true };
  if (typeof cfg !== "object" || Array.isArray(cfg)) {
    overrides = null;
    return { applied, rejected };
  }
  const next = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v !== "string" || v.length === 0) {
      rejected.push({ key: k, reason: "empty-or-not-string" });
      continue;
    }
    next[k] = v;
    applied.push(k);
  }
  overrides = Object.keys(next).length > 0 ? next : null;
  return { applied, rejected };
}

/** 显式回退内置默认（测试用） */
export function resetMessages() {
  overrides = null;
}

/**
 * 取一条文案并做参数插值。
 * @param {string} key 文案键
 * @param {Record<string, unknown>} params `{name}` 占位符的取值
 * @returns {string} 文案；键不存在时返回 key 本身（可见失败）
 */
export function getMessage(key, params = {}) {
  const raw = overrides?.[key] ?? DEFAULT_MESSAGES[key];
  if (typeof raw !== "string") return String(key);
  if (!params || typeof params !== "object") return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

/** 该键是否有文案（内置或覆盖） */
export function hasMessage(key) {
  return typeof (overrides?.[key] ?? DEFAULT_MESSAGES[key]) === "string";
}

/** 是否处于个人层覆盖状态 */
export function hasMessageOverride() {
  return overrides !== null;
}
