import assert from "node:assert/strict";
import { computeBaselineGap, loadBaselineFile } from "../lib/core/baseline.js";
import { existsSync, unlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── computeBaselineGap：纯函数判定 ────────────────────────────────

// 全 implemented + 完成声明 → 无 gap
let gap = computeBaselineGap("重构方案全部完成", [
  { id: "RB-01", title: "a", status: "implemented" },
  { id: "RB-02", title: "b", status: "implemented" }
]);
assert.equal(gap, null, "全 implemented 不应有 gap");

// 存在 planned + 完成声明 → gap 列出未落地项
gap = computeBaselineGap("重构方案全部完成", [
  { id: "RB-01", title: "分点粒度授权", status: "planned" },
  { id: "RB-02", title: "revoke 清理", status: "implemented" }
]);
assert.ok(gap, "含 planned 应有 gap");
assert.equal(gap.count, 1);
assert.ok(gap.pending[0].includes("RB-01"));

// 无完成声明词 → 不误报
gap = computeBaselineGap("我更新了配置文件的完成度字段", [
  { id: "RB-01", title: "a", status: "planned" }
]);
assert.equal(gap, null, "非完成声明不应误报");

// 空基线/空文本 → null
assert.equal(computeBaselineGap("", [{ id: "x", status: "planned" }]), null);
assert.equal(computeBaselineGap("任务全部完成", []), null);
assert.equal(computeBaselineGap("任务全部完成", null), null);

// ── loadBaselineFile：文件读取（fail-closed）─────────────────────

const dir = mkdtempSync(join(tmpdir(), "baseline-test-"));
const good = join(dir, "good.json");
const bad = join(dir, "bad.json");
const missing = join(dir, "missing.json");

writeFileSync(good, JSON.stringify({ schemaVersion: 1, requirements: [{ id: "RB-01", status: "planned" }] }), "utf8");
writeFileSync(bad, "{ broken json", "utf8");

// 正常
let loaded = loadBaselineFile(good);
assert.equal(loaded.ok, true);
assert.equal(loaded.items.length, 1);

// 损坏 → ok:false（绝不以损坏数据静默判定）
loaded = loadBaselineFile(bad);
assert.equal(loaded.ok, false);
assert.ok(loaded.error);

// 缺失 → ok:false
loaded = loadBaselineFile(missing);
assert.equal(loaded.ok, false);

// 清理
unlinkSync(good);
unlinkSync(bad);
try { unlinkSync(missing); } catch { /* ignore */ }

console.log("requirements-baseline.test.js PASS");