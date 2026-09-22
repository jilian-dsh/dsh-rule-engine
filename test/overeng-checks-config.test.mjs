// overeng-checks-config.test.mjs - 过度工程／重复打转判定词迁配置层（第三批，2026-09-21）
//
// ① 等价性：LEGACY 四条源逐字快照；夹具注入后 detectOverengineeringText 与"旧内联实现"逐样本等价。
// ② AND／NOT 组合逻辑仍在代码（配置只给词）。
// ③ 缓存不被锁死：setPatterns 后立即生效（缓存活性自证）。
import assert from "node:assert/strict";
import { detectOverengineeringText } from "../lib/core/overengineering.js";
import { patMap, setPatterns, resetPatterns } from "../lib/core/patterns.js";
import { useChinesePatterns, TEST_PATTERNS_ZH } from "./helpers.mjs";

// ── ① 迁移前基线（四条逐字快照）──
const LEGACY = {
  extra_act: "(?:顺手|顺便|额外|多加|防止以后|以防万一|先加上|先建个)",
  extra_tech: "(?:重构|依赖|抽象|兼容|迁移|flag|校验|哈希|hash|全量测试|保险)",
  recheck: "(?:再检查一遍|再跑一次测试|再审计一次|重新验证一遍)",
  recheck_except: "(?:新证据|发现|失败|报错|修改后|变更后)"
};
const legacyDetect = (text) => {
  const s = String(text || "");
  const hits = [];
  if (new RegExp(LEGACY.extra_act).test(s) && new RegExp(LEGACY.extra_tech, "i").test(s)) {
    hits.push("检测到可能的过度工程表述：请用 Stop Ladder 四问自证（是否被要求/是否必要/可达证据/省略是否会失败）");
  }
  if (new RegExp(LEGACY.recheck).test(s) && !new RegExp(LEGACY.recheck_except).test(s)) {
    hits.push("检测到可能的重复打转：请确认是否有新证据，避免 Task thrashing");
  }
  return hits;
};

const SAMPLES = [
  "我顺便把依赖也重构了",
  "顺手加个 flag 吧",
  "额外做一次全量测试",
  "再检查一遍这个逻辑",
  "再跑一次测试，看看有没有新证据",
  "重新验证一遍，如果失败再说",
  "顺手改一下文案",
  "重构一下架构",
  "这里是普通文本，没有关键词",
  ""
];

// ── ② 默认层（未注入）：四键内置默认无中文；英文样本可用 ──
resetPatterns();
const builtin = patMap("overeng_checks");
assert.deepEqual(Object.keys(builtin).sort(), Object.keys(LEGACY).sort(), "内置默认四子键齐备");
for (const [k, v] of Object.entries(builtin)) {
  assert.doesNotMatch(v, /[\u4e00-\u9fff]/, `内置默认 overeng_checks.${k} 含中文（应语言无关）`);
}
assert.equal(detectOverengineeringText("while at it, refactor the module").length, 1, "英文默认命中过度工程（AND 逻辑生效）");
assert.equal(detectOverengineeringText("recheck the logic").length, 1, "英文默认命中重复打转（NOT 逻辑生效）");
assert.equal(detectOverengineeringText("recheck the logic after the change").length, 0, "英文默认 NOT 分支生效");

// ── ③ 夹具注入后：四条源逐字一致 ＋ 逐样本等价 ──
const injected = useChinesePatterns();
assert.deepEqual(injected.rejected, [], "中文夹具注入无拒绝");
const map = patMap("overeng_checks");
assert.deepEqual(Object.keys(map).sort(), Object.keys(LEGACY).sort(), "四子键齐备");
for (const k of Object.keys(LEGACY)) {
  assert.equal(map[k], LEGACY[k], `overeng_checks.${k} 源与 LEGACY 逐字一致`);
}
assert.deepEqual(Object.keys(TEST_PATTERNS_ZH.overeng_checks).sort(), Object.keys(LEGACY).sort(), "夹具四子键齐备");
for (const s of SAMPLES) {
  assert.deepEqual(detectOverengineeringText(s), legacyDetect(s), `逐样本等价：${JSON.stringify(s.slice(0, 24))}`);
}

// ── ④ 缓存活性自证：换配置后立即生效（缓存锁死时必红）──
{
  const before = detectOverengineeringText("再确认一遍 A").length;
  setPatterns({ overeng_checks: { recheck: "再确认一遍" } });
  assert.equal(detectOverengineeringText("再确认一遍 A").length, 1, "setPatterns 后立即生效（缓存已清）");
  assert.equal(before, 0, "旧配置下该样本不命中");
  resetPatterns();
  assert.equal(detectOverengineeringText("再确认一遍 A").length, 0, "resetPatterns 后回退内置默认（缓存已清）");
  useChinesePatterns(); // 还原夹具
  assert.equal(detectOverengineeringText("再检查一遍这个逻辑").length, 1, "还原夹具后中文样本恢复命中");
}

console.log("overeng-checks-config.test.mjs PASS");
