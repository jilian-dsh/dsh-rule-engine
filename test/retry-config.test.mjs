// retry-config.test.mjs — 域 2 第五枪（2026-09-22）：规则 1 重试豁免词（guard-core L624）迁 retryExempt
//   ① LEGACY ＝现盘中文源逐字快照；② 夹具与 LEGACY 逐字一致；
//   ③ 行为锁：请重试→true；请继续→false（禁裸「继续」）；再试一次／再来一次／继续试／再试→true；
//   ④ 还原内置后中文「请重试」不命中、英文 retry（带词边界）命中；自重置。
// 注：本文件**不 import** index.js（其启动注入会清 override），**不 import** guard.test.mjs。
import assert from "node:assert/strict";
import { isRetryExemptText, setRetryExempt } from "../lib/core/guard-core.js";
import { TEST_RETRY_EXEMPT_ZH, useChineseRetryExempt } from "./helpers.mjs";

// ── ① 迁移前基线（现盘逐字快照）──
const LEGACY = "重试|再试一次|再来一次|继续试|再试";

// ── ② 夹具与基线逐字一致 ──
assert.equal(TEST_RETRY_EXEMPT_ZH, LEGACY, "夹具 retryExempt 应与现盘基线逐字一致");

// ── ③ 配置层生效（自注入）──
useChineseRetryExempt();
assert.equal(isRetryExemptText("请重试"), true, "请重试 → 豁免");
assert.equal(isRetryExemptText("请继续"), false, "请继续 → 不豁免（禁裸「继续」）");
for (const w of ["再试一次", "再来一次", "继续试", "再试"]) {
  assert.equal(isRetryExemptText(w), true, `${w} → 豁免`);
}

// ── ④ 还原内置（空＝还原）后：中文不命中、英文 retry 带词边界命中 ──
setRetryExempt("");
assert.equal(isRetryExemptText("请重试"), false, "还原内置后中文「请重试」不命中");
assert.equal(isRetryExemptText("retry"), true, "还原内置后英文 retry 命中");
assert.equal(isRetryExemptText("retrying"), false, "词边界：retrying 不命中");

// 自重置（供后续测试／单独运行；run-all 循环亦会重申各夹具）
setRetryExempt("", { clear: true });

console.log("retry-config.test.mjs PASS");
