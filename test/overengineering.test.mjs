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
console.log("overengineering.test.mjs PASS");
