// llm-intent.js - LLM 用户消息意图兜底（方案 A，v0.5.5 规划，2026-08-24）。
// 原则：
//   - 词表是主裁决器（快/免费/可测试/可复现）；LLM 只补低置信/歧义/未命中边缘；
//   - 非对称：LLM 只在词表判“拦”时参与解救（hasExecute → 放行）；词表判“放行”时永不收紧（防软化）；
//   - 失败/未就绪/超时/限额一律保守：维持词表裁决（拦截方向不变）；
//   - 全程审计：谁判的（词表/LLM）、置信、延迟。
// 纯依赖注入 ctx.llm；复用 llm-understander.js 的 resolveRoute/callLlm/parseJsonOutput。
import { createHash } from "node:crypto";
import { parseUserIntents, shouldDenyMutation } from "./intent.js";
import { resolveRoute, callLlm } from "./llm-understander.js";
import { audit } from "./audit.js";
import { learnHotword } from "./hotwords.js";
import { actionWordsRe } from "./lexicon.js";

const LLM_PROMPT = [
  "你是 DSH 规则引擎的意图判定器。输出严格 JSON，不要输出其他内容：",
  '{"hasExecute":bool,"hasPlan":bool,"hasQuestion":bool,"ambiguous":bool,"reason":"一句话","confidence":0-1,"actionWord":"句中明确动作词(2-6字，如：通读、校对、梳理；无明确动作词则空串)"}',
  "规则：hasExecute=消息含明确执行指令（动作词+非疑问句）；hasQuestion=含疑问/征询；hasPlan=要方案/评估/设计；ambiguous=同一消息内标签或语气冲突（如【执行】标签+疑问正文）；confidence=你的把握。",
  "待判定用户消息：{{TEXT}}"
].join("\n");

const cacheKey = (text) => "intent:" + createHash("sha256").update(String(text), "utf8").digest("hex");

/** 是否需要 LLM 兜底（仅词表低置信且非确定性分类的消息） */
export function needsLlmEnrich(intents) {
  if (!intents) return false;
  if (intents.confidence === "high") return false;
  // status/execute/plan 均为确定性分类，不走 LLM：
  // plan（要方案）绝不因 LLM 误判 execute 而变成执行授权（安全方向，防误放行）
  if (intents.hasStatus || intents.hasExecute || intents.hasPlan) return false;
  return true;
}

/**
 * 同步三级裁决（守卫路径调用，纯函数）：
 * - 词表放行 → 维持放行（LLM 不收紧，非对称）
 * - 词表判拦 + turn.llmIntent.raw 匹配当前 userText 且 verdict.hasExecute 且 !ambiguous：
 *     confidence >= high → LLM 放行（来源 llm-high）
 *     confidence >= low  → LLM 放行（来源 llm-low，reason 标注低置信）
 *     否则 → 词表拦截
 * - 无 LLM 结果/raw 不匹配 → 词表拦截（保守）
 */
export function verdictForDeny(turn, cfg = {}, lexiconDenied = true) {
  if (!lexiconDenied) return { mutationDenied: false, source: "lexicon", reason: "词表放行" };
  const high = cfg.thresholdHigh ?? 0.8;
  const low = cfg.thresholdLow ?? 0.5;
  const llm = turn?.llmIntent;
  if (llm && llm.raw === turn?.userText && llm.verdict?.hasExecute && !llm.verdict.ambiguous) {
    const conf = Number(llm.verdict.confidence) || 0;
    if (conf >= high) return { mutationDenied: false, source: "llm-high", reason: `LLM 高置信(${conf})` };
    if (conf >= low) return { mutationDenied: false, source: "llm-low", reason: `LLM 低置信(${conf})` };
  }
  return { mutationDenied: true, source: "lexicon", reason: "" };
}

/**
 * 异步预取：对低置信消息调用一次 LLM，结果写入 turn.llmIntent。
 * 不进同步守卫路径；失败/超时/限额仅审计并保留词表裁决。
 * @param {object} ctx Cordis ctx（需 llm 服务）
 * @param {object} state 引擎运行时状态
 * @param {string} sid 会话 id
 * @param {string} text 用户消息文本
 * @param {object} cfg llmIntent 配置段（config.js DEFAULT_CONFIG.llmIntent）
 */
export async function enrichIntentWithLlm(ctx, state, sid, text, cfg) {
  if (!ctx?.llm || !cfg?.enabled) return;
  const intents = parseUserIntents(text);
  if (!needsLlmEnrich(intents)) return;
  const session = state.sessions.get(sid);
  if (!session) return;
  session.turn.intentState = "llm-pending";
  const key = cacheKey(text);
  if (!state.llmIntentCache) state.llmIntentCache = new Map();
  const cached = state.llmIntentCache.get(key);
  if (cached) {
    session.turn.llmIntent = { raw: text, verdict: cached, at: Date.now(), ms: 0 };
    session.turn.intentState = "llm-ready";
    state.llmIntentHits = (state.llmIntentHits || 0) + 1;
    return;
  }
  if (!state.llmIntentBudget) state.llmIntentBudget = new Map();
  const used = state.llmIntentBudget.get(sid) || 0;
  if (used >= (cfg.dailyLimitPerSession ?? 50)) {
    session.turn.intentState = "lexicon";
    return; // 超限降级词表
  }
  state.llmIntentBudget.set(sid, used + 1);
  const started = Date.now();
  try {
    const route = await resolveRoute(ctx);
    if (!route) throw new Error("no llm route");
    const userText = String(text).slice(0, 2000);
    const messages = [
      { role: "user", content: [{ type: "text", text: LLM_PROMPT.replace("{{TEXT}}", userText) }] }
    ];
    const out = await callLlm(ctx, route, { ruleId: "__intent", title: "LLM 意图判定", body: messages[0].content[0].text });
    if (!out) throw new Error("llm parse fail");
    const verdict = {
      hasExecute: Boolean(out.hasExecute),
      hasPlan: Boolean(out.hasPlan),
      hasQuestion: Boolean(out.hasQuestion),
      ambiguous: Boolean(out.ambiguous),
      reason: String(out.reason || "").slice(0, 120),
      confidence: Number(out.confidence) || 0,
      actionWord: String(out.actionWord || "")
    };
    // B1（2026-08-29 方案甲）：LLM 明确判 execute 且词表未命中 → 学动作词入热词表
    //（下次同词词表直接命中，不再依赖 LLM；学习失败静默，不影响主流程）
    if (verdict.hasExecute && verdict.actionWord && !actionWordsRe().test(text)) {
      learnHotword(verdict.actionWord);
    }
    const ms = Date.now() - started;
    session.turn.llmIntent = { raw: text, verdict, at: Date.now(), ms };
    session.turn.intentState = "llm-ready";
    state.llmIntentCache.set(key, verdict);
    const maxCache = cfg.cacheSize ?? 500;
    while (state.llmIntentCache.size > maxCache) {
      const firstKey = state.llmIntentCache.keys().next().value;
      if (firstKey === undefined) break;
      state.llmIntentCache.delete(firstKey);
    }
    auditIntent(state, sid, text, verdict, ms, false);
  } catch {
    session.turn.intentState = "lexicon";
    auditIntent(state, sid, text, null, Date.now() - started, false);
  }
}

function auditIntent(state, sid, text, verdict, ms, limitHit) {
  try {
    state.llmIntentLast = {
      text: String(text).slice(0, 60),
      verdict: verdict ? { ...verdict, confidence: Number(verdict.confidence) } : null,
      source: verdict ? "llm" : "fail",
      at: Date.now()
    };
    audit({
      kind: "intent-llm",
      rule: "__intent-llm",
      name: "LLM 意图判定",
      event: "user/message",
      reason: verdict
        ? `词表低置信 → LLM:${JSON.stringify(verdict)}（延迟 ${ms}ms${limitHit ? " 限额" : ""}）`
        : `词表低置信 → LLM 失败降级（延迟 ${ms}ms）`,
      session: sid,
      verdictSource: verdict ? "llm-intent" : "lexicon",
      text: String(text).slice(0, 120)
    });
  } catch {
    // 审计失败不阻断预取
  }
}

/** 供测试：needsLlmEnrich 与 verdictForDeny 的纯函数路径（不依赖 ctx） */
export function shouldDenyWithLlm(turn, cfg, lexiconDenied) {
  return verdictForDeny(turn, cfg, lexiconDenied);
}