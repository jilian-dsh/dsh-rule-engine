import assert from "node:assert/strict";
import {
  absolutePathTokens,
  auditOutputFailed,
  auditOutputPassed,
  backupPathsFromTool,
  extractCopyPaths,
  isAssemblyMutationTool,
  isAuditCommand,
  isReadOnlyCommand,
  writeTargetPathsFromCommand
} from "../lib/core/patterns.js";

// 带空格引号路径
const cmd = "Copy-Item -LiteralPath 'D:\\DeepSeek harness\\a.jsonl.zstd' -Destination 'D:\\DeepSeek harness\\b.jsonl.zstd' -Force";
const paths = extractCopyPaths(cmd);
assert.ok(paths, "quoted paths extracted");
assert.equal(paths.source, "D:\\DeepSeek harness\\a.jsonl.zstd");
assert.equal(paths.dest, "D:\\DeepSeek harness\\b.jsonl.zstd");

// 普通 Copy-Item 到非备份目标（如覆盖目标文件）不产生备份记录
const bp = backupPathsFromTool("pwsh", { command: cmd });
assert.equal(bp, null, "non-backup destination not recorded as backup");

// 备份到 .bak 目标时才记录 源 -> .bak
const backupCmd = "Copy-Item -LiteralPath 'D:\\DeepSeek harness\\a.jsonl.zstd' -Destination 'D:\\DeepSeek harness\\a.jsonl.zstd.bak' -Force";
const bp2 = backupPathsFromTool("pwsh", { command: backupCmd });
assert.ok(bp2, "backup to .bak recorded");
assert.ok(bp2.targetPath.includes("DeepSeek harness"), "target path keeps spaces");
assert.ok(bp2.backupPath.includes("DeepSeek harness"), "backup path keeps spaces");

// 相对/截断路径不再记录（避免脏备份记录）
const bad = backupPathsFromTool("pwsh", { command: "Copy-Item 'relative/file' 'relative/backup'" });
assert.equal(bad, null, "relative paths not recorded");

// 规则 27 辅助函数
assert.equal(isAssemblyMutationTool("dev_install_package", { dir: "D:/x" }), true, "dev_install_package is assembly mutation");
assert.equal(isAssemblyMutationTool("dev_inject_plugin", { dir: "D:/x" }), true, "dev_inject_plugin is assembly mutation");
assert.equal(isAssemblyMutationTool("read", { file_path: "D:/x" }), false, "read is not assembly mutation");
assert.equal(isAssemblyMutationTool("edit", { file_path: "D:/DeepSeek harness/.dsh/profiles/web/cordis.patch.yml", old_string: "a", new_string: "b" }), true, "edit cordis.patch.yml is assembly mutation");
assert.equal(isAssemblyMutationTool("pwsh", { command: "Set-Content -Path cordis.patch.yml -Value 'x'" }), true, "pwsh writing cordis.patch.yml is assembly mutation");
assert.equal(isAuditCommand("node _extract/audit-mount-consistency.mjs --profile web"), true, "audit command detected");
assert.equal(isAuditCommand("Get-Content _extract/audit-mount-consistency.mjs"), false, "reading audit script is not audit execution");
assert.equal(auditOutputPassed("RESULT: MOUNT CONSISTENT — SAFE TO RESTART"), true, "audit pass detected");
assert.equal(auditOutputPassed("RESULT: DUPLICATES FOUND — MUST FIX BEFORE RESTART"), false, "duplicates not pass");
assert.equal(auditOutputFailed("RESULT: DUPLICATES FOUND — MUST FIX BEFORE RESTART"), true, "duplicates detected");

// 反馈修复：只读命令不误判为写；Copy-Item 只把 Destination 当写目标；带空格引号路径完整提取
assert.equal(isReadOnlyCommand("Get-Content -Path 'C:\\Users\\x\\skill\\SKILL.md'"), true, "Get-Content is read-only");
assert.equal(isReadOnlyCommand("Get-Content 'a' | Set-Content 'b'"), false, "pipeline with Set-Content is not read-only");
assert.equal(writeTargetPathsFromCommand("Copy-Item 'D:\\src\\a.txt' -Destination 'D:\\dst\\b.txt'").join("|"), "D:\\dst\\b.txt", "Copy-Item write target is destination only");
assert.deepEqual(absolutePathTokens("Remove-Item -LiteralPath 'D:\\DeepSeek harness\\x\\y.txt'"), ["D:\\DeepSeek harness\\x\\y.txt"], "quoted space path fully extracted");
assert.equal(writeTargetPathsFromCommand("Set-Content -Path 'D:\\a b\\c.txt' -Value 'x'").join("|"), "D:\\a b\\c.txt", "Set-Content quoted path extracted");

console.log("patterns.test.js PASS");
