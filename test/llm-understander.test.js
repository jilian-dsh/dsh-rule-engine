import assert from "node:assert/strict";
import { enrichRulesWithLlm } from "../lib/core/llm-understander.js";
import { understandRule } from "../lib/core/understander.js";

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
      yield { type: "text-delta", index: 0, text: '{"actions":["self-certify"],"confidence":"high","handler":"test","hints":["x"]}' };
    }
  }
};

await enrichRulesWithLlm(ctx, state);
assert.equal(state.configs[0].confidence, "high");
assert.equal(state.configs[0].llmEnriched, true);
assert.deepEqual(state.configs[0].actions, ["self-certify"]);
assert.equal(state.configs[0].handler, "test");

console.log("llm-understander.test.js PASS");
