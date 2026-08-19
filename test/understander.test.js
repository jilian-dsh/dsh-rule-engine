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
    "- **检查**：拦内联命令（node -e / pwsh -c / node -p）；拦 Set-Content -Encoding utf8BOM 写 .json/.yaml。",
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

const rule27 = understandRule({
  index: "27",
  title: "插件挂载唯一性与重启前全量审计（执行等级：C+D）",
  section: "一、执行与安全",
  level: "C+D",
  body: "- **触发**：新增/修改/移除/升级 DSH 插件装配；或准备重启。\n- **检查**：装配变更后先跑全量审计；重启前有审计通过记录。\n- **动作**：缺审计通过记录先跑审计。\n- **豁免**：官方 bundle 自身装配；只读查看装配。"
});
assert.equal(rule27.handler, "rule27-mount-audit");
assert.ok(rule27.actions.includes("ask"));
assert.ok(rule27.actions.includes("self-certify"));

console.log("understander.test.js PASS");
