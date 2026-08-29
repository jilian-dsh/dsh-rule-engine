// phase1e-texthealth.test.mjs - 批次 5 文本健康检测测试（2026-08-24）
// ① 词表盲区修复（开工/动手 = execute）
// ② 术语密度（规则 11③ 零基础表达）：中文提问 + 术语 + 无解释 → 自证；带解释 → 不命中
// ③ 重复推销（规则 16）：同类建议 ≥2 次 → 自证
// 先红后绿：改码前本文件应失败；改码后转绿。
import assert from "node:assert/strict";

const { parseUserIntents } = await import("../lib/core/intent.js");
const { detectViolations } = await import("../lib/core/text-detect.js");

// ═══════════════ ① 词表盲区 ═══════════════
{
  assert.equal(parseUserIntents("请开工").hasExecute, true, "词表补：开工 = execute");
  assert.equal(parseUserIntents("动手吧").hasExecute, true, "词表补：动手 = execute");
}

// ═══════════════ ② 术语密度（规则 11③） ═══════════════
const mkCfg = (ruleId, title, actions) => ({
  ruleId, title, level: "D", actions, confidence: "high", disabled: false, hints: [], elements: {}, triggerKeywords: []
});
const CFG11 = mkCfg("11", "语言与表达（执行等级：B 弱 + D）", ["correct", "self-certify"]);
const CFG16 = mkCfg("16", "建议提出规范（执行等级：D 强）", ["self-certify"]);
const mkSession = (lastUserText) => ({
  lastUserText,
  suggestionCounts: {},
  mountAuditRevision: 0,
  turn: { getDateSeen: false }
});
const hasTermHit = (hits) => hits.some((h) => h.ruleId === "11" && /零基础|解释/.test(h.reason));
const hasSuggestionHit = (hits) => hits.some((h) => h.ruleId === "16" && /重复/.test(h.reason));

{
  // 中文提问 + 术语 + 无解释 → 命中
  const hits = detectViolations({
    configs: [CFG11], session: mkSession("讲讲这个功能"), text: "这是 REST API，采用 JSON 序列化和异步回调机制", reasoningText: ""
  });
  assert.ok(hasTermHit(hits), `术语无解释 → 命中（实际 ${JSON.stringify(hits.map((h) => h.ruleId))}）`);
  // 术语 + 解释词 → 不命中
  const hits2 = detectViolations({
    configs: [CFG11], session: mkSession("讲讲这个功能"), text: "这是 REST API，简单说就是网页接口；JSON 即键值格式，异步即不等待", reasoningText: ""
  });
  assert.ok(!hasTermHit(hits2), "术语带解释 → 不命中");
  // 无术语 → 不命中
  const hits3 = detectViolations({
    configs: [CFG11], session: mkSession("讲讲这个功能"), text: "这个文件是配置，修改后保存即可", reasoningText: ""
  });
  assert.ok(!hasTermHit(hits3), "无术语 → 不命中");
}

// ═══════════════ ③ 重复推销（规则 16） ═══════════════
{
  const s = mkSession("给我方案");
  const first = detectViolations({ configs: [CFG16], session: s, text: "我建议用 A 方案", reasoningText: "" });
  assert.ok(!hasSuggestionHit(first), "首次建议不判重复");
  const second = detectViolations({ configs: [CFG16], session: s, text: "我建议还是用 A 方案吧", reasoningText: "" });
  assert.ok(hasSuggestionHit(second), "同会话二次同类建议 → 命中");
  // 会话隔离：另一会话计数独立
  const s2 = mkSession("给我方案");
  const other = detectViolations({ configs: [CFG16], session: s2, text: "我建议用 B 方案", reasoningText: "" });
  assert.ok(!hasSuggestionHit(other), "新会话计数归零");
}

console.log("phase1e-texthealth.test.mjs PASS");
