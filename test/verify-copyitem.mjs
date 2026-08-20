// verify-copyitem.mjs —— 复现文档所述：Copy-Item 源路径长于目标路径时 13A 误判
import { createState, getSessionState } from "../lib/core/state.js";
import { guardDecision } from "../lib/core/guard-core.js";
import { loadRules } from "../lib/core/parser.js";
import { understandAll } from "../lib/core/understander.js";
import { operationOf } from "../lib/core/authorization.js";
import { writeTargetPathsFromCommand } from "../lib/core/patterns.js";

process.env.DSH_HOME = "D:\\DeepSeek harness\\.dsh";
process.env.DSH_WORKSPACE = "D:\\DeepSeek harness\\dsh-project";

// 文档复现命令：源路径（长，存在于 .venv 深层）-> 目标路径（短，工作区，不存在）
const cmd = `Copy-Item 'D:\\Comfy-Desktop\\ComfyUI-Installs\\ComfyUI\\ComfyUI\\.venv\\Lib\\site-packages\\comfyui_workflow_templates_json\\templates\\video_minimax_h3_t2v.json' 'D:\\DeepSeek harness\\dsh-project\\video_minimax_h3_t2v_local.json' -Force`;

console.log("writeTargetPathsFromCommand:", JSON.stringify(writeTargetPathsFromCommand(cmd)));
const op = operationOf("pwsh", { command: cmd });
console.log("operationOf.pathPrefix:", op.pathPrefix);
console.log("operationOf.pathPrefixes:", JSON.stringify(op.pathPrefixes));

const parsed = loadRules();
const state = createState();
state.configs = understandAll(parsed.rules);
const session = getSessionState(state, "test");
const exec = { name: "pwsh", arguments: { command: cmd, description: "复现文档" }, agent: { session: { id: "test" } } };
const hit = guardDecision(state, exec, Date.now());
console.log("guardDecision:", hit ? hit.reason : "PASS");
