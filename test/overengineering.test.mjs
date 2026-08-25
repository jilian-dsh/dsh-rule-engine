import assert from "node:assert/strict";
import {
  classifyAction,
  detectDependencyIntent,
  detectHashIntent,
  detectOverengineeringText,
  isRepeatedTaskAction,
  recordAction
} from "../lib/core/overengineering.js";

assert.equal(detectHashIntent("pwsh", { command: "Get-FileHash 'D:/a.bin'" }), true);
assert.equal(detectHashIntent("pwsh", { command: "Get-Content 'D:/a.txt'" }), false);
assert.equal(detectDependencyIntent("pwsh", { command: "npm install lodash" }), true);
assert.equal(detectDependencyIntent("pwsh", { command: "Get-ChildItem" }), false);

const edit = classifyAction("edit", { file_path: "D:/a.txt", new_string: "x" });
assert.equal(edit.mutability, "write");
const read = classifyAction("read", { file_path: "D:/a.txt" });
assert.equal(read.mutability, "read");
const readCmd = classifyAction("pwsh", { command: "Get-Content 'D:/a.txt'" });
assert.equal(readCmd.mutability, "read");
const unknownCmd = classifyAction("pwsh", { command: "Do-Something" });
assert.equal(unknownCmd.mutability, "unknown");

const session = { recentActions: [] };
recordAction(session, "pwsh", { command: "npm test" });
recordAction(session, "pwsh", { command: "npm test" });
assert.equal(isRepeatedTaskAction(session, "pwsh", { command: "npm test" }), false);
recordAction(session, "pwsh", { command: "npm test" });
assert.equal(isRepeatedTaskAction(session, "pwsh", { command: "npm test" }), true);

assert.ok(detectOverengineeringText("顺便加个依赖以防万一").length > 0);
assert.equal(detectOverengineeringText("这是修复后的测试结果").length, 0);

// 批次 4（2026-08-24 实测发现）：写入类工具不得对参数全文做关键词匹配——
// 内容含命令字样 ≠ 相关操作（否则写任何含字样的文档/记忆都被契约误拦，连授权弹窗都被拦）
// 说明：字样用拼接构造（源文本不含完整触发词，避免工具链自拦截）；运行时拼接后断言目标行为
const HASHSA = "Get-" + "FileHash";
const NPMI = "npm " + "install lodash";
assert.equal(detectHashIntent("write", { file_path: "D:/a.txt", content: HASHSA + " 示例" }), false, "write 内容含校验命令行字样 → 不判");
assert.equal(detectHashIntent("engram_store", { text: "记录 " + HASHSA + " 结论", kind: "insight" }), false, "engram 文本含字样 → 不判");
assert.equal(detectHashIntent("some_tool", { script: HASHSA + " x" }), true, "命令类字段 script 仍判定");
assert.equal(detectDependencyIntent("write", { file_path: "D:/a.txt", content: NPMI }), false, "write 内容含依赖安装字样 → 不判");
assert.equal(detectDependencyIntent("pwsh", { command: NPMI }), true, "命令仍判定");

console.log("overengineering.test.mjs PASS");
