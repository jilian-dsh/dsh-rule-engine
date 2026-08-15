// text-detect.js - 输出文本检测（B 级纠察 + 部分 D 级自证触发）。
// 官方架构下 assistant/message 无法拦下不发，因此这里做「必发现、必记账、可注入纠正」。
import {
  CJK_RE,
  PROMISE_WORDS,
  SOURCE_MARK,
  TIME_WORDS,
  URL_RE
} from "./patterns.js";

/** 从 assistant message 内容中提取纯文本 */
export function extractAssistantText(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

const SELF_CERT_HINTS = {
  "14": { re: /总结|汇报|完成/, reason: "请按规则 14 一次性完整汇报，区分事实与推断" },
  "22": { re: /我记下了|记住了|收到，我记下了|放心，我记住了/i, reason: "检测到「我记下了」类空话；正确动作是落盘执行并汇报" },
  "23": { re: /完成|交付/, reason: "交付/完成声明未附运行时验证证据" },
  "6": { re: /(?:API|JSON|正则|异步|依赖注入|回调|schema|DI)/i, reason: "请按规则 6 用零基础用户能懂的语言解释" },
  "16": { re: /建议|优化|更优方案/, reason: "请按规则 16 用五要素格式提建议，避免频繁打断" },
  "20": { re: /推理档位|off|high|max/, reason: "请按规则 20 给出档位建议并说明理由" },
  "12E": { re: /重启|GUI|登录|界面|窗口/, reason: "请按规则 12E 先确认界面真实存在并声明能力边界" }
};

/** 简单判断一段文本是否以英文为主 */
function isMostlyEnglish(text) {
  if (!text) return false;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const cjk = (text.match(CJK_RE) || []).length;
  return letters > 30 && cjk === 0;
}

/**
 * 检测一次 assistant/message 的 B/D 级违规。
 * @param {object} options
 * @param {Array} options.configs 理解配置
 * @param {object} options.session 会话状态（getSessionState 返回）
 * @param {string} options.text assistant 纯文本
 * @returns {Array<{ruleId:string,title:string,kind:string,reason:string}>}
 */
export function detectViolations({ configs, session, text, reasoningText = "" }) {
  const hits = [];
  const byId = new Map(configs.filter((c) => c.confidence !== "low").map((c) => [String(c.ruleId), c]));

  const timeCfg = byId.get("2");
  if (timeCfg && TIME_WORDS.test(text) && !session.turn.getDateSeen) {
    hits.push({
      ruleId: "2",
      title: timeCfg.title,
      kind: "correct",
      reason: "回答出现时间词/日期，但本回合未先调用 Get-Date 核对"
    });
  }

  const promiseCfg = byId.get("7");
  if (promiseCfg && PROMISE_WORDS.test(text)) {
    hits.push({
      ruleId: "7",
      title: promiseCfg.title,
      kind: "correct",
      reason: "检测到绝对化承诺词，请改为保守表述"
    });
  }

  const sourceCfg = byId.get("5");
  if (sourceCfg && URL_RE.test(text) && !SOURCE_MARK.test(text)) {
    hits.push({
      ruleId: "5",
      title: sourceCfg.title,
      kind: "correct",
      reason: "回答包含 URL 但未标注出处/来源"
    });
  }

  const langCfg = byId.get("11");
  const visibleEnglish = isMostlyEnglish(text);
  const reasoningEnglish = isMostlyEnglish(reasoningText);
  if (langCfg && session.lastUserText && CJK_RE.test(session.lastUserText) && (visibleEnglish || reasoningEnglish)) {
    hits.push({
      ruleId: "11",
      title: langCfg.title,
      kind: "correct",
      reason: visibleEnglish
        ? "用户中文提问，回答几乎全英文"
        : "用户中文提问，思维链（reasoning）几乎全英文"
    });
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

  return hits;
}
