// verify-copyitem2.mjs —— 拆解无 -Force 的 Copy-Item 敏感判定
import { isSensitiveToolCall, isReadOnlyTool, writeTargetPathsFromCommand, SENSITIVE_CMD } from "../lib/core/patterns.js";
process.env.DSH_HOME = "D:\\DeepSeek harness\\.dsh";
process.env.DSH_WORKSPACE = "D:\\DeepSeek harness\\dsh-project";

const cmd = "Copy-Item 'D:/a.txt' 'D:/DeepSeek harness/dsh-project/new-file-copy.json'";
console.log("SENSITIVE_CMD:", SENSITIVE_CMD.test(cmd));
console.log("writeTargets:", JSON.stringify(writeTargetPathsFromCommand(cmd)));
console.log("isReadOnlyTool:", isReadOnlyTool("pwsh", { command: cmd }));
console.log("isSensitiveToolCall:", isSensitiveToolCall("pwsh", { command: cmd }));
if (SENSITIVE_CMD.test(cmd)) {
  const m = cmd.match(/copy-item\s+[^\n]*?(?:-\s*force|overwrite)/i);
  console.log("SENSITIVE match:", m && m[0]);
}
