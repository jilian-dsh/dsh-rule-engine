// whitelist-allow-config.test.mjs — 域 3 第三枪（2026-09-22）：白名单口令正则迁 whitelistAllow
//   ① LEGACY ＝json 逐字快照；② 夹具与 LEGACY 逐字一致；
//   ③ 配置层命中并捕获工具名；④ 还原内置后中文不命中、英文 allow use foo 捕获 foo；自重置。
// 注：本文件**不 import** index.js（其启动注入会清 override）、**不 import** phase1c、**不 import** loader-smoke。
import assert from "node:assert/strict";
import { currentWhitelistAllow, setWhitelistAllow } from "../lib/core/text-detect.js";
import { TEST_WHITELIST_ALLOW_ZH, useChineseWhitelistAllow } from "./helpers.mjs";

// ── ① 迁移前基线（现盘逐字快照；捕获组随整条走）──
const LEGACY = "(?:允许|批准|同意)\\s*(?:使用|调用|用|启用|放行)\\s*([A-Za-z_][A-Za-z0-9_:.-]*)";

// ── ② 夹具与基线逐字一致 ──
assert.equal(TEST_WHITELIST_ALLOW_ZH, LEGACY, "夹具 whitelistAllow 应与现盘基线逐字一致");

// 取工具名的口径与 index.js 两处一致：默认合并后有两组捕获 → slice(1).find(Boolean)
const namesIn = (text) =>
  [...text.matchAll(currentWhitelistAllow())].map((m) => m.slice(1).find(Boolean)).filter(Boolean);

// ── ③ 配置层生效（自注入）＋ 捕获 ──
useChineseWhitelistAllow();
assert.deepEqual(namesIn("允许使用 future_unknown_zzz 吧，它只是只读查询"), ["future_unknown_zzz"], "用户消息 → 捕获");
assert.deepEqual(namesIn("ask 选择：允许使用 super_future_tool（推荐）"), ["super_future_tool"], "ask 选择文本 → 捕获");

// ── ④ 还原内置（空＝还原）后：中文不命中、英文捕获 ──
setWhitelistAllow("");
assert.deepEqual(namesIn("允许使用 future_unknown_zzz"), [], "还原内置后中文不命中");
assert.deepEqual(namesIn("allow use foo"), ["foo"], "还原内置后英文捕获 foo");

// 自重置（供后续测试／单独运行；run-all 循环亦会重申各夹具）
setWhitelistAllow("", { clear: true });

console.log("whitelist-allow-config.test.mjs PASS");
