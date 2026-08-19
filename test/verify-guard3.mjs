// verify-guard3.mjs —— 定位 gh release create 命令被 13A 拦截的命中分支
import { createState, getSessionState } from "../lib/core/state.js";
import { guardDecision } from "../lib/core/guard-core.js";
import { loadRules } from "../lib/core/parser.js";
import { understandAll } from "../lib/core/understander.js";
import { writeTargetPathsFromCommand, isSensitiveToolCall, isReadOnlyTool, DESTRUCTIVE_CMD } from "../lib/core/patterns.js";

process.env.DSH_HOME = "D:\\DeepSeek harness\\.dsh";
process.env.DSH_WORKSPACE = "D:\\DeepSeek harness\\dsh-project";

const cmd = `$env:HTTPS_PROXY = "http://127.0.0.1:7890"; $env:HTTP_PROXY = "http://127.0.0.1:7890"; gh release create v0.4.1 "D:\\DeepSeek harness\\dsh-project\\projects\\oss\\dsh-rule-engine\\dsh-rule-engine-0.4.1.tgz" --repo jilian-dsh/dsh-rule-engine --title "dsh-rule-engine v0.4.1" --notes "## v0.4.1

- Rule 9 PS7 semantics: BOM hard-block narrowed to explicit -Encoding utf8BOM; utf8/utf8NoBOM (no BOM) allowed; removed the PS5.1-era Chinese-.ps1-must-have-BOM check
- P0-1: write-target extraction reads only the adjacent argument of -Path/-Destination (variable targets no longer capture unrelated later paths)
- P0-1b: 2>&1 / 2>$null no longer treated as write redirects (read-only commands touching protected filenames were mis-blocked)
- version-guard: allow same-line inline version changes (README badge updates)
- disabled-rules sync with dsh-rules-manager
- LLM incremental understanding after AGENTS.md changes (deduped)
- unified home resolution via @deepseek-ai/dsh-home-paths; audit log lazy trim; update-check fetch timeouts"`;

console.log("DESTRUCTIVE_CMD:", DESTRUCTIVE_CMD.test(cmd));
console.log("writeTargets:", JSON.stringify(writeTargetPathsFromCommand(cmd)));
console.log("isReadOnlyTool:", isReadOnlyTool("pwsh", { command: cmd }));
console.log("isSensitiveToolCall:", isSensitiveToolCall("pwsh", { command: cmd }));

const parsed = loadRules();
const state = createState();
state.configs = understandAll(parsed.rules);
const session = getSessionState(state, "test");
const exec = { name: "pwsh", arguments: { command: cmd, description: "gh release" }, agent: { session: { id: "test" } } };
const hit = guardDecision(state, exec, Date.now());
console.log("guardDecision:", hit ? hit.reason : "PASS");
