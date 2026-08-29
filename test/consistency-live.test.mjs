// consistency-live.test.mjs — 真实 AGENTS.md ↔ 引擎映射一致性守门测试（预防漂移）
// 若本机不存在 AGENTS.md（开发/CI 环境）则跳过；存在则强制：
//   1. 引擎映射无死键（HANDLER_BY_RULE 中的规则 ID 必须存在于 AGENTS.md）
//   2. 所有 A/C/M 级规则（deny/ask/meta）必须有 handler（规则声明强制 ⇒ 引擎必须执行）
//   3. "B + D"/"B 弱 + D" 类空格组合等级必须解析出 correct+self-certify（防 level 解析回归）
// 运行：node test/consistency-live.test.mjs（被 run-all.mjs 一并执行）
import assert from "node:assert/strict";
import { loadRules } from "../lib/core/parser.js";
import { understandAll, analyzeCoverage } from "../lib/core/understander.js";

const parsed = loadRules();
if (!parsed.ok || parsed.missing) {
  console.log("consistency-live.test.js SKIP (no AGENTS.md on this machine)");
  process.exit(0);
}

const configs = understandAll(parsed.rules);
const { dead, uncovered } = analyzeCoverage(configs);

assert.equal(
  dead.size,
  0,
  `死映射（引擎映射存在但 AGENTS.md 无此规则）：${[...dead.entries()].map(([id, h]) => `${id}->${h}`).join("、")}。请清理 HANDLER_BY_RULE 或恢复规则。`
);
assert.equal(
  uncovered.length,
  0,
  `未覆盖硬规则（A/C/M 级但无 handler，声明强制但引擎不执行）：${uncovered.map((u) => `${u.ruleId}(${u.actions.join("+")})`).join("、")}。请补 handler 或降为 D 级。`
);

// level 解析一致性：B + D / B 弱 + D 类规则必须同时有 correct 与 self-certify
const byId = new Map(configs.map((c) => [String(c.ruleId), c]));
for (const id of ["2", "11", "12C"]) {
  const cfg = byId.get(id);
  if (!cfg) continue;
  const acts = cfg.actions || [];
  assert.ok(
    acts.includes("correct") && acts.includes("self-certify"),
    `规则 ${id} 等级 "${cfg.level}" 应解析出 correct+self-certify，实际 ${acts.join("+")}`
  );
}

console.log(`consistency-live.test.js PASS (${configs.length} rules, 0 dead, 0 uncovered)`);
