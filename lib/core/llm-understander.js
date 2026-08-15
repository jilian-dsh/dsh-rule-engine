// llm-understander.js - LLM 增量理解器（P3）
// 对非 high 置信规则调用 ctx.llm 做结构化理解；失败/不可用时回退模式库。
// 纯依赖注入 ctx.llm，不 import 官方包。

async function resolveRoute(ctx) {
  if (!ctx?.llm) return null;
  try {
    const providers = ctx.llm.listProviders?.() || [];
    if (providers.length === 0) return null;
    const provider = process.env.DSH_LLM_PROVIDER || providers[0]?.name || providers[0];
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

function parseJsonOutput(text) {
  const t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : t;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function callLlm(ctx, route, rule) {
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
 * 对非 high 置信规则做一次 LLM 增量理解。
 * @param {object} ctx Cordis context
 * @param {object} state 插件状态（configs 会被原地更新）
 */
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
        if (Array.isArray(result.actions)) cfg.actions = result.actions;
        if (typeof result.confidence === "string") cfg.confidence = result.confidence;
        if (typeof result.handler === "string") cfg.handler = result.handler;
        if (Array.isArray(result.hints)) cfg.hints = result.hints;
        cfg.llmEnriched = true;
      }
    } catch {
      // 单条失败不影响其他规则，保留模式库结果
    }
  }
}
