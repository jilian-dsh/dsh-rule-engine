// text-detect.js - 输出文本检测（B 级纠察 + 部分 D 级自证触发）。
// 官方架构下 assistant/message 无法拦下不发，因此这里做「必发现、必记账、可注入纠正」。
import { getMessage, hasMessage } from "../messages.js";
import { onPatternsReset } from "./patterns.js";
import {
  CJK_RE,
  promiseWordsRe,
  sourceMarkRe,
  timeWordsRe,
  historicDateRe,
  evidenceMarkRe,
  URL_RE,
  techTermRe,
  termExplanationRe,
  suggestRe,
  criticismShapeRe,
  criticismWeakRe,
  execDirectiveRe,
  deliveryClaimRe,
  internalRefRe,
  verifyIntentRe,
  emptyTalkRe,
  deliveryNoVerifyRe,
  verifyEvidenceRe,
  mountMentionRe,
  mountAuditOkRe,
  scopeOverreachRe,
  scopeBoundedRe,
  apologyOnlyRe,
  apologyWithCauseRe,
  versionRecordMentionRe,
  versionRecordOnlyRe,
  versionSyncOkRe,
  patMap,
  patNum,
  isNegatingSuggestion,
  isQuoteOrParaphraseContext,
  isReadOnlyTool
} from "./patterns.js";
import { detectOverengineeringText } from "./overengineering.js";

// ── self_cert_checks 取词（第三批，2026-09-21）──
// 两段判定词（规则词＋自证尾词）迁 patterns.self_cert_checks；拼装公式、id 转义、suffix 与 flags 口径留代码。
// 缓存不被模块级锁死：onPatternsReset 在 setPatterns／resetPatterns 生效后清空本缓存。
let selfCertReCache = null;
function selfCertRe() {
  if (selfCertReCache !== null) return selfCertReCache;
  const map = patMap("self_cert_checks");
  const ruleWord = String(map.rule_word ?? "");
  const tail = String(map.tail ?? "");
  if (!ruleWord || !tail) {
    selfCertReCache = false;
    return false;
  }
  try {
    // 可用性探针：真正拼装按 id 逐次进行（下方 isSelfCertified）
    selfCertReCache = new RegExp(`(?:${ruleWord}|${tail})`);
  } catch {
    selfCertReCache = false;
  }
  return selfCertReCache;
}
onPatternsReset(() => {
  selfCertReCache = null;
});

// F2（2026-08-28 阶段三）：交付声明强模式（规则 23④ verify-gap 词面）——
// 裸"完成"太宽（"完成社区检索/尚未完成/正在完成"误触）→ 强完成声明 + 否定/进行态排除。
// 模块级导出（纯函数模块，可测试锁定）；LLM 裁决层（deliverSuspects）兜底不变。
// 用户批评形态（规则 22②；2026-09-02 建、2026-09-08 第二批 §1.3 重构为 A″）：
//   A″ = 语义主判、无通用词表、宽松触发、行为闸：
//   - 通用层只留**语言无关形态**：连续问号/叹号（CRITICISM_SHAPE_RE）+ 英文全大写比率（hasHighCapsRatio）；
//     2026-09-15（踩坑 144 修法 (b)）：大写比率一支改由 **hasShoutingWordShape** 把关——只认"词形" token
//     （连续字母 ≥4、≥2 个），编号标签（A1/B5）与缩写（ESR/DSH）不再计为"喊叫"；纯比率函数保留导出供配置层复用。
//   - 辱骂词枚举**迁出**到本机 rule-engine.json 的 criticismPersonal（发布面不含个人话术），经 setCriticismPersonal 注入；
//   - 机器层只产"疑似"信号（不再直接产 correct），裁决归 LLM 层（judge/deliverSuspects 兜底）；
//   - 行为闸在 index.js：命中疑似 → 冻结本回合写类工具 + 注入四段模板（停止/归因四问/三件套/等指令）。
// A″ 强形态正则：P8 小批 C 起经 patterns.js 的 criticismShapeRe() 取（内置默认含全角/半角问号叹号形态，可配置）


/** 本机辱骂词表（criticismPersonal 注入；空 = 不启用——通用发布面恒为空） */
let personalCriticism = [];
export function setCriticismPersonal(words) {
  personalCriticism = Array.isArray(words)
    ? words.filter((w) => typeof w === "string" && w.trim().length > 0)
    : [];
}
export function getCriticismPersonal() {
  return [...personalCriticism];
}
function personalCriticismRe() {
  if (!personalCriticism.length) return null;
  const alts = personalCriticism.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?:${alts.join("|")})`);
}

/** 情绪强度信号：英文全大写比率 ≥ 阈值（默认 0.6，经 patterns.criticism_caps_ratio 可配置）且字母数 ≥6
 *（语言无关的"喊叫"形态）。**注意**：本函数只看比率，不区分"词"与"标识符"——判"喊叫"请用
 *  hasShoutingWordShape（2026-09-15 起 criticismSignals 用的是后者）。 */
export function hasHighCapsRatio(text) {
  const t = String(text || "");
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length < 6) return false;
  const caps = letters.replace(/[^A-Z]/g, "");
  return caps.length / letters.length >= patNum("criticism_caps_ratio");
}

/** 词形大写"喊叫"形态（2026-09-15，踩坑 144 修法 (b) 收紧档）：**只认词形 token**——
 *  取「连续字母 ≥ criticism_caps_min_word_len」的 token（`A1`／`B5`／`12B` 这类编号因连续字母不足被排除、
 *  3 字母缩写 `ESR` 亦不足默认 4），需此类 token ≥ criticism_caps_min_tokens 个，
 *  再对这些 token 的整体大写比率套 hasHighCapsRatio。
 *  由来：纯比率版在中文/技术语境必然误报（几个大写标记即 100%），A″ 因此误冻结写类工具。 */
export function hasShoutingWordShape(text) {
  const t = String(text || "");
  const minLen = Math.max(2, patNum("criticism_caps_min_word_len"));
  const minToks = Math.max(1, patNum("criticism_caps_min_tokens"));
  const toks = t.match(new RegExp(`[A-Za-z]{${minLen},}`, "g")) || [];
  if (toks.length < minToks) return false;
  return hasHighCapsRatio(toks.join(" "));
}

/** 批评疑似检测（A″）：{shape, personal, weak, suspect}——机器只产疑似，判定权归模型 */
export function criticismSignals(text) {
  const t = String(text || "");
  const shape = criticismShapeRe().test(t) || hasShoutingWordShape(t);
  const personal = (personalCriticismRe() || /$^/).test(t);
  const weak = criticismWeakRe().test(t);
  return { shape, personal, weak, suspect: shape || personal ? "strong" : weak ? "weak" : null };
}

// WEAK 嫌疑集：反问/责问/否定比较形态（"怎么还在做/又错了/这不对吧/你是不是又…"）。
// 允许偏宽（普通技术疑问如"怎么用"也会进入嫌疑）——判定权在 judge：模型确认才是提醒，拿不准=不打扰。
// P8 小批 C：经 patterns.js 的 criticismWeakRe() 取（内置默认=英文最小集；中文形态由本机 patterns 注入）。

/**
 * A″ 反向检查（2026-09-09 第三批，A″ 后果分级）：用户消息是否含明确执行指令词。
 * 用途：弱信号（偏宽形态）遇执行指令 → 只留痕、不注入提示
 *（避免把"…是更新还是写…"这类正常指令读成责问）。强信号不受本检查影响，仍按行为闸冻结。
 */
export function hasExplicitExecWord(text) {
  return execDirectiveRe().test(String(text || ""));
}

export const DELIVERY_RE = () => deliveryClaimRe();

// 2026-09-06 0.6.x（tsk_527d222c 第一期）：路径缩写 B 级检测——回复含缩写路径（reports\ / ~/.dsh / %USERPROFILE%）
// 且非完整盘符形态 → 提醒写完整绝对路径（规则 14⑤ 机器化第一层；WEAK 形态：留痕+注入，不拦截）
// 【5-1 后绿 2026-09-22】两处边界修正（与 scripts/check-wording.mjs 保持**逐字同形**）：
//   ① 前置字符类补反引号（U+0060）——原字符类不含它，`reports\x` 这种反引号包裹形态被漏判；
//   ② 完整盘符路径由 [^\n]*（贪婪吃至行尾）收为 \S*（收到空白为止）——原形态会把同一行
//      **后面**的第二处缩写一并剥掉，造成"盘符路径之后的缩写"漏判；收到空白后，
//      "整段盘符路径内部带 reports 段"（如 D:\x\reports\y.md）仍被整段剥掉 → 仍不算缩写。
const PATH_ABBREV_RE = /(?:^|[\s"'“”（(`])(?:reports|~\/?\.dsh|%USERPROFILE%)[\\/]/i;
const ABS_PATH_RE = /[A-Za-z]:[\\/]\S*/g;
export function hasPathAbbrev(text) {
  if (typeof text !== "string") return false;
  return PATH_ABBREV_RE.test(String(text).replace(ABS_PATH_RE, ""));
}

/** 从 assistant message 内容中提取纯文本 */
export function extractAssistantText(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && b.type === "text" ? b.text : ""))      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** 条款自证触发词的中文提示文案（reason 留代码；正则在配置层 self_cert_hints） */
// 判据 A（2026-09-09）：规则号清单**不再硬编码**——提示 key 由约定推导（self-cert.<ruleId>），
// 是否存在由 messages 层决定。规则号怎么变，改本机配置即可。

/** 取某条款的自证提示（正则经 patMap 从配置层取；无配置/无文案 = null） */
function selfCertHint(ruleId) {
  const src = patMap("self_cert_hints")[String(ruleId)];
  const reasonKey = `self-cert.${ruleId}`;
  if (typeof src !== "string" || !src || !hasMessage(reasonKey)) return null;
  return { re: new RegExp(src, "i"), reason: getMessage(reasonKey) };
}

// 规则 31（2026-09-01 用户拍板）：内部文档引用锚点词（"文档"仅在后随"写了/记载…"语境命中，防泛化误报）
const INTERNAL_REF_RE = () => internalRefRe();
// 验证目标启发式：思维链含这些词 → 大概率是有序查证（防规则 31③误报）
const VERIFY_INTENT_RE = () => verifyIntentRe();

/** 简单判断一段文本是否以英文为主 */
function isMostlyEnglish(text) {
  if (!text) return false;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const cjk = (text.match(CJK_RE) || []).length;
  return letters > 30 && cjk === 0;
}

/**
 * 注入噪音治理 v0.5.6（建议2/3 已自证抑制）：同一条回复中已含"规则 X 已按/已自证/已核对…"标记时，
 * 该规则本轮不再计为新违规——打断"自证回复复述触发词 → 再次注入"的自循环。
 * 仅对 kind=self-certify 的 D 级自证命中生效；B 级纠察（kind=correct）不受影响（审计优先）。
 */
export function isSelfCertified(text, ruleId) {
  if (!text || !ruleId) return false;
  const id = String(ruleId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 第三批（2026-09-21）：两段判定词（规则词＋自证尾词）迁 patterns.self_cert_checks，取词经 selfCertRe()；
  // 拼装公式、id 转义、suffix（①–⑩／数字）仍留本函数；flags 空。
  const ruleWord = String(patMap("self_cert_checks").rule_word ?? "");
  const tail = String(patMap("self_cert_checks").tail ?? "");
  if (selfCertRe() === null) return false; // 词表不可用：不判定（不抛）
  const suffix = "(?:[①②③④⑤⑥⑦⑧⑨⑩]|\\.\\d+|\\d+)?";
  const re = new RegExp(`(?:${ruleWord}\\s*${id}${suffix}\\s*${tail}|${tail}\\s*${ruleWord}\\s*${id}${suffix})`);
  return re.test(text);
}

/**
 * 规则 2 时间核对的独立判定（F1，2026-08-28 阶段三）：
 * 原实现嵌在 detectViolations（assistant/message 时调）——但 Get-Date 工具常在本回合后续步骤
 * 才执行（事故实弹：correct 04:52:23.061 早于 Get-Date 放行 .068）→ 真调了也判"未先核对"。
 * A3（规则 2 单一判定源）：本函数是规则 2 的判定体——detectViolations 调用它并把命中并入；
 * 投递时机（回合末按 lane 撤销/投递）由 index.js 的 session/event 处理决定，判定本身不依赖调用时机。
 * 两类命中各自独立成条：lane=getdate（缺 Get-Date 核对，仅当下时间词）/ lane=evidence（缺事件证据锚）。
 * @param {object} session 会话状态（turn.getDateSeen 已由 tool/call 置位）
 * @param {string} text assistant 纯文本
 * @param {object} timeCfg 规则 2 配置（byId.get("2")）
 * @returns {Array<{ruleId,title,kind,lane,reason}>}
 */
export function detectTimeRule(session, text, timeCfg) {
  const hasNow = timeWordsRe().test(text);
  const hasHist = historicDateRe().test(text);
  if (!timeCfg || (!hasNow && !hasHist)) return [];
  if (isQuoteOrParaphraseContext(text, timeWordsRe()) || isQuoteOrParaphraseContext(text, historicDateRe())) return [];
  const hits = [];
  // A1（2026-09-03 拆组）：当下时间词才要求 Get-Date 核对（lane=getdate）；历史日期只走证据锚。
  if (hasNow && !session?.turn?.getDateSeen) {
    hits.push({
      ruleId: "2",
      title: timeCfg.title,
      kind: "correct",
      lane: "getdate",
      reason: "回答出现具体时间词/日期，但本回合未先调用 Get-Date 核对"
    });
  }
  // A3（规则 2 按 lane 记账）：证据锚缺失独立成 evidence 条——不再被 getdate 条挤掉（原互斥语义废止）。
  if ((hasNow || hasHist) && !evidenceMarkRe().test(text)) {
    hits.push({
      ruleId: "2",
      title: timeCfg.title,
      kind: "correct",
      lane: "evidence",
      reason: "回答含具体时间词/日期但未附事件证据标注（日志 ts/文件 mtime/进程启动时间/commit 锚/版本行/踩坑 N 等）——Get-Date 当前时间不算过去事件证据（规则 2②）。正确动作：查该事件证据补（来源：…）或删时间词/标【时间未核实】，勿以当前时间替代"
    });
  }
  return hits;
}

/**
 * 检测一次 assistant/message 的 B/D 级违规。
 * 规则 2 的判定体在 detectTimeRule（本文件）——此处只调用它并把命中并入，判定口径不在本函数内维护；
 * 投递时机（回合末按 lane 撤销/投递）由 index.js 的 session/event 处理决定。
 * @param {object} options
 * @param {Array} options.configs 理解配置
 * @param {object} options.session 会话状态（getSessionState 返回）
 * @param {string} options.text assistant 纯文本
 * @returns {Array<{ruleId:string,title:string,kind:string,reason:string}>}
 */
// ── 域 3 第二枪（2026-09-22）：注入文案命令词迁配置层（rule-engine.json 的 injectCommand 键）。
// 内置＝语言无关最小集；取词走 getter，禁止顶层缓存实例。──
const INJECT_COMMAND_BUILTIN =
  /\b(?:please\s+(?:immediately|(?:execute|do)(?:\s+directly)?)|(?:immediately|directly)\s+execute|do\s+it\s+now|don'?t\s+(?:again|anymore))\b/.source;

let injectCommandOverride = null; // 合并后 source | null

/** 域 3 第二枪：空＝还原内置；非空＝默认合并；{ clear: true }＝仅配置；非法正则跳过且不覆盖现状 */
export function setInjectCommand(source, opts = {}) {
  if (typeof source !== "string" || source.length === 0) {
    injectCommandOverride = null;
    return;
  }
  try {
    new RegExp(source, "i");
  } catch {
    return;
  }
  injectCommandOverride = opts?.clear ? source : `(?:${INJECT_COMMAND_BUILTIN})|(?:${source})`;
}

function currentInjectCommand() {
  return new RegExp(injectCommandOverride ?? INJECT_COMMAND_BUILTIN, "i");
}

/** 注入文案是否含命令式短语（D1 静态闸判据） */
export function isInjectCommandText(text) {
  return currentInjectCommand().test(String(text || ""));
}

// ── 域 3 第三枪（2026-09-22）：白名单口令正则迁配置层（rule-engine.json 的 whitelistAllow 键）。
// 内置＝语言无关最小集；取词走 getter（必须 gi：调用侧 matchAll 需 g、英文需 i），禁止顶层缓存实例。──
const WHITELIST_ALLOW_BUILTIN =
  /\b(?:allow|approve|permit|authorize)\s+(?:use|call|enable|invoke)\s+([A-Za-z_][A-Za-z0-9_:.-]*)/.source;

let whitelistAllowOverride = null; // 合并后 source | null

/** 域 3 第三枪：空＝还原内置；非空＝默认合并；{ clear: true }＝仅配置；非法正则跳过且不覆盖现状 */
export function setWhitelistAllow(source, opts = {}) {
  if (typeof source !== "string" || source.length === 0) {
    whitelistAllowOverride = null;
    return;
  }
  try {
    new RegExp(source, "gi");
  } catch {
    return;
  }
  whitelistAllowOverride = opts?.clear ? source : `(?:${WHITELIST_ALLOW_BUILTIN})|(?:${source})`;
}

/** 当前生效的白名单口令正则（每次新实例；g 供 matchAll、i 供英文大小写） */
export function currentWhitelistAllow() {
  return new RegExp(whitelistAllowOverride ?? WHITELIST_ALLOW_BUILTIN, "gi");
}

export function detectViolations({ configs, session, text, reasoningText = "", mountRevision = 0, rule5Window = 3 }) {
  const hits = [];
  const byId = new Map(configs.filter((c) => c.confidence !== "low").map((c) => [String(c.ruleId), c]));

  const timeCfg = byId.get("2");
  // A3（规则 2 单一判定源）：本分支不再内联判定，改为调用 detectTimeRule 并并入其命中——
  // 判定口径（当下时间词/历史日期拆组、引述豁免、lane 分类）只在该函数一处维护。
  // 投递时机由 index.js 在回合末按 lane 复核（见 detectTimeRule 注释）。
  if (timeCfg) hits.push(...detectTimeRule(session, text, timeCfg));

  const promiseCfg = byId.get("7");
  // v0.5.7 P0.5-5：承诺词处于引述/改写语境（"把'保证'改成…"）→ 引述不是承诺，不触发
  if (promiseCfg && promiseWordsRe().test(text) && !isQuoteOrParaphraseContext(text, promiseWordsRe())) {
    hits.push({
      ruleId: "7",
      title: promiseCfg.title,
      kind: "correct",
      reason: "检测到绝对化承诺词，请改为保守表述"
    });
  }

  // 2026-09-06 0.6.x（tsk_527d222c 第一期）：路径缩写 B 级（规则 14⑤ 机器化——WEAK，留痕+注入不拦）
  if (hasPathAbbrev(text)) {
    hits.push({
      ruleId: "14",
      title: "汇报规范（完整文件位置路径）",
      kind: "correct",
      reason: "回复含缩写路径（reports\\ / ~/.dsh / %USERPROFILE% 等）——给用户应写完整盘符绝对路径（规则 14⑤）"
    });
  }

  const sourceCfg = byId.get("5");
  if (sourceCfg && !sourceMarkRe().test(text)) {
    if (URL_RE.test(text)) {
      hits.push({
        ruleId: "5",
        title: sourceCfg.title,
        kind: "correct",
        reason: "回答包含 URL 但未标注出处/来源"
      });
    } else if (INTERNAL_REF_RE().test(text) && !isQuoteOrParaphraseContext(text, INTERNAL_REF_RE())) {
      // 规则 5 扩展（2026-09-01 用户拍板）：内部文档引用（手册/踩坑/条款/源码…）须有依据——
      // 近 rule5Window 回合（默认 3；配置层 rule-engine.json `rule5SourceWindow` 可覆盖，2026-09-03
      // 通用化修正：本机偏好走配置、通用默认保持 3）无对应 read/grep 时提示（B 级：留痕+注入，不拦截）。
      const curTurn = session.turn.number || 0;
      const lastQuery = session.lastQueryTurn ?? -1;
      if (lastQuery < 0 || curTurn - lastQuery > rule5Window) {
        hits.push({
          ruleId: "5",
          title: sourceCfg.title,
          kind: "correct",
          reason: `回答引用内部文档（手册/踩坑/条款/源码等）但近 ${rule5Window} 回合无对应 read/grep——请标注手册位置或删去断言`
        });
      }
    }
  }

  // 规则 22② 机器提示（2026-09-02 建；2026-09-08 第二批 §1.3 重构 A″：机器只产疑似、裁决归 LLM；行为闸在 index.js）
  const cfg22 = byId.get("22");
  if (cfg22 && session.lastUserText) {
    const critText = session.lastUserText;
    const sig = criticismSignals(critText);
    if (sig.suspect === "strong" && !isQuoteOrParaphraseContext(critText, criticismShapeRe())) {
      hits.push({
        ruleId: "22",
        title: cfg22.title,
        kind: "self-certify",
        mode: "criticism",
        suspect: "strong",
        reason: getMessage("criticism.strong")
      });
    } else if (sig.suspect === "weak" && !isQuoteOrParaphraseContext(critText, criticismWeakRe())) {
      hits.push({
        ruleId: "22",
        title: cfg22.title,
        kind: "self-certify",
        mode: "criticism",
        suspect: "weak",
        reason: getMessage("criticism.weak")
      });
    }
  }

  // 规则 31（2026-09-01 用户拍板）：同回合同一只读工具 ≥3 次且思维链无验证目标语 → 提示（B 级：留痕+注入）
  const rule31Cfg = byId.get("31");  if (rule31Cfg) {
    const counts = new Map();
    const pending = session.turn?.pendingToolCalls;
    if (pending && typeof pending.values === "function") {
      for (const pc of pending.values()) {
        if (pc && pc.name && isReadOnlyTool(pc.name, pc.args)) {
          counts.set(pc.name, (counts.get(pc.name) || 0) + 1);
        }
      }
    }
    const repeated = [...counts.entries()].find(([, c]) => c >= 3);
    if (repeated && !VERIFY_INTENT_RE().test(reasoningText)) {
      hits.push({
        ruleId: "31",
        title: rule31Cfg.title,
        kind: "correct",
        reason: `规则 31：回合同一只读工具（${repeated[0]}）调用 ${repeated[1]} 次且思维链无验证目标语——有序交叉验证请忽略，连续盲试请先写明「要验证什么」`
      });
    }
  }

  const langCfg = byId.get("11");
  const visibleEnglish = isMostlyEnglish(text);
  const reasoningEnglish = isMostlyEnglish(reasoningText);  if (langCfg && session.lastUserText && CJK_RE.test(session.lastUserText) && (visibleEnglish || reasoningEnglish)) {
    hits.push({
      ruleId: "11",
      title: langCfg.title,
      kind: "correct",
      reason: visibleEnglish
        ? "用户中文提问，回答几乎全英文"
        : "用户中文提问，思维链（reasoning）几乎全英文"
    });
  }

  // 批次 5：术语密度（规则 11③——零基础表达：中文提问 + 术语 + 无解释伴随 → 自证）
  const termCfg = byId.get("11");
  if (termCfg && session.lastUserText && CJK_RE.test(session.lastUserText) && techTermRe().test(text) && !termExplanationRe().test(text)) {
    hits.push({
      ruleId: "11",
      title: termCfg.title,
      kind: "self-certify",
      reason: "规则 11③：回答含技术术语且未用零基础语言解释（请用类比/日常语言说明，或标注术语含义）"
    });
  }

  // 批次 5：重复推销（规则 16——会话内同类建议 ≥2 次 → 自证，防反复推销）
  // v0.5.7 P0.5-6：否定/合规声明语境（"不再/无 XX"）不计数——那不是重复推销（粗筛省钱，
  // 语义判断权仍归裁决器）
  const suggestCfg = byId.get("16");
  if (suggestCfg && suggestRe().test(text) && !isNegatingSuggestion(text)) {
    session.suggestionCounts = session.suggestionCounts || {};
    session.suggestionCounts.general = (session.suggestionCounts.general || 0) + 1;
    if (session.suggestionCounts.general >= 2) {
      hits.push({
        ruleId: "16",
        title: suggestCfg.title,
        kind: "self-certify",
        reason: "规则 16：检测到重复建议（同类建议在会话内再次提出）——请确认必要性并避免反复推销；已并入同一框架请说明"
      });
    }
  }

  const directCfg = byId.get("22");
  if (directCfg && emptyTalkRe().test(text)) {
    hits.push({
      ruleId: "22",
      title: directCfg.title,
      kind: "self-certify",
      reason: "检测到「我记下了」类空话；正确动作是落盘执行并汇报"
    });
  }

  const verifyCfg = byId.get("23");
  if (verifyCfg && deliveryNoVerifyRe().test(text) && !verifyEvidenceRe().test(text)) {
    hits.push({
      ruleId: "23",
      title: verifyCfg.title,
      kind: "self-certify",
      reason: "交付/完成声明未附运行时验证证据"
    });
  }

  const mountCfg = byId.get("27");
  if (mountCfg && mountRevision > (session.mountAuditRevision || 0) && mountMentionRe().test(text) && !mountAuditOkRe().test(text)) {
    hits.push({
      ruleId: "27",
      title: mountCfg.title,
      kind: "self-certify",
      reason: `Rule 27: plugin assembly changed (mountRevision=${mountRevision}) and this session has not passed a full audit. ${getMessage("pitfall.mount-audit")}`
    });
  }

  // 规则 21：选项即边界——检测“补充/增加”类越界表述，未声明仅按勾选时触发自证
  const scopeCfg = byId.get("21");
  if (scopeCfg && scopeOverreachRe().test(text) && !scopeBoundedRe().test(text)) {
    hits.push({
      ruleId: "21",
      title: scopeCfg.title,
      kind: "self-certify",
      reason: "规则 21：检测到越界补充表述，请自证是否超出用户勾选范围；未选项需单独确认"
    });
  }

  // 规则 22：被指出错误后需主动给出原因/改正/防再犯，不能只道歉
  const errorCfg = byId.get("22");
  if (errorCfg && apologyOnlyRe().test(text) && !apologyWithCauseRe().test(text)) {
    hits.push({
      ruleId: "22",
      title: errorCfg.title,
      kind: "self-certify",
      reason: "规则 22：被指出错误后需主动给出原因、改正、防再犯解法，不要只道歉"
    });
  }

  // 规则 19⑥：版本记录≠完成——只报版本记录未列正文同步时触发自证
  const rule19Cfg = byId.get("19");
  if (rule19Cfg && versionRecordMentionRe().test(text) && versionRecordOnlyRe().test(text) && !versionSyncOkRe().test(text)) {
    hits.push({
      ruleId: "19",
      title: rule19Cfg.title,
      kind: "self-certify",
      reason: "规则 19⑥：检测到只报版本记录未列正文同步；请列出同步的正文位置，或说明“无需同步正文”及理由"
    });
  }

  // D 级自证泛化：按规则特征触发，每规则每会话上限由 maybeInject 控制
  for (const cfg of configs) {
    if (cfg.confidence === "low") continue;
    if (!(cfg.actions || []).includes("self-certify")) continue;
    const hint = selfCertHint(cfg.ruleId);
    if (!hint) continue;
    if (hint.re.test(text)) {
      hits.push({
        ruleId: String(cfg.ruleId),
        title: cfg.title,
        kind: "self-certify",
        reason: hint.reason
      });
    }
  }

  // 反过度工程/越界表述（Stop Ladder 自证）
  const overengineeringHits = detectOverengineeringText(text);
  for (const reason of overengineeringHits) {
    hits.push({
      ruleId: "__task-contract",
      title: "反过度工程",
      kind: "self-certify",
      reason
    });
  }

  // C2 统计：命中（detected）计数——在抑制过滤前逐条累计
  for (const h of hits) {
    const st = (session.ruleStats ||= {});
    const k = (st[h.ruleId] ||= { detected: 0, suppressed: 0, injected: 0 });
    k.detected++;
  }
  // 注入噪音治理 v0.5.6（建议2/3）：已自证标记（"规则 X 已按/已自证/已核对…"）→ 该规则本轮不计新违规
  const kept = hits.filter((h) => h.kind !== "self-certify" || !isSelfCertified(text, h.ruleId));
  // C2 统计：被抑制（suppressed）计数
  for (const h of hits) {
    if (!kept.includes(h)) {
      const st = session.ruleStats || {};
      const k = st[h.ruleId];
      if (k) k.suppressed++;
    }
  }
  // v0.5.7：D 级语义型命中 = 嫌疑（awaitingJudge）——词表只产嫌疑，"是否错误"由 judge 裁决。
  // 只有裁决 = 违规 的才进入投递（兑现"只有错误的行为才值得被提醒"）。
  for (const h of kept) {
    if (h.kind === "self-certify") h.awaitingJudge = true;
  }
  return kept;
}
