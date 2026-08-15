import assert from "node:assert/strict";
import { understandRule, understandAll, actionsForLevel } from "../lib/core/understander.js";

assert.deepEqual(actionsForLevel("A 弱"), ["deny"]);
assert.deepEqual(actionsForLevel("A+D"), ["deny", "self-certify"]);
assert.deepEqual(actionsForLevel("B"), ["correct"]);
assert.deepEqual(actionsForLevel("C"), ["ask"]);
assert.deepEqual(actionsForLevel("M"), ["meta"]);

const rule = {
  index: "9",
  title: "PS 编码与命令执行（执行等级：A+D）",
  section: "一、执行与安全",
  level: "A+D",
  body: [
    "- **触发**：任何含中文的脚本/命令。",
    "- **检查**：拦内联命令（node -e / pwsh -c / node -p）；拦 Set-Content -Encoding UTF8 写 .json。",
    "- **动作**：硬拦项拒绝 + 台账。",
    "- **豁免**：无。"
  ].join("\n")
};

const cfg = understandRule(rule);
assert.equal(cfg.ruleId, "9");
assert.equal(cfg.handler, "rule9-inline-bom");
assert.ok(cfg.actions.includes("deny"));
assert.ok(cfg.actions.includes("self-certify"));
assert.ok(cfg.hints.includes("inline-command"));
assert.ok(cfg.hints.includes("bom-write"));
assert.equal(cfg.confidence, "high");

const cfgs = understandAll([rule, { ...rule, index: "2", title: "时间（执行等级：B）", level: "B" }]);
assert.equal(cfgs.length, 2);
assert.equal(cfgs[1].handler, "rule2-time");

console.log("understander.test.js PASS");
