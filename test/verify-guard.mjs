// verify-guard.mjs —— 验证修复后代码对「New-Item -Path $c + Get-Item 外部路径」命令的裁决
import { createState, getSessionState } from "../lib/core/state.js";
import { understandRule } from "../lib/core/understander.js";
import { guardDecision } from "../lib/core/guard-core.js";
import { writeTargetPathsFromCommand } from "../lib/core/patterns.js";

process.env.DSH_HOME = "D:\\__nonexistent__\\guard-verify";
process.env.DSH_WORKSPACE = "D:\\DeepSeek harness\\dsh-project";

const cmd = `$c = "D:\\DeepSeek harness\\dsh-project\\archive\\npm-cache-tmp3"; New-Item -ItemType Directory -Force -Path $c | Out-Null; Get-Item "D:\\DeepSeek harness\\.dsh\\profiles\\web\\node_modules\\dshmarket\\data\\registry-snapshot.json" | Select-Object Name, Length`;

console.log("writeTargetPathsFromCommand =>", JSON.stringify(writeTargetPathsFromCommand(cmd)));

const state = createState();
state.configs = [
  understandRule({
    index: "13A",
    title: "备份与验证闭环（执行等级：A+D）",
    level: "A+D",
    body: "- **触发**：删除/覆盖/迁移/批量删除/修改配置文件等操作。\n- **检查**：删除/覆盖类操作且本会话内无对应备份动作 → 拒绝。\n- **动作**：硬拦项拒绝。\n- **豁免**：只读。"
  })
];
const session = getSessionState(state, "test");
session.backups = [];

const exec = { name: "pwsh", arguments: { command: cmd, description: "验证 P0-1 修复" }, agent: { session: { id: "test" } } };
const hit = guardDecision(state, exec, Date.now());
console.log("guardDecision =>", hit ? hit.reason : "PASS (no denial)");
