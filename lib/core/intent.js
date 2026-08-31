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
// 0.5.11（用户拍板）：词表唯一源 = lib/core/lexicon.js——下面 5 张表全部从那里 import，
// 本文件不再自持定义（原定义删除）；对外 export 名保持不变（QUESTION_RE/STATUS_SIGNAL_RE
// 仍对外可见，/guard 与测试引用不受影响）。

import {
  QUESTION_WORDS_RE,
  ACTION_WORDS_RE,
  STRONG_EXEC_RE as STRONG_EXEC_LEX,
  STATUS_SIGNAL_WORDS_RE,
  DANGEROUS_ACTION_WORDS_RE
} from "./lexicon.js";
import { hasHotwordAction } from "./hotwords.js";

export const TAG_RE = /【(执行|方案|问询|信息)】/;

// 统一疑问词表（唯一源：lexicon.js；此处再导出保持外部引用兼容）
export const QUESTION_RE = QUESTION_WORDS_RE;

const DEFER_RE = /待确认|确认后再|等我确认|先方案|先别|不要执行|之后再说|确认后|再确认|先确认|不要直接/;
const ACTION_RE = ACTION_WORDS_RE;
const PLAN_RE = /方案|建议|评估|分析|设计|规划|计划|给出|提供/;
const STRONG_EXEC_RE = STRONG_EXEC_LEX;
const NUMBERED_ITEM_RE = /^\s*(?:\(?(\d+)[\)、.．)]\s*)/;
// A1（2026-08-28 阶段一）：具体动作词（区别于"执行/开始/进行"等宽泛词）。
// 用途：hasAction+hasPlan 时区分"给出执行方案"（方案请求）与"将建议书转化到业务通告"（执行指令）。
const SPECIFIC_ACTION_RE =
  /写入|写(?:下|好|完|成|作|文件)?|保存|另存为|删除|修改|改(?:为|成|动|一下|进|善)?|补(?:上|齐|全|充|写)?|修(?:改|复|一下)?|做(?:好|完|一下)?|创建|安装|发布|下载|提交|运行|修复|替换|重建|启动|重启|停止|卸载|改进|优化|增强|完善|升级|迁移|整理|调整|实现|实施|添加|增加|补充|重写|改造|调试|排查|处理|解决|更新|部署|核实|梳理|诊断|对齐|跟进|落实|设计并实现|调查|产出|编写|撰写|生成|审查|阅读|查看|核对|检查|审阅|复核|查阅|验证|对照|调研|研究|转化|转换|读取|读(?:完|出|一下|一遍|出来)?|展示|打开|提取|还原|导入|导出|采纳|选择|选定|落盘|落地|清理|移除|清空|合入|合并|并入|融合|整合|起草|开展|搭建|重构|兼容|投产|校验|核验|过一遍|跑一遍|复验/i;

// 2026-08-31（"方案+执行"误判修复，用户定稿/通用语义）：
// "按已有方案顺序依次执行/上述方案执行" —— 用户已指出既有方案并让执行（执行语+方案词）
// 区别于"给出执行方案/提供方案/设计方案"——产出请求（要方案，不是执行）。
// 判定：方案词+强执行语同句，且无产出请求词 → 执行分点（不再被 PLAN_RE 降档）。
const PLAN_EXECUTING_RE = /(?:方案|计划|步骤|清单|安排)[^\n]{0,16}?(?:执行|开始|继续|开工|去做|照做|落地)|(?:执行|开始|继续|做)[^\n]{0,12}(?:该|此|这个|上述|已有|给出(?:的)?|拟定(?:的)?)?方案/;
const PLAN_REQUEST_RE = /(?:给出|提供|出|设计|评估|分析|规划|计划|整理|拟定|撰写|编写|看看|讲解|说说|如何|怎么|哪里|要(?:一|个|份)|需?(?:要|求)(?:一|个|份)?)/;

// A3（2026-08-28，阶段一）：@文件引用信号——用户消息中 @ 引用路径/文件（DSH 官方
// file-reference 语法，@path 或 @"path with spaces"/@file.docx），且含处理动词 → 视为执行分点。
// 边界：@ 前必须是非词字符（开头/空白/标点），避免邮箱 a@b.com 误伤。
const AT_REF_RE = /(?:^|[\s（(【《"'，。；：！？])\s*@(?:["']?(?:[A-Za-z]:[\\/]|[^"'\\\s，。；：！？（）【】《》、]+\.(?:docx?|md|txt|pdf|json|ya?ml|xlsx?|csv|pptx?|html?|zip|mjs|js|ts|py|exe|ps1)))/i;
const AT_ACTION_RE = /看|读|改|写|转|查|处理|提取|打开|展示|审阅|检查|分析|整理|校对|核对|还原|更新|删除|移动|执行|处理/i;

/**
 * 状态信号：对先前指令的就绪/完成确认（“我已重启 / 已输入 / 重启完成 / 好了 / done”）。
 * 语义 = 与“无用户消息回合”同等待遇：不触发规则 22 的“无执行分点”判定（规则 22⑩）。
 * 唯一源：lexicon.js STATUS_SIGNAL_WORDS_RE；此处再导出保持外部引用兼容。
 */
export const STATUS_SIGNAL_RE = STATUS_SIGNAL_WORDS_RE;

// 危险动作词：命中则不当状态信号（防“我已删除了某文件”被当成就绪确认）
const DANGEROUS_ACTION_RE = DANGEROUS_ACTION_WORDS_RE;

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
// vision-router 自动挂载提醒（index.js:3494-3518）、引擎自身注入（[规则引擎]）。
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
  if (/^(?:请|帮我)?\s*(?:先|接着|然后)?\s*(?:完成|重启|执行|搞定|做完|弄好)\s+\S/.test(t.trim())) return false;
  return STATUS_SIGNAL_RE.test(t) && !DANGEROUS_ACTION_RE.test(t);
}

function normalizeTag(tag) {
  if (!tag) return null;
  const t = tag.trim();
  if (t === "执行") return "execute";
  if (t === "方案") return "plan";
  if (t === "问询") return "question";
  if (t === "信息") return "info";
  return null;
}

export function extractTag(text) {
  const m = String(text || "").match(TAG_RE);
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
  const hasTagLines = lines.filter((line) => TAG_RE.test(line)).length >= 2;

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
  const hasQuestion = QUESTION_RE.test(text);
  const hasDefer = DEFER_RE.test(text);
  // B1（2026-08-29）：词表命中 ∪ 热词命中（热词=LLM 兜底已确认过的动作词，见 hotwords.js）
  const hasAction = ACTION_RE.test(text) || hasHotwordAction(text);
  const hasPlan = PLAN_RE.test(text);
  const hasStrongExec = STRONG_EXEC_RE.test(text);
  // A3（阶段一）：@文件引用信号 + 处理动词 → 执行分点（用户用 @ 引用文件即"处理它"）
  const hasAtRef = AT_REF_RE.test(text) && AT_ACTION_RE.test(text);

  let type = "info";
  let ambiguous = false;

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
  } else if (hasDefer && hasAction) {
    type = "plan";
  } else if (hasAction && hasPlan && !SPECIFIC_ACTION_RE.test(text) && !(PLAN_EXECUTING_RE.test(text) && !PLAN_REQUEST_RE.test(text))) {
    // 只有宽泛动作词（执行/开始/进行…）+ 方案词 → 方案请求（"给出执行方案"≠执行指令）；
    // 例外（2026-08-31）："按已有方案执行/上述方案执行"——执行语+方案词且无产出请求词 → 执行分点
    type = "plan";
  } else if (hasAction) {
    // A1（2026-08-28 阶段一）：动作词优先于方案词——"将建议书内容转化到业务通告中"
    // 含"建议"（PLAN_RE）却被判 plan 导致无执行分点（真实事故根因）；有明确动作词即执行分点。
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