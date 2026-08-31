import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, getSessionState } from "../lib/core/state.js";
import { understandRule, actionsForLevel, analyzeCoverage } from "../lib/core/understander.js";
import { guardDecision } from "../lib/core/guard-core.js";

process.env.DSH_HOME = join(tmpdir(), "dsh-rule-engine-consistency-test-no-agents");
process.env.DSH_WORKSPACE = process.cwd();

// 通用夹具（T4）：不带本机规则编号——经「内联声明」绑定执行器，验证声明→行为链路
const authRule = understandRule({
  index: "AUTH_1",
  title: "通用授权规则（执行等级：C+D）",
  level: "C+D",
  body: "- **触发**：创建/删除/覆盖/移动/执行命令/下载/提交等。\n- **检查**：敏感操作需授权证据。\n- **动作**：无授权→拒绝。\n- **豁免**：只读、工作区低风险新建。\n<!-- handler: rule12a-approval -->"
});

function makeState() {
  const state = createState();
  state.configs = [authRule];
  return state;
}

const editExec = { name: "edit", arguments: { file_path: "D:/outside/consistency.txt", old_string: "a", new_string: "b" } };
const pwshExec = { name: "pwsh", arguments: { command: "Set-Content -Path 'D:/outside/consistency.txt' -Value 'b'" } };
const strReplaceExec = { name: "str_replace_editor", arguments: { command: "str_replace", path: "D:/outside/consistency.txt", old_str: "a", new_str: "b" } };

// 无授权：edit / pwsh / str_replace_editor 都必须拦（通用授权规则）
const stateNoAuth = makeState();
const editDeny = guardDecision(stateNoAuth, editExec);
const pwshDeny = guardDecision(stateNoAuth, pwshExec);
const strReplaceDeny = guardDecision(stateNoAuth, strReplaceExec);
assert.ok(editDeny && editDeny.ruleId === "AUTH_1", "edit outside write denied");
assert.ok(pwshDeny && pwshDeny.ruleId === "AUTH_1", "pwsh outside write denied");
assert.ok(strReplaceDeny && strReplaceDeny.ruleId === "AUTH_1", "str_replace_editor outside write denied");

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

// 覆盖自省（一致性预防）：dead = 生效默认表映射有但规则无；uncovered = 硬等级但无 handler
// 残余1 剥离后（2026-08-31）：默认表由调用方注入（analyzeCoverage 第二参数）——用自造表测语义
const customMap = { "1": "rule1-retry", "22": "rule22-7-direct" };
const LEN = Object.keys(customMap).length;
// AUTH_1 不在 customMap → 全部条目无在场 → dead = 全表
const cov1 = analyzeCoverage([authRule], customMap);
assert.equal(cov1.dead.size, LEN, `AUTH_1 不在注入表 → 注入表 ${LEN} 条全部判 dead`);
assert.equal(cov1.uncovered.length, 0, "authRule has handler -> covered");
const cov2 = analyzeCoverage([understandRule({ index: "99", title: "未知规则（执行等级：A）", level: "A", body: "- **触发**：x。\n- **检查**：y。" })], customMap);
assert.equal(cov2.dead.size, LEN, `全部 ${LEN} 条注入映射判 dead（无规则在场）`);
assert.ok(cov2.uncovered.some((u) => u.ruleId === "99"), "A-level rule without handler flagged uncovered");
// 注入表条目在场 → 不被判 dead（自省；条目按键引用）
const cov3 = analyzeCoverage([understandRule({ index: "1", title: "注入表键在场样例（执行等级：A）", level: "A", body: "- **触发**：x。\n- **检查**：y。\n- **动作**：z。" })], customMap);
assert.equal(cov3.dead.size, LEN - 1, "注入表条目在场 → 该条不被判 dead");
// 空表（通用部署）→ dead 恒 0
const covEmpty = analyzeCoverage([authRule], {});
assert.equal(covEmpty.dead.size, 0, "空默认表（通用）→ dead=0");

console.log("consistency.test.js PASS");
