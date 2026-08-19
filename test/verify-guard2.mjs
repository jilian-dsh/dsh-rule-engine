// verify-guard2.mjs —— 用真实 AGENTS.md + 完整理解流程模拟真实环境的守卫裁决
import { createState, getSessionState } from "../lib/core/state.js";
import { guardDecision } from "../lib/core/guard-core.js";
import { loadRules } from "../lib/core/parser.js";
import { understandAll } from "../lib/core/understander.js";
import { writeTargetPathsFromCommand, isSensitiveToolCall, isReadOnlyTool } from "../lib/core/patterns.js";

process.env.DSH_HOME = "D:\\DeepSeek harness\\.dsh";
process.env.DSH_WORKSPACE = "D:\\DeepSeek harness\\dsh-project";

const parsed = loadRules();
console.log("rules:", parsed.rules.length, "ok:", parsed.ok);
const state = createState();
state.configs = understandAll(parsed.rules);
for (const c of state.configs) {
  if (c.ruleId === "13A" || c.ruleId === "13" || c.ruleId === "12D") {
    console.log(`  cfg ${c.ruleId}: handler=${c.handler} actions=${JSON.stringify(c.actions)} confidence=${c.confidence}`);
  }
}

const cmd = `$c = "D:\\DeepSeek harness\\dsh-project\\archive\\npm-cache-tmp4"; New-Item -ItemType Directory -Force -Path $c | Out-Null; Get-Item "D:\\DeepSeek harness\\.dsh\\profiles\\web\\node_modules\\dshmarket\\data\\registry-snapshot.json" | Select-Object Name, Length`;

console.log("writeTargets:", JSON.stringify(writeTargetPathsFromCommand(cmd)));
console.log("isReadOnlyTool:", isReadOnlyTool("pwsh", { command: cmd }));
console.log("isSensitiveToolCall:", isSensitiveToolCall("pwsh", { command: cmd }));

const session = getSessionState(state, "test");
const exec = { name: "pwsh", arguments: { command: cmd, description: "验证" }, agent: { session: { id: "test" } } };
const hit = guardDecision(state, exec, Date.now());
console.log("guardDecision:", hit ? hit.reason : "PASS (no denial)");
