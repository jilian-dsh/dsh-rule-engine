import assert from "node:assert/strict";
import { extractCopyPaths, backupPathsFromTool } from "../lib/core/patterns.js";

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

console.log("patterns.test.js PASS");
