// contract-analysis-class.test.mjs — 件 A 先红（2026-09-22，session-eb606909）
//   件 A：classifyAction 在默认 unknown 之前消费 toolClass()==="analysis"。
//   ① 反例（必须留）：answer 下 pwsh 跑 node … example-manual-write.mjs bump --dry-run → mutability 仍为 unknown
//      （证明件 E 的 dry-run 面没被并进件 A）
//   ② 先红主项：ask_user_question → mutability 应为 read（现盘＝unknown → MUTABILITY_UNPROVEN）
//   ③ 先红主项：dev_plugin_status → mutability 应为 read（同上）
// 注：本文件**不 import** index.js（避免其启动注入／副作用）；只读 classifyAction 纯函数。
import assert from "node:assert/strict";
import { classifyAction } from "../lib/core/overengineering.js";

// ── ① 反例：pwsh ＋ --dry-run → 仍为 unknown（件 A 不得顺带放行它；那是件 E 的面）──
const dryRunCmd = "node scripts/example-manual-write.mjs bump --dry-run";
const dryRun = classifyAction("pwsh", { command: dryRunCmd });
assert.equal(
  dryRun.mutability,
  "unknown",
  `反例：pwsh 跑「${dryRunCmd}」的 mutability 应为 unknown（现盘即如此；件 A 不得改动）`
);

// ── ② 先红：ask_user_question（ANALYSIS_TOOLS，tool-catalog.js L42）──
const ask = classifyAction("ask_user_question", {});
assert.equal(
  ask.mutability,
  "read",
  "件 A：ask_user_question 的 mutability 应为 read（现盘 unknown → 契约 deny MUTABILITY_UNPROVEN）"
);

// ── ③ 先红：dev_plugin_status（ANALYSIS_TOOLS，tool-catalog.js L21）──
const devStatus = classifyAction("dev_plugin_status", {});
assert.equal(
  devStatus.mutability,
  "read",
  "件 A：dev_plugin_status 的 mutability 应为 read（现盘 unknown → 契约 deny MUTABILITY_UNPROVEN）"
);

console.log("contract-analysis-class.test.mjs PASS");
