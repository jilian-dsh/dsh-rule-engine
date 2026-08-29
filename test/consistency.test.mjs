import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, getSessionState } from "../lib/core/state.js";
import { understandRule, actionsForLevel, analyzeCoverage } from "../lib/core/understander.js";
import { guardDecision } from "../lib/core/guard-core.js";

process.env.DSH_HOME = join(tmpdir(), "dsh-rule-engine-consistency-test-no-agents");
process.env.DSH_WORKSPACE = process.cwd();

const rule12a = understandRule({
  index: "12A",
  title: "执行前确认（执行等级：C+D）",
  level: "C+D",
  body: "- **触发**：创建/删除/覆盖/移动/执行命令/下载/提交等。\n- **检查**：敏感操作需授权证据。\n- **动作**：无授权→拒绝。\n- **豁免**：只读、工作区低风险新建。"
});

function makeState() {
  const state = createState();
  state.configs = [rule12a];
  return state;
}

const editExec = { name: "edit", arguments: { file_path: "D:/outside/consistency.txt", old_string: "a", new_string: "b" } };
const pwshExec = { name: "pwsh", arguments: { command: "Set-Content -Path 'D:/outside/consistency.txt' -Value 'b'" } };
const strReplaceExec = { name: "str_replace_editor", arguments: { command: "str_replace", path: "D:/outside/consistency.txt", old_str: "a", new_str: "b" } };

// 无授权：edit / pwsh / str_replace_editor 都必须拦（规则 12A）
const stateNoAuth = makeState();
const editDeny = guardDecision(stateNoAuth, editExec);
const pwshDeny = guardDecision(stateNoAuth, pwshExec);
const strReplaceDeny = guardDecision(stateNoAuth, strReplaceExec);
assert.ok(editDeny && editDeny.ruleId === "12A", "edit outside write denied");
assert.ok(pwshDeny && pwshDeny.ruleId === "12A", "pwsh outside write denied");
assert.ok(strReplaceDeny && strReplaceDeny.ruleId === "12A", "str_replace_editor outside write denied");

// 有匹配授权：edit / pwsh / str_replace_editor 都必须放行
const stateAuth = makeState();
getSessionState(stateAuth, "global").authorizations.push({
  type: "write",
  pathPrefix: "d:/outside",
  at: Date.now(),
  source: "test"
});
assert.equal(guardDecision(stateAuth, editExec), null, "edit outside write allowed with auth");
assert.equal(guardDecision(stateAuth, pwshExec), null, "pwsh outside write allowed with auth");
assert.equal(guardDecision(stateAuth, strReplaceExec), null, "str_replace_editor outside write allowed with auth");

// 等级→动作一致性（2026-08-23：修复 level 正则不支持 "B + D" 空格组合的回归）
assert.deepEqual(actionsForLevel("B + D"), ["correct", "self-certify"], "B + D -> correct+self-certify");
assert.deepEqual(actionsForLevel("B 弱 + D"), ["correct", "self-certify"], "B 弱 + D -> correct+self-certify");
assert.deepEqual(actionsForLevel("A+D"), ["deny", "self-certify"], "A+D preserved");
assert.deepEqual(actionsForLevel("D 强"), ["self-certify"], "D 强 -> self-certify");

// 覆盖自省（一致性预防）：dead = 映射有但规则无；uncovered = 硬等级但无 handler
// 单规则场景：17 个映射中仅 "12A" 存在 → 其余 16 个均为 dead（真实场景由 consistency-live 断言为 0；2026-08-24 13B 外移后映射 19→18；2026-08-28 删 rule14 空转映射后 18→17）
const cov1 = analyzeCoverage([rule12a]);
assert.equal(cov1.dead.size, 16, "16 other mappings flagged dead when presenting only rule12a");
assert.equal(cov1.uncovered.length, 0, "rule12a has handler -> covered");
const cov2 = analyzeCoverage([understandRule({ index: "99", title: "未知规则（执行等级：A）", level: "A", body: "- **触发**：x。\n- **检查**：y。" })]);
assert.equal(cov2.dead.size, 17, "all 17 HANDLER_BY_RULE mappings flagged dead when no rule present");
assert.ok(cov2.uncovered.some((u) => u.ruleId === "99"), "A-level rule without handler flagged uncovered");

console.log("consistency.test.js PASS");
