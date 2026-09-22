// dry-run-readonly.test.mjs — 件 E 先红（2026-09-22，session-eb606909）
//   件 E：带 --dry-run 且不含写盘 cmdlet 的 node 调用视为只读（isReadOnlyCommand → true）。
//   ① node … bump（无 --dry-run）      → false（真 bump 不得放行）
//   ② node x.mjs --dry-run ＋ Set-Content 同一条命令 → false（写盘判据先于 dry-run 豁免）
//   ③ git commit                        → false（本件不动 git push/commit）
//   ④ git push                          → false（同上）
//   ⑤ node … bump --dry-run             → true（先红主项：现盘为 false）
// 注：本文件**不 import** index.js（避免其启动注入／副作用）；只读 isReadOnlyCommand 纯函数。
import assert from "node:assert/strict";
import { isReadOnlyCommand } from "../lib/core/patterns.js";

// ── ① 真 bump（无 --dry-run）→ 非只读 ──
const realBump = "node scripts/example-manual-write.mjs bump";
assert.equal(
  isReadOnlyCommand(realBump),
  false,
  `真 bump 不得放行：「${realBump}」应为 false`
);

// ── ② --dry-run 与写盘 cmdlet 同条 → 仍非只读 ──
const mixed = 'node x.mjs --dry-run; Set-Content -Path D:\\tmp\\a.txt -Value b';
assert.equal(
  isReadOnlyCommand(mixed),
  false,
  "同时含写盘 cmdlet 与 --dry-run 的仍应 false（写表先于 dry-run 豁免）"
);

// ── ③ git commit → 非只读（本件不改 git 面）──
assert.equal(isReadOnlyCommand('git commit -m "x"'), false, "git commit 应为 false");

// ── ④ git push → 非只读（同上）──
assert.equal(isReadOnlyCommand("git push origin main"), false, "git push 应为 false");

// ── ⑤ 先红主项：node … bump --dry-run → 只读 ──
const dryRun = "node scripts/example-manual-write.mjs bump --dry-run";
assert.equal(
  isReadOnlyCommand(dryRun),
  true,
  `件 E：带 --dry-run 的只读预览应放行（现盘 false）：「${dryRun}」`
);

console.log("dry-run-readonly.test.mjs PASS");
