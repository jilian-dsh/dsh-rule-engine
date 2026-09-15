// guard-quality.test.mjs — C4（批 3，2026-09-15）：「/guard quality」查询入口
//
// 由来（ESR tsk_873e5d48 复核）：质量账本**机制**0.6.3 已入 lib/core/quality-ledger.js
// （taskSignature / recordQuality / qualityTrend / loadLedger），但**没有任何查询入口**——
// lib/index.js 与 lib/service.js 里 grep "quality" = 0 命中，机制写了却没人能用它。
//
// 本测试锁死两件（这两件正是"入口缺失"的判据）：
//   ① 解析器认识该子命令——parseCommand 是**白名单**解析器（源码注释：新子命令必须在此登记，否则落 invalid）；
//   ② 出现在 COMMAND_SPECS——它是 /guard 子命令的**单一真源**，hint 与完整帮助都由它派生。
import assert from "node:assert/strict";

const { parseCommand, COMMAND_SPECS } = await import("../lib/index.js");

// ① 解析白名单
assert.equal(typeof parseCommand, "function", "parseCommand 应被导出（否则外部无法单测命令解析）");
assert.equal(
  parseCommand("quality").kind,
  "quality",
  "★ /guard quality 应被解析为 quality 子命令（实现前落 invalid → 必红）"
);
assert.equal(parseCommand("quality extra").kind, "invalid", "带多余参数应落 invalid（严格白名单，不静默忽略）");

// ② 单一真源登记（hint 与 USAGE 由 COMMAND_SPECS 派生，漏登记则该命令在帮助里不可见）
assert.ok(Array.isArray(COMMAND_SPECS), "COMMAND_SPECS 应被导出");
assert.ok(
  COMMAND_SPECS.some((s) => s.name === "quality"),
  "COMMAND_SPECS 应含 quality 条目（否则 hint/帮助里看不到它）"
);

console.log("guard-quality.test PASS（解析白名单 + 单一真源登记）");
