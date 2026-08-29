// analysis-channel.test.mjs - 0.5.10 分析通道 / 写类判定单真源 / 已知坑召回（纯函数测试）
import test from "node:test";
import assert from "node:assert";
const {
  isReadOnlyCommand,
  isMutationCommand,
  isAnalysisOp,
  isAnalysisScratchPath,
  extractAnalysisScratchPaths,
  matchKnownPitfall
} = await import("../lib/core/patterns.js");

// ── 写类判定（建议3 修复：Write-Output 不再被 write 子串误杀）──
test("isMutationCommand：Write-Output 不误杀", () => {
  assert.equal(isMutationCommand("Write-Output '=== x ==='; Select-String -Path a.md -Pattern x"), false, "Write-Output（只读输出）不算写");
  assert.equal(isMutationCommand("Get-Content a | Select-String b"), false);
});
test("isMutationCommand：真写命令命中", () => {
  assert.equal(isMutationCommand("Set-Content a b"), true);
  assert.equal(isMutationCommand("Copy-Item a b"), true);
  assert.equal(isMutationCommand("git push origin main"), true);
  assert.equal(isMutationCommand("Remove-Item a"), true);
});

// ── 只读多行（建议2：ForEach-Object 补词表）──
test("isReadOnlyCommand：多行只读组合", () => {
  const cmd = "Get-ChildItem 'D:\\x' -Filter '*.md' | Select-String -Pattern 'legal' | ForEach-Object { $_.Line.Trim() }";
  assert.equal(isReadOnlyCommand(cmd), true, "读+筛选+forEach 组合=只读");
  assert.equal(isReadOnlyCommand("Get-ChildItem x; Set-Content y z"), false, "含写仍判写");
});

// ── 临时区判定 ──
test("isAnalysisScratchPath：临时区段识别", () => {
  assert.equal(isAnalysisScratchPath("D:\\example workspace\\dsh-project\\logs\\rl.jsonl"), true);
  assert.equal(isAnalysisScratchPath("logs/out.txt"), true);
  assert.equal(isAnalysisScratchPath(".analysis-tmp/x.json"), true);
  assert.equal(isAnalysisScratchPath(".backups/trash-20260827"), true);
  assert.equal(isAnalysisScratchPath("D:\\x\\documents\\a.txt"), false);
});

// ── 分析通道判定 ──
test("isAnalysisOp：脚本区不再按目录豁免（0.5.11 语义豁免移除）", () => {
  // 0.5.11：脚本名判不了脚本干什么（release-plugin.mjs 曾借"scripts/ 下"放行）——命令文本无
  // 写特征/无临时区目标时不再自动"分析"；语义判给模型。执行类脚本回到正常授权判定。
  assert.equal(
    isAnalysisOp("node", { command: "node 'D:\\example workspace\\dsh-project\\scripts\\unzstd-full.mjs' a.zstd logs\\out.jsonl" }),
    false,
    "node scripts/ 脚本（无写特征）= 不再放行，回正常判定"
  );
  assert.equal(
    isAnalysisOp("node", { command: "node 'D:\\example workspace\\dsh-project\\scripts\\release-plugin.mjs'" }),
    false,
    "执行类脚本不再借分析通道放行"
  );
  assert.equal(
    isAnalysisOp("node", { command: "node 'D:\\x\\bin\\y.mjs' out.jsonl" }),
    false,
    "非 scripts/ 目录脚本不豁免"
  );
});
test("isAnalysisOp：临时区写（无受保护名）", () => {
  assert.equal(
    isAnalysisOp("pwsh", { command: "Set-Content 'D:\\example workspace\\dsh-project\\logs\\rl.jsonl' '[1,2]'" }),
    true,
    "输出到 logs/ = 分析放行"
  );
  assert.equal(
    isAnalysisOp("pwsh", { command: "Set-Content 'C:\\Users\\x\\.dsh\\skills\\example-usage-manual\\SKILL.md' y" }),
    false,
    "受保护文件不豁免"
  );
  assert.equal(
    isAnalysisOp("pwsh", { command: "Remove-Item 'logs\\x.jsonl'" }),
    false,
    "删除不入分析豁免（13A 红线）"
  );
});

// 0.5.10 建议：远程下载到临时区（调研场景）
test("isAnalysisOp：下载到临时区", () => {
  assert.equal(
    isAnalysisOp("pwsh", { command: "curl.exe -sL -o 'D:\\example workspace\\dsh-project\\logs\\plugin.tgz' https://x.example/a.tgz" }),
    true,
    "curl -o 临时区 = 分析放行"
  );
  assert.equal(
    isAnalysisOp("pwsh", { command: "curl.exe -sL -o 'C:\\Users\\x\\Downloads\\a.tgz' https://x.example/a.tgz" }),
    false,
    "下载到非临时区不豁免"
  );
});

// ── 已知坑召回 ──
test("matchKnownPitfall：特征命中/未命中", () => {
  assert.ok(matchKnownPitfall("Error: SEC_E_NO_CREDENTIALS (0x8009030e)"));
  assert.ok(matchKnownPitfall("npm error code ECONNREFUSED ... 127.0.0.1:7890"));
  assert.equal(matchKnownPitfall("Error: HTTP 404"), null);
});
