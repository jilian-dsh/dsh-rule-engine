// llm-understander.js - LLM 增量理解器（P3）
// 对非 high 置信规则调用 ctx.llm 做结构化理解；失败/不可用时回退模式库。
// 纯依赖注入 ctx.llm，不 import 官方包。

export async function resolveRoute(ctx) {
  if (!ctx?.llm) return null;
  try {
    const providers = ctx.llm.listProviders?.() || [];
    if (providers.length === 0) return null;
    // v0.5.7 修复（实弹抓到，2026-08-26）：必须用 provider 的 **id**（如 "deepseek-official"）调
    // listModels/resolve——pi-ai 按 id 找 profile，name（显示名）可能不同 → 传 name 会抛
    // NO_ADAPTER → 全部分析失败（旧 llmIntent 自启用起 31 次调用全降级的同根因）。
    const provider = process.env.DSH_LLM_PROVIDER || providers[0]?.id || providers[0]?.name || providers[0];
    const models = await ctx.llm.listModels?.(provider);
    const model = process.env.DSH_LLM_MODEL || (models && models[0]?.id) || (models && models[0]) || null;
    if (!model) return null;
    return { provider, model };
  } catch {
    return null;
  }
}

function buildPrompt(rule) {
  const body = rule.body || "";
  const elements = rule.elements || {};
  return [
    "你是 DSH 规则理解器。根据规则正文输出严格 JSON，不要输出其他内容。",
    "JSON 格式：",
    '{"actions":["deny"|"correct"|"ask"|"self-certify"|"meta"],"confidence":"high"|"medium"|"low","handler":"短横线标识或空","hints":["字符串提示数组"]}',
    "规则编号：" + rule.ruleId,
    "规则标题：" + rule.title,
    "规则正文：",
    body,
    "触发：" + (elements.trigger || ""),
    "检查：" + (elements.check || ""),
    "动作：" + (elements.action || ""),
    "只输出 JSON。"
  ].join("\n");
}

export function parseJsonOutput(text) {
  const t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : t;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function callLlm(ctx, route, rule) {
  const messages = [
    {
      role: "user",
      content: [{ type: "text", text: buildPrompt(rule) }]
    }
  ];
  let text = "";
  for await (const chunk of ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    messages,
    maxTokens: 500,
    temperature: 0
  })) {
    if (chunk && chunk.type === "text-delta" && typeof chunk.text === "string") {
      text += chunk.text;
    }
  }
  return parseJsonOutput(text);
}

/**
 * LLM 结果消毒（防软化/误强化，2026-08-23）：
 *  - confidence：只允许提高（low→medium/high、medium→high）；不允许降低（防"模型把规则软化到不硬拦"）
 *  - hints：只允许追加（辅助检测面，不缩小）
 *  - actions / handler：一律不受 LLM 影响——执行语义只由模式库（HANDLER_BY_RULE/等级）决定，
 *    既是防软化也是防"LLM 把规则误指派到无关 handler 造成误拦"。
 */
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

export function sanitizeLlmResult(result, cfg) {
  const out = {};
  if (typeof result?.confidence === "string" && CONFIDENCE_RANK[result.confidence] > CONFIDENCE_RANK[cfg?.confidence || "low"]) {
    out.confidence = result.confidence;
  }
  if (Array.isArray(result?.hints) && result.hints.length > 0) {
    out.hints = [...new Set([...(cfg?.hints || []), ...result.hints])];
  }
  return out;
}
export async function enrichRulesWithLlm(ctx, state) {
  if (!ctx?.llm || !Array.isArray(state.configs)) return;
  const route = await resolveRoute(ctx);
  if (!route) return;
  if (!state.llmEnrichedKeys) state.llmEnrichedKeys = new Set();
  const mtime = state.mtimeMs || 0;
  const targets = state.configs.filter((c) => {
    if (c.confidence === "high") return false;
    const key = `${c.ruleId}@${mtime}`;
    return !state.llmEnrichedKeys.has(key);
  });
  for (const cfg of targets) {
    const key = `${cfg.ruleId}@${mtime}`;
    cfg.llmTried = true;
    state.llmEnrichedKeys.add(key); // 无论成功失败，每个规则版本只尝试一次
    try {
      const result = await callLlm(ctx, route, cfg);
      if (result && result.confidence) {
        const patch = sanitizeLlmResult(result, cfg);
        if (patch.confidence) cfg.confidence = patch.confidence;
        if (patch.hints) cfg.hints = patch.hints;
        if (patch.confidence || patch.hints) cfg.llmEnriched = true;
      }
    } catch {
      // 单条失败不影响其他规则，保留模式库结果
    }
  }
}
