// llm-intent.test.mjs - LLM 意图兜底纯函数测试（2026-08-24，方案 A）。
import assert from "node:assert/strict";
import { needsLlmEnrich, verdictForDeny } from "../lib/core/llm-intent.js";
import { parseUserIntents } from "../lib/core/intent.js";

const CFG = { thresholdHigh: 0.8, thresholdLow: 0.5, cacheSize: 10 };

// ── 触发条件（needsLlmEnrich）──
assert.equal(
  needsLlmEnrich(parseUserIntents("请你捯饬一下这份报告")),
  true,
  "词表未命中 → 走 LLM 兜底"
);
assert.equal(needsLlmEnrich(parseUserIntents("请继续")), false, "词表 execute 不走 LLM");
assert.equal(needsLlmEnrich(parseUserIntents("我已重启")), false, "状态信号不走 LLM");
assert.equal(needsLlmEnrich(parseUserIntents("请给出方案")), false, "高置信 plan 不走 LLM");

// ── 三级裁决（verdictForDeny）──
const TEXT = "请你捯饬一下这份报告";
const mk = (conf, ambiguous = false, raw = TEXT, userText = TEXT) => ({
  userText,
  intents: parseUserIntents(userText),
  llmIntent: {
    raw,
    verdict: { hasExecute: true, ambiguous, confidence: conf },
    at: 1,
    ms: 1200
  }
});

// LLM 高置信（>=0.8）→ 放行（llm-high）
assert.deepEqual(
  verdictForDeny(mk(0.9), CFG, true),
  { mutationDenied: false, source: "llm-high", reason: "LLM 高置信(0.9)" },
  "LLM 高置信放行"
);
// LLM 低置信（0.5~0.8）→ 放行（llm-low，标注）
assert.deepEqual(
  verdictForDeny(mk(0.6), CFG, true),
  { mutationDenied: false, source: "llm-low", reason: "LLM 低置信(0.6)" },
  "LLM 低置信放行并标注"
);
// LLM 低于 0.5 → 词表拦截（保守）
assert.equal(
  verdictForDeny(mk(0.4), CFG, true).mutationDenied,
  true,
  "LLM 过低置信 → 词表拦截"
);
// LLM ambiguous → 不采用（保守）
assert.equal(
  verdictForDeny(mk(0.95, true), CFG, true).mutationDenied,
  true,
  "LLM ambiguous → 词表拦截"
);
// raw 不匹配（LLM 结果属于别的消息）→ 词表拦截
assert.equal(
  verdictForDeny(mk(0.9, false, "另一条消息"), CFG, true).mutationDenied,
  true,
  "raw 不匹配 → 词表拦截"
);
// 无 LLM 结果（失败降级/未就绪）→ 词表拦截
assert.equal(
  verdictForDeny({ ...mk(0.9), llmIntent: null }, CFG, true).mutationDenied,
  true,
  "LLM 失败降级 → 词表拦截"
);
// 非对称：词表放行（lexiconDenied=false)时 LLM 永不收紧
assert.deepEqual(
  verdictForDeny(mk(0.9), CFG, false),
  { mutationDenied: false, source: "lexicon", reason: "词表放行" },
  "非对称：词表放行不收紧"
);

console.log("llm-intent.test.mjs PASS");