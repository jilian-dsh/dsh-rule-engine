import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, getSessionState } from "../lib/core/state.js";
import { understandRule } from "../lib/core/understander.js";
import { guardDecision } from "../lib/core/guard-core.js";

process.env.DSH_HOME = join(tmpdir(), "dsh-rule-engine-consistency-test-no-agents");
process.env.DSH_WORKSPACE = process.cwd();

const rule12d = understandRule({
  index: "12D",
  title: "敏感操作授权时序（执行等级：C）",
  level: "C",
  body: "- **触发**：git push/commit、工作区外写入、删除类、改配置。\n- **检查**：无授权证据→拒绝。\n- **动作**：拒绝。\n- **豁免**：无。"
});

function makeState() {
  const state = createState();
  state.configs = [rule12d];
  return state;
}

const editExec = { name: "edit", arguments: { file_path: "D:/outside/consistency.txt", old_string: "a", new_string: "b" } };
const pwshExec = { name: "pwsh", arguments: { command: "Set-Content -Path 'D:/outside/consistency.txt' -Value 'b'" } };
const strReplaceExec = { name: "str_replace_editor", arguments: { command: "str_replace", path: "D:/outside/consistency.txt", old_str: "a", new_str: "b" } };

// 无授权：edit / pwsh / str_replace_editor 都必须拦
const stateNoAuth = makeState();
const editDeny = guardDecision(stateNoAuth, editExec);
const pwshDeny = guardDecision(stateNoAuth, pwshExec);
const strReplaceDeny = guardDecision(stateNoAuth, strReplaceExec);
assert.ok(editDeny && editDeny.ruleId === "12D", "edit outside write denied");
assert.ok(pwshDeny && pwshDeny.ruleId === "12D", "pwsh outside write denied");
assert.ok(strReplaceDeny && strReplaceDeny.ruleId === "12D", "str_replace_editor outside write denied");

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

console.log("consistency.test.js PASS");
