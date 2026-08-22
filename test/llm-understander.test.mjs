import assert from "node:assert/strict";
import { enrichRulesWithLlm, sanitizeLlmResult } from "../lib/core/llm-understander.js";
import { understandRule } from "../lib/core/understander.js";

// ── 基础用例：LLM 只允许提高 confidence + 追加 hints；actions/handler 不受影响 ──
const rule = understandRule({
  index: "99",
  title: "测试规则（执行等级：D）",
  level: "D",
  body: "- **触发**：测试。\n- **检查**：无。\n- **动作**：自证。\n- **豁免**：无。"
});
rule.confidence = "low";

const state = { configs: [rule] };
const ctx = {
  llm: {
    listProviders() {
      return [{ name: "test-provider" }];
    },
    async listModels() {
      return [{ id: "test-model" }];
    },
    async *stream() {
      yield { type: "text-delta", index: 0, text: '{"actions":["deny"],"confidence":"high","handler":"rule24-assembly-type","hints":["x"]}' };
    }
  }
};

await enrichRulesWithLlm(ctx, state);
assert.equal(state.configs[0].confidence, "high", "LLM 可提高 confidence");
assert.equal(state.configs[0].llmEnriched, true);
assert.deepEqual(state.configs[0].actions, ["self-certify"], "actions 不受 LLM 影响（防误强化）");
assert.equal(state.configs[0].handler, "", "handler 不受 LLM 影响（防误指派）");
assert.ok(state.configs[0].hints.includes("x"), "hints 可追加");

// ── 降级防护：LLM 返回更低/相同 confidence 不生效；actions 软化不生效 ──
const rule2 = understandRule({
  index: "98",
  title: "测试规则 B（执行等级：A）",
  level: "A+D",
  body: "- **触发**：测试。\n- **检查**：无。\n- **动作**：硬拦。\n- **豁免**：无。"
});
rule2.confidence = "medium";
const state2 = { configs: [rule2] };
const ctx2 = {
  llm: {
    listProviders() {
      return [{ name: "test-provider" }];
    },
    async listModels() {
      return [{ id: "test-model" }];
    },
    async *stream() {
      // LLM 恶意/误答：把规则降为 low、去掉 deny —— 必须全部被消毒
      yield { type: "text-delta", index: 0, text: '{"actions":["self-certify"],"confidence":"low","handler":"","hints":[]}' };
    }
  }
};
await enrichRulesWithLlm(ctx2, state2);
assert.equal(state2.configs[0].confidence, "medium", "LLM 不允许降低 confidence（防软化）");
assert.ok(state2.configs[0].actions.includes("deny"), "deny 不允许被移除（防软化）");
assert.equal(state2.configs[0].llmEnriched, undefined, "无有效增强不算 llmEnriched");

// ── sanitizeLlmResult 单元用例 ──
const cfg = { confidence: "medium", actions: ["deny"], handler: "", hints: ["a"] };
const p1 = sanitizeLlmResult({ confidence: "low", actions: ["self-certify"], handler: "rule21-meta" }, cfg);
assert.equal(p1.confidence, undefined, "降级不生效");
assert.equal(p1.hints, undefined, "无 hints 时不产生");
const p2 = sanitizeLlmResult({ confidence: "high", hints: ["b", "a"] }, cfg);
assert.equal(p2.confidence, "high", "提升生效");
assert.deepEqual(p2.hints, ["a", "b"], "hints 追加去重");

console.log("llm-understander.test.js PASS");
