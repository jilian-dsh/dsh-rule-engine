// intent.js - 用户消息子句级意图解析（规则 22 分点语义的引擎侧实现）。
// 输入同一条用户消息，输出：
//   - 按数字列表/标签/单条消息切分出的子句
//   - 每个子句的意图类型：execute / plan / question / info / status / ambiguous
//   - 聚合标志：hasExecute / hasPlan / hasQuestion / hasStatus / ambiguous
//
// 设计原则：
//   - 数字列表是确定性切分结构；
//   - 标签是高置信语义标注；
//   - 无标签时用保守规则分类，宁可少授权、不多授权。
//   - “可以执行吗？”是询问，不是执行授权；
//   - “请给出执行方案”是方案请求，不是执行授权；
//   - “我已重启/已输入”等状态信号（规则 22⑩）是对先前指令的就绪确认：
//     不构成执行授权、也不触发“无执行分点”拦截；变更类操作仍由 12A/13A 把关。
//
// 2026-08-24（v0.5.5 规划，事故复盘 P1-5/P0-3/规则 22⑩）：
//   - 词表单一来源：QUESTION_RE 同时供 authorization.isQuestionMessage 使用，
//     消灭“两套疑问词判定不一致”（如 authorization 的“影响吗”与 intent 的“怎么”）。
//   - 新增 STATUS_SIGNAL_RE / isStatusSignal()：状态信号分类（宽松版，危险词排除，
//     12A/13A 兜底），与“无用户消息回合”同等待遇。
// 0.5.11（用户拍板）：词表唯一源 = lib/core/lexicon.js——下面 5 张表全部从那里取，
// 本文件不再自持定义。
// P8 小批 A（2026-09-08）：改为函数取词（questionWordsRe() 等）——配置层注入后立即生效；
// 旧导出名 QUESTION_RE / STATUS_SIGNAL_RE 已删除（正则常量会锁死内置值，是本次改造的根因）。
// 对外仍以函数形态提供：questionWordsRe / statusSignalRe（lexicon.js）。

import {
  questionWordsRe,
  actionWordsRe,
  strongExecRe,
  statusSignalRe,
  dangerousActionRe
} from "./lexicon.js";
import { hasHotwordAction } from "./hotwords.js";
import { patMap, onPatternsReset } from "./patterns.js";

// ── 分点级意图判定词（第三批，2026-09-21）：九条正则迁 patterns.intent_checks ──
// 取词一律经 patMap("intent_checks")（本文件禁止写死这九条）。
// flags 口径留代码：specific_action 与 at_action 用 "i"，其余为空——与迁移前逐条一致。
const INTENT_CHECK_FLAGS = { specific_action: "i", at_action: "i" };
const intentReCache = new Map();

// 缓存活性：setPatterns／resetPatterns 生效后由 patterns.js 回调清空本缓存
// （不注册则注入的配置会被"按旧配置编译"的缓存挡在门外）。
onPatternsReset(() => intentReCache.clear());

/** 取生效正则（缺词/非法 → null，调用方按"不命中"处理，不抛） */
function intentRe(key) {
  if (intentReCache.has(key)) return intentReCache.get(key);
  const src = patMap("intent_checks")[key];
  let re = null;
  if (typeof src === "string" && src.length > 0) {
    try {
      re = new RegExp(src, INTENT_CHECK_FLAGS[key] || "");
    } catch {
      re = null;
    }
  }
  intentReCache.set(key, re);
  return re;
}

export const TAG_RE = () => intentRe("tag");

/** 标签 → 语义类型别名（中文标签由配置层源注入；英文别名供语言无关默认使用） */
const TAG_TYPE_ALIASES = {
  "执行": "execute",
  execute: "execute",
  "方案": "plan",
  plan: "plan",
  "问询": "question",
  question: "question",
  "信息": "info",
  info: "info"
};

// 九条分点级判定词已迁 patterns.intent_checks（2026-09-21 第三批；见文件头的 intentRe）。
// 仍留本文件的形态正则：NUMBERED_ITEM_RE（编号标点形态，不是词表）与 AT_REF_RE
//（@ 引用语法＋扩展名清单，语言无关形态；用户裁定不迁）。
const NUMBERED_ITEM_RE = /^\s*(?:\(?(\d+)[\)、.．)]\s*)/;

// A3（2026-08-28，阶段一）：@文件引用信号——用户消息中 @ 引用路径/文件（DSH 官方
// file-reference 语法，@path 或 @"path with spaces"/@file.docx），且含处理动词 → 视为执行分点。
// 边界：@ 前必须是非词字符（开头/空白/标点），避免邮箱 a@b.com 误伤。
const AT_REF_RE = /(?:^|[\s（(【《"'，。；：！？])\s*@(?:["']?(?:[A-Za-z]:[\\/]|[^"'\\\s，。；：！？（）【】《》、]+\.(?:docx?|md|txt|pdf|json|ya?ml|xlsx?|csv|pptx?|html?|zip|mjs|js|ts|py|exe|ps1)))/i;
// AT_ACTION_RE（@ 引用后的处理动词）已迁 patterns.intent_checks.at_action（"i" 口径）。

/**
 * 状态信号：对先前指令的就绪/完成确认（“我已重启 / 已输入 / 重启完成 / 好了 / done”）。
 * 语义 = 与“无用户消息回合”同等待遇：不触发规则 22 的“无执行分点”判定（规则 22⑩）。
 * 唯一源：lexicon.js（P8 小批 A 起经 statusSignalRe() 取词，配置注入后生效）。
 */

/** DSH 在会话上下文里注入的系统文本（工作区指令/技能目录等），不是用户的真实消息 */
export function isInjectedContextMessage(text) {
  const t = String(text || "");
  return t.includes("<system-reminder>") || t.includes("</system-reminder>");
}

/**
 * 规则引擎自身注入的纠正/提示消息（maybeInject 发出，前缀 [规则引擎]），不是用户消息。
 * 2026-08-24 修复：此前这类文本含“请直接执行/继续执行”，会被 handleSessionEvent 当成用户执行分点
 * 并 recordAuthorization → 引擎自我续授权，导致 /guard revoke 后仍会被自己加回全局授权。
 */
export function isEngineInjectedMessage(text) {
  const t = String(text || "").trim();
  return t.startsWith("[规则引擎]");
}

// 已知系统注入模板（机制 A 兜底层，2026-08-24）：
// source.kind 主判之外，对"标记为 user 但实为注入"的消息做模板兜底——
// 命中即整体跳过：不覆盖回合状态、不产生 scopes/授权。
// 本机实证来源：runtime context 快照（无 system-reminder 标签）、子代理完成通知（B3）、
// vision-router 自动挂载提醒（该包 client 侧注入）、引擎自身注入（[规则引擎]）。
// example-injector 的近距离引导模板待实测后收窄补充。
const SYSTEM_INJECTION_PREFIXES = [
  /^Current runtime context\./,
  /^Background subagent\b/,
  /^\[规则引擎\]/,
  /^本轮消息包含图片，像素级视觉工具已自动挂载/
];

/** 整条文本是否为"已知系统注入"（不是用户想说的事） */
export function isKnownSystemInjection(text) {
  const t = String(text || "").trim();
  return SYSTEM_INJECTION_PREFIXES.some((re) => re.test(t));
}

/**
 * 剥离 system-reminder 注入块，返回剩余用户文本。
 * 2026-08-24 v2：注入可能与真实用户消息合并为同一事件（本会话实测模式：
 * <system-reminder> 块 + 用户文本同在一个 content 数组，整条跳过会把真实消息也丢弃）。
 * 无注入 → 原样返回；纯注入 → 空串（调用方按"跳过"处理）。
 */
export function stripInjectedContext(text) {
  const t = String(text || "");
  if (!t.includes("<system-reminder>")) return t;
  return t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

/** 状态信号判定（规则 22⑩）：对先前指令的就绪确认，且不含危险动作词 */
export function isStatusSignal(text) {
  const t = String(text || "");
  // 命令式排除（2026-08-25 RB-05）：行首裸“完成/重启/执行/搞定等 + 空格 + 宾语”= 命令
  //（“完成 A 和 C 两项”/“重启服务”），不是对先前指令的就绪确认；状态信号须带“已/我已完成”前缀
  // 或“了/完成/完毕/好”后缀（根因：STATUS_SIGNAL_RE 的“裸词 + 可选后缀”分支把命令式误判为状态）。
  if (intentRe("status_exclude")?.test(t.trim())) return false;
  return statusSignalRe().test(t) && !dangerousActionRe().test(t);
}

function normalizeTag(tag) {
  if (!tag) return null;
  return TAG_TYPE_ALIASES[tag.trim()] || null;
}

export function extractTag(text) {
  const m = String(text || "").match(TAG_RE());
  return m ? m[1] : "";
}

function splitClauses(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];

  // 同行内多个编号（"1、A 2、B"）：在编号前插入换行，统一按行切分。
  // 修复 2026-08-24 实测缺陷：同行编号列表被并入单子句，"方案"等词导致整条误判 plan。
  // 修复 2026-08-28（用户"1、问 2、问 3、跑"被整条吞）：编号前为**空白或标点**（？。；、等）也切——
  // 用户在中文标点后直接发编号（无空格），"？2、"应切为列表项"2、"；保守保留"执行第2、3条"不切
  //（"第"是汉字非标点，编号前非空白非标点 → 整体词不切）。
  const normalized = raw.replace(/(?:[\s。；，、？?！!])(\d+[\)、.．)])/g, "\n$1");
  const lines = normalized.split(/\r?\n/);
  const hasNumbered = lines.some((line) => NUMBERED_ITEM_RE.test(line));
  const hasTagLines = lines.filter((line) => TAG_RE()?.test(line)).length >= 2;

  if (!hasNumbered) {
    if (hasTagLines) {
      return lines
        .map((line, i) => ({ id: String(i + 1), raw: line.trim() }))
        .filter((c) => c.raw);
    }
    // 标题 + 正文 拆分：非标准【标签】的「【标题】正文」结构拆为两个子句，
    // 使标题含动作词（如"改进/优化"）即构成执行分点，正文的疑问/描述不再掩盖标题意图（规则 22 混合指令）
    const tm = raw.match(/^【([^】]{2,})】\s*([\s\S]+)$/);
    if (tm && !normalizeTag(tm[1])) {
      return [
        { id: "t", raw: tm[1].trim() },
        { id: "b", raw: tm[2].trim() }
      ];
    }
    return [{ id: "1", raw }];
  }

  const clauses = [];
  let current = null;

  const pushCurrent = () => {
    if (current && current.raw.trim()) clauses.push(current);
    current = null;
  };

  for (const line of lines) {
    const m = line.match(NUMBERED_ITEM_RE);
    if (m) {
      pushCurrent();
      current = {
        id: m[1],
        raw: line.replace(NUMBERED_ITEM_RE, "").trim()
      };
    } else if (!current) {
      // 编号前的引言/说明，单独作为一个前置子句
      current = { id: "0", raw: line.trim() };
    } else {
      current.raw += (current.raw ? "\n" : "") + line.trim();
    }
  }
  pushCurrent();

  // 只有单个编号时也返回单子句，避免把“1. 执行吧”切成无意义列表
  if (clauses.length <= 1 && clauses[0]?.id === "1") {
    return [{ id: "1", raw: raw }];
  }
  return clauses;
}

function classifyClause(clause) {
  const text = String(clause.raw || "").trim();
  const tag = extractTag(text);
  const tagType = normalizeTag(tag);
  const hasQuestion = questionWordsRe().test(text);
  const hasDefer = !!intentRe("defer")?.test(text);
  // B1（2026-08-29）：词表命中 ∪ 热词命中（热词=LLM 兜底已确认过的动作词，见 hotwords.js）
  const hasAction = actionWordsRe().test(text) || hasHotwordAction(text);
  const hasPlan = !!intentRe("plan")?.test(text);
  const hasStrongExec = strongExecRe().test(text);
  // A3（阶段一）：@文件引用信号 + 处理动词 → 执行分点（用户用 @ 引用文件即"处理它"）
  const hasAtRef = !!AT_REF_RE.test(text) && !!intentRe("at_action")?.test(text);

  let type = "info";
  let ambiguous = false;

  // 2026-08-31（柱子 C）：条件句优先判定——"推送完成后/等 X 后"=依赖型分点，不产生独立授权
  //（必须在动作词判定之前：否则"完成后"被当执行分点，其 scope 污染授权池——分点失效根因）
  if (tagType) {
    if (tagType === "execute" && hasQuestion) {
      type = "ambiguous";
      ambiguous = true;
    } else {
      type = tagType;
    }
  } else if (hasQuestion) {
    type = "question";
  } else if (isStatusSignal(text)) {
    type = "status";
  } else if (intentRe("conditional")?.test(text)) {
    // 2026-08-31（柱子 C）：条件句——"推送完成后/等 X 后"=依赖型分点，不产生独立授权/scope
    //（若按动作词判 execute，其"推送"字眼将污染 git 授权池——分点失效根因；宁拦不放）
    type = "conditional";
  } else if (hasDefer && hasAction) {
    type = "plan";
  } else if (hasAction && hasPlan && !intentRe("specific_action")?.test(text) && !(intentRe("plan_executing")?.test(text) && !intentRe("plan_request")?.test(text))) {
    // 只有宽泛动作词（执行/开始/进行…）+ 方案词 → 方案请求（"给出执行方案"≠执行指令）；
    // 例外（2026-08-31）："按已有方案执行/上述方案执行"——执行语+方案词且无产出请求词 → 执行分点
    type = "plan";
  } else if (hasAction) {
    // A1（2026-08-28 阶段一）：动作词优先于方案词——"将建议书内容转化到业务通告中"
    // 含"建议"（intent_checks.plan）却被判 plan 导致无执行分点（真实事故根因）；有明确动作词即执行分点。
    type = "execute";
  } else if (hasPlan && !hasStrongExec) {
    type = "plan";
  } else if (hasAtRef) {
    // 词表未命中但含 @文件引用 + 处理动词：判执行分点（词表盲区治本方向之一）
    type = "execute";
  } else if (hasPlan) {
    type = "plan";
  }

  return {
    id: clause.id,
    raw: text,
    type,
    tag: tag || null,
    hasAction,
    hasQuestion,
    deferred: hasDefer,
    ambiguous
  };
}

/**
 * 解析用户消息中的子句级意图。
 * @param {string} text 用户消息纯文本
 * @returns {object} turn.intents 兼容结构
 */
export function parseUserIntents(text) {
  const clauses = splitClauses(text);
  const parsed = clauses.map(classifyClause);

  const hasExecute = parsed.some((c) => c.type === "execute");
  const hasPlan = parsed.some((c) => c.type === "plan");
  const hasQuestion = parsed.some((c) => c.type === "question");
  const hasStatus = parsed.some((c) => c.type === "status");
  const ambiguous = parsed.some((c) => c.ambiguous || c.type === "ambiguous");
  const hasTag = parsed.some((c) => c.tag);
  const numberedCount = (String(text || "").match(/(?:^|\n)\s*\(?\d+[\)、.．)]/g) || []).length;

  let source = "single";
  if (numberedCount >= 2 && hasTag) source = "mixed";
  else if (numberedCount >= 2) source = "numbered-list";
  else if (hasTag) source = "labels";

  let confidence = "high";
  if (ambiguous) confidence = "low";
  else if (source === "single" && !hasTag) confidence = "medium";

  return {
    raw: String(text || ""),
    source,
    clauses: parsed,
    hasExecute,
    hasPlan,
    hasQuestion,
    hasStatus,
    ambiguous,
    confidence
  };
}

/** 兼容旧判断：是否应禁止变更（无执行授权且存在问询语义） */
export function shouldDenyMutation(intents, askSeen = false) {
  if (askSeen) return false;
  if (!intents) return true;
  if (intents.hasStatus) return false; // 状态信号消息不触发规则 22 拦截（规则 22⑩，2026-08-24）
  if (intents.ambiguous) return true;
  return !intents.hasExecute;
}