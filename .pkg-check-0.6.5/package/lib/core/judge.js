// judge.js - D 级嫌疑裁决器（v0.5.7，用户拍板 2026-08-26）。
// 原则：词表命中只是"嫌疑"；"是否是错误"由 LLM 确认——只有裁决为违规的才进入投递。
// 模型：追随会话模型（复用 llm-understander.resolveRoute，与现有 LLM 意图判定同一路由机制，
//       用户拍板：不单独固定模型，避免独立路由稳定性问题）。
// 保护：sha256(ruleId+text) 缓存（同文本不重复调用）；每会话每日 JUDGE_DAILY_LIMIT 次预算；
//       调用失败/超时/无路由 → 返回 unavailable（fail-closed：不投递，只审计）。
import { createHash } from "node:crypto";
import { resolveRoute, parseJsonOutput } from "./llm-understander.js";

/** 每日裁决预算（用户拍板：50 次/会话/天；超预算 → unavailable，只审计不投递）。 */
export const JUDGE_DAILY_LIMIT = 50;

export function judgeCacheKey(ruleId, text) {
  return createHash("sha256").update(`${ruleId}\n${text}`).digest("hex");
}

export function judgeBudgetKey(sessionId, now = Date.now()) {
  const d = new Date(now);
  return `${sessionId}:${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

/**
 * 裁决一次嫌疑。
 * @returns {Promise<{action:"deliver"|"suppress"|"unavailable", note:string, model?:string}>}
 *   deliver      = 确认真违规 → 允许投递
 *   suppress     = 确认合规声明/引述/非违规 → 不投递（审计 judge-false）
 *   unavailable  = 无法裁决（预算满/无路由/调用失败）→ 不投递（fail-closed，审计 judge-unavailable）
 */
export async function judgeViolation(ctx, state, sessionId, violation, text) {
  const key = judgeCacheKey(violation.ruleId, text);
  const cached = state.judgeCache?.get(key);
  if (cached) return cached;

  const bKey = judgeBudgetKey(sessionId);
  const budget = state.judgeBudget?.get(bKey) || { count: 0 };
  if (budget.count >= JUDGE_DAILY_LIMIT) {
    return { action: "unavailable", note: `裁决日预算已满（${JUDGE_DAILY_LIMIT}/日/会话）` };
  }

  try {
    const route = await resolveRoute(ctx);
    if (!route) return { action: "unavailable", note: "无法解析模型路由（追随会话模型解析失败）" };
    const rawCfg = Array.isArray(state.configs)
      ? state.configs.find((c) => String(c.ruleId) === String(violation.ruleId))
      : undefined;
    const prompt = violation.mode === "criticism"
      ? [
          "你是 DSH 规则 22② 语义裁决器。判断下面这段【用户消息】是否构成对执行者的批评/指责/质问（规则 22②：用户批评不构成任何授权）。只输出 JSON，不要其他内容。",
          'JSON 格式：{"violated": true|false, "note": "一句话理由"}',
          "判定要点：",
          "1. 批评/指责/质问 = 用户对执行者行为的否定、责备、反问指责（如“你又错了”“怎么还在做”“这不对吧”）——violated=true；",
          "2. 普通疑问/信息咨询/技术提问（如“这个功能怎么用”“你确认了吗”）——violated=false；",
          "3. 用户引述规则文本或转述他人的批评——violated=false；",
          "4. 拿不准给 false（偏不打扰——这是语义提醒，不是硬拦）。",
          "检测提示：" + String(violation.reason || ""),
          "用户消息：",
          text,
          "只输出 JSON。"
        ].join("\n")
      : [
          "你是 DSH 规则裁决器。判断下面这段【执行者回复】是否违反【规则】。只输出 JSON，不要其他内容。",
          'JSON 格式：{"violated": true|false, "note": "一句话理由"}',
          "判定要点：",
          "1. 回复若是在表达合规声明（如“我不再/将避免/规则 X 已自证/无重复推销”）或引述规则文本——violated=false；",
          "2. 只有确实发生规则禁止的行为（如真的再次推销/真的发布未声明/真的遗漏事项）才 violated=true；",
          "3. 拿不准时给出倾向性判断（false 偏不打扰）。",
          "规则编号：" + violation.ruleId,
          "规则标题：" + violation.title,
          "检测提示：" + String(violation.reason || ""),
          "规则正文：" + (rawCfg?.body || "(未提供)"),
          "执行者回复：",
          text,
          "只输出 JSON。"
        ].join("\n");
    const messages = [{ role: "user", content: [{ type: "text", text: prompt }] }];
    let out = "";
    for await (const chunk of ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      maxTokens: 300,
      temperature: 0
    })) {
      if (chunk && chunk.type === "text-delta" && typeof chunk.text === "string") out += chunk.text;
    }
    budget.count += 1;
    state.judgeBudget.set(bKey, budget);
    const parsed = parseJsonOutput(out);
    const verdict = {
      action: parsed?.violated === true ? "deliver" : "suppress",
      note: typeof parsed?.note === "string" ? parsed.note.slice(0, 120) : "",
      model: route.model
    };
    state.judgeCache.set(key, verdict);
    return verdict;
  } catch (error) {
    return { action: "unavailable", note: `裁决调用失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 批量裁决（0.5.11，用户定稿"频率不高"假设打穿修复）：一次回复的全部嫌疑 → **一次** LLM 调用、
 * **一次**预算消耗、对每条嫌疑给独立判定。
 * 背景：此前 deliverSuspects 对每条嫌疑单独 judgeViolation（每条一次 LLM + 一条预算）——长会话
 * 大量嫌疑一天 200+ 次调用，50/日预算早上就满（judge-unavailable 89 条实证）；单次调用聚合后，
 * "一次回复一次裁决"才是设计时"裁决频率不高"的真实粒度。
 * @returns {Promise<Array<{violation, verdict}>>} 每条嫌疑对应一个 verdict（deliver/suppress/unavailable）
 */
export async function judgeViolationsBatch(ctx, state, sessionId, violations, text) {
  if (!Array.isArray(violations) || violations.length === 0) return [];
  const bKey = judgeBudgetKey(sessionId);
  const budget = state.judgeBudget?.get(bKey) || { count: 0 };
  if (budget.count >= JUDGE_DAILY_LIMIT) {
    return violations.map((v) => ({ violation: v, verdict: { action: "unavailable", note: `裁决日预算已满（${JUDGE_DAILY_LIMIT}/日/会话）` } }));
  }
  try {
    const route = await resolveRoute(ctx);
    if (!route) return violations.map((v) => ({ violation: v, verdict: { action: "unavailable", note: "无法解析模型路由（追随会话模型解析失败）" } }));
    // 一次性列出全部嫌疑（编号+规则+提示），一次判定
    const list = violations.map((v, i) => {
      const rawCfg = Array.isArray(state.configs) ? state.configs.find((c) => String(c.ruleId) === String(v.ruleId)) : undefined;
      return [
        `[${i + 1}] 规则 ${v.ruleId}（${v.title}）`,
        `检测提示：${String(v.reason || "")}`,
        `规则正文：${rawCfg?.body || "(未提供)"}`
      ].join("\n");
    }).join("\n\n");
    const prompt = [
      "你是 DSH 规则裁决器。判断下面这段【执行者回复】是否符合下列【每条规则】。只输出 JSON，不要其他内容。",
      'JSON 格式：{"results": [{"index": 1, "violated": true|false, "note": "一句话理由"}, ...]}',
      "判定要点：",
      "1. 回复若是在表达合规声明（如“我不再/将避免/规则 X 已自证/无重复推销”）或引述规则文本——violated=false；",
      "2. 只有确实发生规则禁止的行为才 violated=true；",
      "3. 拿不准时给出倾向性判断（false 偏不打扰）；",
      "4. 每条嫌疑都给独立判定，index 对应下面列号。",
      "嫌疑列表：",
      list,
      "执行者回复：",
      text,
      "只输出 JSON。"
    ].join("\n");
    const messages = [{ role: "user", content: [{ type: "text", text: prompt }] }];
    let out = "";
    for await (const chunk of ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      maxTokens: 800,
      temperature: 0
    })) {
      if (chunk && chunk.type === "text-delta" && typeof chunk.text === "string") out += chunk.text;
    }
    budget.count += 1;
    state.judgeBudget.set(bKey, budget); // 一次调用 = 一条预算（聚合粒度，而非逐条）
    const parsed = parseJsonOutput(out);
    const results = Array.isArray(parsed?.results) ? parsed.results : [];
    return violations.map((v, i) => {
      const r = results.find((x) => Number(x?.index) === i + 1);
      return {
        violation: v,
        verdict: {
          action: r?.violated === true ? "deliver" : "suppress",
          note: typeof r?.note === "string" ? r.note.slice(0, 120) : "",
          model: route.model
        }
      };
    });
  } catch (error) {
    return violations.map((v) => ({ violation: v, verdict: { action: "unavailable", note: `批量裁决调用失败：${error instanceof Error ? error.message : String(error)}` } }));
  }
}
