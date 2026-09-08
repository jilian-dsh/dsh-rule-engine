// audit.test.js — 审计裁剪与月归档（2026-09-08 第二批 §1.1-②）
// 隔离：makeTempHome 设 DSH_HOME；构造 >2MB 假日志 → 触发裁剪 → 断言月归档文件=被裁头部
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempHome, cleanupTempHome } from "./helpers.mjs";

const dir = makeTempHome();

// 动态 import：确保 DSH_HOME 生效后再加载模块（路径函数按 env 解析）
const { audit } = await import("../lib/core/audit.js");
const { auditFilePath } = await import("../lib/core/paths.js");

const p = auditFilePath();
const bigLine = JSON.stringify({ ts: new Date().toISOString(), pad: "x".repeat(1000) });
let content = "";
for (let i = 0; i < 2200; i += 1) content += bigLine + "\n"; // ≈2.2MB
writeFileSync(p, content, "utf8");

// 触发惰性裁剪（每 32 次 append 检查一次）
for (let i = 0; i < 32; i += 1) audit({ event: "audit-test", i });

const mainText = readFileSync(p, "utf8");
assert.ok(mainText.length < 2 * 1024 * 1024, "主日志已裁剪到 <2MB");

const ym = new Date().toISOString().slice(0, 7).replace("-", "");
const arc = join(dir, "logs", "rule-engine-archive", `log-${ym}.jsonl`);
assert.ok(existsSync(arc), "月归档文件存在");
const arcText = readFileSync(arc, "utf8");
assert.ok(arcText.includes('"pad"'), "归档含被裁头部内容");
assert.ok(arcText.split("\n").filter(Boolean).length > 1000, "归档含大量被裁行（头部整体）");

// 未超限时不归档（小日志再触发一次裁剪检查 → 归档行数不变）
const before = readFileSync(arc, "utf8").length;
writeFileSync(p, '{"ts":"2026-01-01T00:00:00.000Z","small":true}\n', "utf8");
for (let i = 0; i < 32; i += 1) audit({ event: "audit-test-small", i });
assert.equal(readFileSync(arc, "utf8").length, before, "未超限不写归档");

cleanupTempHome(dir);
console.log("audit.test.js PASS");
