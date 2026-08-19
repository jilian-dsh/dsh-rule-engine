import assert from "node:assert/strict";
import {
  BOM_WRITE,
  absolutePathTokens,
  auditOutputFailed,
  auditOutputPassed,
  backupPathsFromTool,
  extractCopyPaths,
  isAssemblyMutationTool,
  isAuditCommand,
  isHighRiskEntryFile,
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
assert.equal(isAuditCommand("node scripts/audit-mount-consistency.mjs --profile web 2>&1 | Select-String -Pattern 'RESULT'"), true, "filtered audit command still detected as audit");
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

// v3.74：程序路径误判修复——命令首 token 是 .exe 程序，不是文件目标
assert.deepEqual(absolutePathTokens("& 'D:\\GitHubCLI\\gh.exe' pr create --repo a/b"), [], "gh.exe is executable, not a file target");
assert.deepEqual(absolutePathTokens("D:\\GitHubCLI\\gh.exe pr create"), [], "bare exe path excluded");
assert.deepEqual(absolutePathTokens("Copy-Item 'D:\\a\\b.txt' 'D:\\c\\d.txt'"), ["D:\\a\\b.txt", "D:\\c\\d.txt"], "non-exe absolute paths still extracted");
assert.deepEqual(absolutePathTokens("cmd /c dsh --profile web --dump-config"), [], "cmd.exe not a file target");

// v3.74：审计输出关键字——INCONSISTENT 与 [MISSING] 判定为失败
assert.equal(auditOutputPassed("RESULT: INCONSISTENT — MUST FIX BEFORE RESTART"), false, "INCONSISTENT not pass");
assert.equal(auditOutputFailed("RESULT: INCONSISTENT — MUST FIX BEFORE RESTART"), true, "INCONSISTENT detected as fail");
assert.equal(auditOutputFailed("[MISSING] dsh-rule-engine not in bundles"), true, "MISSING detected as fail");
assert.equal(auditOutputPassed("RESULT: MOUNT CONSISTENT — SAFE TO RESTART"), true, "consistent still pass");

// 修正版 #1：URL 不能误判为写路径
assert.deepEqual(
  absolutePathTokens("curl -o D:\\tmp\\readme.md https://raw.githubusercontent.com/a/b/README.md"),
  ["D:\\tmp\\readme.md"],
  "URL scheme token excluded from absolute path extraction"
);
assert.deepEqual(
  absolutePathTokens("Invoke-WebRequest -Uri https://example.com/a -OutFile D:\\tmp\\a.json"),
  ["D:\\tmp\\a.json"],
  "URL not treated as path in IWR"
);

// 修正版 #2：脚本/值字符串里的路径不能当写目标
assert.deepEqual(
  writeTargetPathsFromCommand("Set-Content -Path 'D:\\a.txt' -Value \"createRequire('D:/npm-global/x/package.json')\""),
  ["D:\\a.txt"],
  "Set-Content target is -Path only, not value string path"
);
assert.deepEqual(
  writeTargetPathsFromCommand("node -e \"createRequire('D:/npm-global/x/package.json')\""),
  [],
  "node script content path is not a write target"
);

// 修正版 #6：高风险运行入口文件识别
assert.equal(isHighRiskEntryFile("D:\\DeepSeek harness\\dsh-desktop\\main.js"), true, "Electron main.js is high-risk entry");
assert.equal(isHighRiskEntryFile("D:\\npm-global\\dsh.cmd"), true, "dsh.cmd CLI shim is high-risk entry");
assert.equal(isHighRiskEntryFile("D:\\npm-global\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"), true, "CLI bin.js is high-risk entry");
assert.equal(isHighRiskEntryFile("D:\\DeepSeek harness\\dsh-project\\projects\\oss\\dsh-rule-engine\\lib\\index.js"), false, "ordinary plugin index.js is not auto high-risk entry");

// P0-1：flag 只取紧邻参数值，不再扫描剩余整条命令——
// `-Path $var` 后跟的无关只读绝对路径不得被误判为写目标（真实误拦回归）
assert.deepEqual(
  writeTargetPathsFromCommand("New-Item -ItemType Directory -Force -Path $c | Out-Null; Get-Item 'D:\\x\\y\\registry-snapshot.json'"),
  [],
  "-Path $var must not capture later unrelated read-only path"
);
assert.deepEqual(
  writeTargetPathsFromCommand("Set-Content -Path $p -Value 'D:\\z\\v.txt'"),
  [],
  "variable -Path value not resolvable -> no write target"
);
// P0-1：紧邻的引号/无引号绝对路径仍然正确提取
assert.deepEqual(
  writeTargetPathsFromCommand("Set-Content -Path 'D:\\a b\\c.txt' -Value 'x'"),
  ["D:\\a b\\c.txt"],
  "quoted adjacent -Path still extracted"
);
assert.deepEqual(
  writeTargetPathsFromCommand("New-Item -Path D:\\tmp\\x.txt -ItemType File"),
  ["D:\\tmp\\x.txt"],
  "unquoted adjacent -Path still extracted"
);
// P0-1：copy-item 分支不受影响（仍只取 Destination）
assert.deepEqual(
  writeTargetPathsFromCommand("Copy-Item 'D:\\src\\a.txt' -Destination 'D:\\dst\\b.txt'").join("|"),
  "D:\\dst\\b.txt",
  "Copy-Item destination still extracted"
);

// P0-1b：2>&1 / 2>$null 的 stderr 重定向不算写命令（否则只读命令 + 受保护文件名会被 13A 误拦）
assert.equal(isReadOnlyCommand("Get-Content -Path 'D:\\a\\AGENTS.md' 2>&1"), true, "2>&1 not a write redirect");
assert.equal(isReadOnlyCommand("Get-Content 'D:\\a\\rule-understanding.json' 2>$null"), true, "2>$null not a write redirect");
assert.equal(isReadOnlyCommand("Get-Item 'D:\\a\\settings.yaml' -ErrorAction SilentlyContinue"), true, "read-only without redirect still read-only");
assert.equal(isReadOnlyCommand("echo x > D:\\a.txt"), false, "plain > redirect is a write");
assert.equal(isReadOnlyCommand("echo x >> D:\\a.txt"), false, "plain >> redirect is a write");

// 规则 9 PS7 语义（2026-08-19）：仅拦显式 utf8BOM；utf8 / utf8NoBOM 均无 BOM，合规
assert.equal(BOM_WRITE.test("Set-Content -Path x.json -Value '{}' -Encoding utf8BOM"), true, "utf8BOM write blocked");
assert.equal(BOM_WRITE.test("Out-File -FilePath x.yaml -Encoding UTF8BOM"), true, "UTF8BOM (case-insensitive) blocked");
assert.equal(BOM_WRITE.test("Set-Content -Path x.json -Value '{}' -Encoding UTF8"), false, "PS7 utf8 (no BOM) allowed");
assert.equal(BOM_WRITE.test("Set-Content -Path x.json -Value '{}' -Encoding utf8NoBOM"), false, "utf8NoBOM allowed");

console.log("patterns.test.js PASS");
