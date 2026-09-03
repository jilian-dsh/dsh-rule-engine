// text-detect.js - 输出文本检测（B 级纠察 + 部分 D 级自证触发）。
// 官方架构下 assistant/message 无法拦下不发，因此这里做「必发现、必记账、可注入纠正」。
import {
  CJK_RE,
  PROMISE_WORDS,
  SOURCE_MARK,
  TIME_WORDS,
  HISTORIC_DATE_RE,
  EVIDENCE_MARK_RE,
  URL_RE,
  TECH_TERM_RE,
  TERM_EXPLANATION_RE,
  SUGGEST_RE,
  isNegatingSuggestion,
  isQuoteOrParaphraseContext,
  isReadOnlyTool
} from "./patterns.js";
import { detectOverengineeringText } from "./overengineering.js";

// F2（2026-08-28 阶段三）：交付声明强模式（规则 23④ verify-gap 词面）——
// 裸"完成"太宽（"完成社区检索/尚未完成/正在完成"误触）→ 强完成声明 + 否定/进行态排除。
// 模块级导出（纯函数模块，可测试锁定）；LLM 裁决层（deliverSuspects）兜底不变。
// 用户批评形态（规则 22② 机器提示，2026-09-02；2026-09-02 实弹修正分层）：
//   CRITICISM_RE（STRONG）= 辱骂词/连续问叹符 → 确定性批评，直接 B 级提醒（零成本零延迟）；
//   CRITICISM_WEAK_RE（WEAK） = 反问/责问形态 → 只产嫌疑（awaitingJudge），交 judge 裁决，
//     确认批评才提醒、拿不准不打扰——词表只产嫌疑、判定权归模型（兑现 v4.107/v4.113 拍板）。
// 检测对象=用户消息（session.lastUserText），命中=审计+注入"批评≠授权"提醒（B 级，不拦截）
export const CRITICISM_RE =
  /(?:草泥马|你妈的|你妈|傻[逼B Xx]|煞笔|智障|神经病|你聋了|你瞎了|你疯了|你傻了|蠢货|废物|滚蛋|[？?]{3,}|[！!]{4,})/;

// WEAK 嫌疑集：反问/责问/否定比较形态（"怎么还在做/又错了/这不对吧/你是不是又…"）。
// 允许偏宽（普通技术疑问如"怎么用"也会进入嫌疑）——判定权在 judge：模型确认才是提醒，拿不准=不打扰。
export const CRITICISM_WEAK_RE =
  /(?:怎么(?:又|还|居然|仍然|老是|总)?[^，。！？]{0,14}(?:了|呢|啊|？|!|！)?|你(?:又|还|居然|咋|怎么)[^，。！？]{0,12}(?:了|呢|啊|吧)?|(?:又|还|总是|老是|仍然|居然)[^，。！？]{0,12}(?:了|呢|啊|吧)?|这(?:不|有点|根本|完全|哪)?(?:对|行|合理|应该|像话)(?:吧|么|吗|啊|呢)?|你(?:是不是|难道|难道说|该不会)[^，。！？]{0,10}(?:了|呢|吧)?|(?:搞什么|干什么|什么情况|怎么回事|搞砸|搞错了|犯什么错))/;

export const DELIVERY_RE = /(?:已完成|全部(?:[^\s，。；！？]{0,12})完成|已[^\s，。；！？]{0,8}完成|修复完成|落盘完成|验证[^\s，。；！？]{0,6}(?:通过|成功)|全部通过|全部[^\s，。；！？]{0,10}通过|已通过|已修复|搞定)(?:\s*了|!|！|，[^。]*)?(?![^。]*(?:尚未|没有|未|没|还没|未完|待做|待完成))/;

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

const SELF_CERT_HINTS = {
  "14": { re: /总结|汇报|完成/, reason: "请按规则 14 一次性完整汇报，区分事实与推断" },
  // "22" 词表（text-detect）：检测**我的回复文本**里的空话（B/D 级语义嫌疑），判定对象 = assistant 输出；
  // 与 lexicon.js 的 ACTION/QUESTION/STATUS 等词表**不同层**（lexicon 判**用户消息**意图、服务规则 22 时序判定）。
  // 二者用途不同、无重复：本表 = 输出侧"我说了空话"；lexicon = 输入侧"用户说了什么"。改动需两处各自成对。
  "22": { re: /我记下了|记住了|收到，我记下了|放心，我记住了/i, reason: "检测到「我记下了」类空话；正确动作是落盘执行并汇报" },
  "23": { re: /完成|交付/, reason: "交付/完成声明未附运行时验证证据" },
  "16": { re: /建议|优化|更优方案|推理档位|档位/, reason: "请按规则 16 用绑定检查格式提建议（或给档位建议并说明理由），避免频繁打断" },
  "12E": { re: /重启|GUI|登录|界面|窗口/, reason: "请按规则 12E 先确认界面真实存在并声明能力边界" },
  "26": { re: /(?=发布|Release|附件)(?!(?:Attach binaries|正式 Asset|release\.assets))/i, reason: "请按规则 26 确认正式 Release Asset（release.assets）并附 tgz/zip" },
  "10": { re: /新会话|旧会话|旧项目|上下文恢复/, reason: "请按规则 10 自证：如实说明默认不自动继承，按优先级恢复并标注来源" },
  "12C": { re: /下载|网络|curl|Clash|被墙/, reason: "请按规则 12C 自证：需代理先告知、失败即停、下载后校验、排查先测连通性" },
  "13B": { re: /会话文件|会话修复|fromRestore|Inbox 回放|孤儿扫描/, reason: "请按规则 13B 自证：会话替换前用户完全退出、三层验证一次跑完、mtime 判断" },
  "15": { re: /文件版本|文件用途|新旧|版本.*处置|保留文件/, reason: "请按规则 15 自证：不凭 mtime/文件名判断新旧，无法确定版本/用途时保留并询问" },
  "19": { re: /学到新.*DSH|踩到新坑|踩坑.*沉淀|手册有误|知识必沉淀/, reason: "请按规则 19 自证：按①-⑧沉淀并当次汇报正文同步位置" },
  "28": { re: /新建.*文件|放入.*目录|工作区.*归类/, reason: "请按规则 28 自证：新文件按工作区目录索引归类，不确定则查 README 或放 _inbox" },
  "29": { re: /依赖闭包|node_modules.*验证|动过.*node_modules/, reason: "请按规则 29 自证：重启前验证依赖闭包（关键包非空/顶层 junction 完整/无 dangling）" },
  "30": { re: /变更验证|验证证据|不破坏.*依赖/, reason: "请按规则 30 自证：执行前证明不破坏依赖+已授权，完成后附验证证据" },
  // 规则 31（2026-09-01 用户拍板）：提到"撞墙/盲试"类表述 → D 级自证：写明验证目标→撞了什么/为什么撞→结论来源
  "31": { re: /撞(?:了)?南墙|撞墙|盲试|乱撞|连续盲试/, reason: "规则 31 自证：请写明「验证目标→撞了什么/为什么撞→结论来源（手册位置/源码行号）」；不连续盲试" }
};

// 规则 31（2026-09-01 用户拍板）：内部文档引用锚点词（"文档"仅在后随"写了/记载…"语境命中，防泛化误报）
const INTERNAL_REF_RE = /(?:手册|踩坑\s*\d+|条款\s*\d+|第\s*\d+\s*章|SKILL\.md|AGENTS\.md|源码|README|文档[^\n]{0,12}(?:写了|记载|记录|写明|说明))/i;
// 验证目标启发式：思维链含这些词 → 大概率是有序查证（防规则 31③误报）
const VERIFY_INTENT_RE = /(?:验证|查证|核对|目标|交叉|对照|确认)/;

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
  const tail = "(?:已按|已按要求|已自证|已核对|已核实|核实通过|合规|已满足|已一次性说明|已合并提出|已回应|已实施|已落地)";
  const suffix = "(?:[①②③④⑤⑥⑦⑧⑨⑩]|\\.\\d+|\\d+)?";
  const re = new RegExp(`(?:规则\\s*${id}${suffix}\\s*${tail}|${tail}\\s*规则\\s*${id}${suffix})`);
  return re.test(text);
}

/**
 * 规则 2 时间核对的独立判定（F1，2026-08-28 阶段三）：
 * 原实现嵌在 detectViolations（assistant/message 时调）——但 Get-Date 工具常在本回合后续步骤
 * 才执行（事故实弹：correct 04:52:23.061 早于 Get-Date 放行 .068）→ 真调了也判"未先核对"。
 * 修复：判定时机延迟到 turn/end（getDateSeen 已定案），本判定函数只做判定、不依赖调用时机。
 * @param {object} session 会话状态（turn.getDateSeen 已由 tool/call 置位）
 * @param {string} text assistant 纯文本
 * @param {object} timeCfg 规则 2 配置（byId.get("2")）
 * @returns {Array<{ruleId,title,kind,reason}>}
 */
export function detectTimeRule(session, text, timeCfg) {
  const hasNow = TIME_WORDS.test(text);
  const hasHist = HISTORIC_DATE_RE.test(text);
  if (!timeCfg || (!hasNow && !hasHist)) return [];
  if (isQuoteOrParaphraseContext(text, TIME_WORDS) || isQuoteOrParaphraseContext(text, HISTORIC_DATE_RE)) return [];
  // A1（2026-09-03 拆组）：当下时间词才要求 Get-Date 核对（①）；历史日期只走证据锚（②），
  // 不再要求 Get-Date——消除"引用历史日期必判未核对"的误报（规则 2②：每时间点绑定自己证据）。
  if (hasNow && !session?.turn?.getDateSeen) {
    return [{
      ruleId: "2",
      title: timeCfg.title,
      kind: "correct",
      reason: "回答出现具体时间词/日期，但本回合未先调用 Get-Date 核对"
    }];
  }
  if ((hasNow || hasHist) && !EVIDENCE_MARK_RE.test(text)) {
    return [{
      ruleId: "2",
      title: timeCfg.title,
      kind: "correct",
      reason: "回答含具体时间词/日期但未附事件证据标注（日志 ts/文件 mtime/进程启动时间/commit 锚/版本行/踩坑 N 等）——Get-Date 当前时间不算过去事件证据（规则 2②）。正确动作：查该事件证据补（来源：…）或删时间词/标【时间未核实】，勿以当前时间替代"
    }];
  }
  return [];
}

/**
 * 检测一次 assistant/message 的 B/D 级违规。
 * 规则 2 时间核对不在本函数内（F1，2026-08-28）：原实现在此判定，但 Get-Date 工具常在本回合
 * 后续步骤才执行（事故实弹：correct 早于 Get-Date 放行）→ 真调了也判"未先核对"。
 * 现由 index.js 在 turn/end 时机调用 detectTimeRule（getDateSeen 定案后）。
 * @param {object} options
 * @param {Array} options.configs 理解配置
 * @param {object} options.session 会话状态（getSessionState 返回）
 * @param {string} options.text assistant 纯文本
 * @returns {Array<{ruleId:string,title:string,kind:string,reason:string}>}
 */
export function detectViolations({ configs, session, text, reasoningText = "", mountRevision = 0, rule5Window = 3 }) {
  const hits = [];
  const byId = new Map(configs.filter((c) => c.confidence !== "low").map((c) => [String(c.ruleId), c]));

  const timeCfg = byId.get("2");
  // v0.5.11（用户定稿）：① 只命中具体时间词（TIME_WORDS 为具体词表——"之前/当时"等模糊词不命中，不新增）；
  // ② 具体时间词 + 无事件证据标注（日志 ts/文件 mtime/进程启动时间等）→ 违规，Get-Date 当前时间不算事件证据。
  // A1（2026-09-03）：时间词拆组——当下词（TIME_WORDS）才要求 Get-Date①；历史日期（HISTORIC_DATE_RE）只查证据锚②。
  // F1（2026-08-28 阶段三）：本检测仅作"判定"，投递时机由调用方在 turn/end 复核（见 detectTimeRule 注释）。
  // B3（2026-08-29）：引述/转述语境的时间词不触发（"你昨天说…"是转述，不是我的时间表述）；
  // 第一人称"我说昨天…"仍触发（转述不了自己）。
  if (timeCfg && (TIME_WORDS.test(text) || HISTORIC_DATE_RE.test(text)) && !isQuoteOrParaphraseContext(text, TIME_WORDS) && !isQuoteOrParaphraseContext(text, HISTORIC_DATE_RE)) {
    if (!session.turn.getDateSeen && TIME_WORDS.test(text)) {
      hits.push({
        ruleId: "2",
        title: timeCfg.title,
        kind: "correct",
        reason: "回答出现具体时间词/日期，但本回合未先调用 Get-Date 核对"
      });
    } else if (!EVIDENCE_MARK_RE.test(text)) {
      hits.push({
        ruleId: "2",
        title: timeCfg.title,
        kind: "correct",
        reason: "回答含具体时间词/日期但未附事件证据标注（日志 ts/文件 mtime/进程启动时间/commit 锚/版本行/踩坑 N 等）——Get-Date 当前时间不算过去事件证据（规则 2②）"
      });
    }
  }

  const promiseCfg = byId.get("7");
  // v0.5.7 P0.5-5：承诺词处于引述/改写语境（"把'保证'改成…"）→ 引述不是承诺，不触发
  if (promiseCfg && PROMISE_WORDS.test(text) && !isQuoteOrParaphraseContext(text, PROMISE_WORDS)) {
    hits.push({
      ruleId: "7",
      title: promiseCfg.title,
      kind: "correct",
      reason: "检测到绝对化承诺词，请改为保守表述"
    });
  }

  const sourceCfg = byId.get("5");
  if (sourceCfg && !SOURCE_MARK.test(text)) {
    if (URL_RE.test(text)) {
      hits.push({
        ruleId: "5",
        title: sourceCfg.title,
        kind: "correct",
        reason: "回答包含 URL 但未标注出处/来源"
      });
    } else if (INTERNAL_REF_RE.test(text) && !isQuoteOrParaphraseContext(text, INTERNAL_REF_RE)) {
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

  // 规则 22② 机器提示（2026-09-02；实弹修正：STRONG 直接提醒 / WEAK 只产嫌疑交 judge 裁决）
  const cfg22 = byId.get("22");
  if (cfg22 && session.lastUserText) {
    const critText = session.lastUserText;
    if (CRITICISM_RE.test(critText) && !isQuoteOrParaphraseContext(critText, CRITICISM_RE)) {
      hits.push({
        ruleId: "22",
        title: cfg22.title,
        kind: "correct",
        reason: "用户消息含确定性批评形态（规则 22②/手册 5b-2）：用户批评不构成任何授权——被批评后应停、按归因四问产出三件套、等指令；禁止因批评启动任何变更"
      });
    } else if (CRITICISM_WEAK_RE.test(critText) && !isQuoteOrParaphraseContext(critText, CRITICISM_WEAK_RE)) {
      hits.push({
        ruleId: "22",
        title: cfg22.title,
        kind: "self-certify",
        mode: "criticism",
        reason: "用户消息疑似批评/质问形态（规则 22②/手册 5b-2，待裁决）：若确属批评——不构成任何授权，被批评后应停、按归因四问产出三件套、等指令；禁止因批评启动任何变更"
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
    if (repeated && !VERIFY_INTENT_RE.test(reasoningText)) {
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
  if (termCfg && session.lastUserText && CJK_RE.test(session.lastUserText) && TECH_TERM_RE.test(text) && !TERM_EXPLANATION_RE.test(text)) {
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
  if (suggestCfg && SUGGEST_RE.test(text) && !isNegatingSuggestion(text)) {
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
  if (directCfg && /我记下了|记住了|收到，我记下了|放心，我记住了/i.test(text)) {
    hits.push({
      ruleId: "22",
      title: directCfg.title,
      kind: "self-certify",
      reason: "检测到「我记下了」类空话；正确动作是落盘执行并汇报"
    });
  }

  const verifyCfg = byId.get("23");
  if (verifyCfg && /完成|交付/.test(text) && !/运行时验证|mock|启动|实测|测试|验证/.test(text)) {
    hits.push({
      ruleId: "23",
      title: verifyCfg.title,
      kind: "self-certify",
      reason: "交付/完成声明未附运行时验证证据"
    });
  }

  const mountCfg = byId.get("27");
  if (mountCfg && mountRevision > (session.mountAuditRevision || 0) && /重启|装配|挂载/.test(text) && !/审计通过|全量审计|MOUNT CONSISTENT|DUPLICATES FOUND|audit-mount-consistency/.test(text)) {
    hits.push({
      ruleId: "27",
      title: mountCfg.title,
      kind: "self-certify",
      reason: `规则 27：插件装配已变更（mountRevision=${mountRevision}）且本会话未通过全量审计，重启/继续前请先运行 audit-mount-consistency.mjs`
    });
  }

  // 规则 21：选项即边界——检测“补充/增加”类越界表述，未声明仅按勾选时触发自证
  const scopeCfg = byId.get("21");
  if (scopeCfg && /(?:我补充|顺便补充|额外补充|我增加|顺便加|额外加|多加|自行纳入)/.test(text) && !/仅按勾选|只实现被选项|未选项|单独确认|再次征求/.test(text)) {
    hits.push({
      ruleId: "21",
      title: scopeCfg.title,
      kind: "self-certify",
      reason: "规则 21：检测到越界补充表述，请自证是否超出用户勾选范围；未选项需单独确认"
    });
  }

  // 规则 22：被指出错误后需主动给出原因/改正/防再犯，不能只道歉
  const errorCfg = byId.get("22");
  if (errorCfg && /(?:抱歉|对不起|我错了|这是我的错|失误)/.test(text) && !/(?:原因|改正|防再犯|避免|机制|解法|修正)/.test(text)) {
    hits.push({
      ruleId: "22",
      title: errorCfg.title,
      kind: "self-certify",
      reason: "规则 22：被指出错误后需主动给出原因、改正、防再犯解法，不要只道歉"
    });
  }

  // 规则 19⑥：版本记录≠完成——只报版本记录未列正文同步时触发自证
  const rule19Cfg = byId.get("19");
  if (rule19Cfg && /版本记录|v\d+\.\d+/.test(text) && /已记入版本记录|版本记录已|只加了版本记录|只加版本记录/.test(text) && !/正文|同步|无需同步|无需改正文/.test(text)) {
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
    const hint = SELF_CERT_HINTS[String(cfg.ruleId)];
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
