import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, getSessionState } from "../lib/core/state.js";
import { guardDecision } from "../lib/core/guard-core.js";
import { defaultContract } from "../lib/core/contract.js";

// 测试隔离（2026-08-31）：本测试此前漏设 DSH_HOME——前序 parser.test 的 cleanupTempHome 会
// 删除环境变量 → resolveDshHome 回落真实 ~/.dsh → maybeReloadIfChanged 读真实 AGENTS.md
// 灌入测试 state（规则 9 全称标题实证）；剥离后真实规则空 handler 走 hints 兜底变敏感暴露此缺陷。
// 与其他测试同款：固定 tmp DSH_HOME（无 AGENTS.md）→ maybeReloadIfChanged 容错保持空 configs。
process.env.DSH_HOME = join(tmpdir(), "dsh-rule-engine-taskcontract-test");
process.env.DSH_WORKSPACE = process.cwd();

// review 模式写文件应被任务契约硬拦
{
  const state = createState();
  state.enabled = true;
  state.taskContract = { taskContractEnabled: true, askEnabled: false, taskContractMode: "armed" };
  const s = getSessionState(state, "s1");
  s.contract = { ...defaultContract(), mode: "review", level: "guard" };
  const hit = guardDecision(state, {
    name: "edit",
    arguments: { file_path: "D:/a.txt", new_string: "x" },
    agent: { session: { id: "s1" } }
  });
  assert.ok(hit, "review mode edit should be denied");
  assert.match(hit.reason, /MODE_FORBIDS_MUTATION/);
}

// 总开关关闭时不拦截（任务契约不拦；2026-08-24：12A 截胡修复后需给匹配授权以隔离 12A 敏感检查）
{
  const state = createState();
  state.enabled = true;
  state.taskContract = { taskContractEnabled: false, askEnabled: false, taskContractMode: "observe" };
  const s = getSessionState(state, "s2");
  s.contract = { ...defaultContract(), mode: "review", level: "guard" };
  s.authorizations.push({ type: "any", pathPrefix: "", at: Date.now(), expiresAt: Date.now() + 60000 });
  const hit = guardDecision(state, {
    name: "edit",
    arguments: { file_path: "D:/a.txt", new_string: "x" },
    agent: { session: { id: "s2" } }
  });
  assert.equal(hit, null);
}

// deps=ask + askEnabled=true 时 guard 不拦（交给 tools/pre-execute 询问）
{
  const state = createState();
  state.enabled = true;
  state.taskContract = { taskContractEnabled: true, askEnabled: true, taskContractMode: "armed" };
  const s = getSessionState(state, "s3");
  s.contract = { ...defaultContract(), mode: "change", level: "guard", dependencyPolicy: "ask" };
  const hit = guardDecision(state, {
    name: "pwsh",
    arguments: { command: "npm install lodash" },
    agent: { session: { id: "s3" } }
  });
  assert.equal(hit, null, "ask-intended action should not be denied by guard");
}

// 2026-08-25 预算双判防护：guard 收到"已扣"contract（agentsUsed=2/2）时不得再判预算 deny
//（唯一裁决点 = tools/pre-execute 钩子；此处模拟预热后 guard 视角，防"允许 N 实际 N-1"复现）
{
  const state = createState();
  state.enabled = true;
  state.taskContract = { taskContractEnabled: true, askEnabled: false, taskContractMode: "armed" };
  const s = getSessionState(state, "s4");
  s.contract = { ...defaultContract(), mode: "change", level: "guard", agentBudget: 2, agentsUsed: 2 };
  const hit = guardDecision(state, {
    name: "subagent",
    arguments: { description: "x", prompt: "y" },
    agent: { session: { id: "s4" } }
  });
  assert.equal(hit, null, "预算类 deny 由 pre-execute 唯一裁决（guard 双判防护）");
}

console.log("task-contract-guard.test.mjs PASS");
