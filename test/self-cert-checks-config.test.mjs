// self-cert-checks-config.test.mjs - 自证标记判定词迁配置层（第三批，2026-09-21）
//
// ① 等价性：LEGACY 两段源逐字快照；夹具注入后 isSelfCertified 与"旧内联实现"逐样本等价
//    ——含「已按规则 14 一次性说明」抑制、「本次总结如下」仍触发。
// ② 默认层：两键内置默认英文最小集、无中文。
// ③ 缓存不被锁死：setPatterns 后立即生效（缓存活性自证）。
import assert from "node:assert/strict";
import { isSelfCertified } from "../lib/core/text-detect.js";
import { patMap, setPatterns, resetPatterns } from "../lib/core/patterns.js";
import { useChinesePatterns, TEST_PATTERNS_ZH } from "./helpers.mjs";

// ── ① 迁移前基线（两段逐字快照 + 旧实现）──
const LEGACY = {
  rule_word: "规则",
  tail: "(?:已按|已按要求|已自证|已核对|已核实|核实通过|合规|已满足|已一次性说明|已合并提出|已回应|已实施|已落地)"
};
function isSelfCertifiedLegacy(text, ruleId) {
  if (!text || !ruleId) return false;
  const id = String(ruleId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = "(?:[①②③④⑤⑥⑦⑧⑨⑩]|\\.\\d+|\\d+)?";
  const re = new RegExp(`(?:${LEGACY.rule_word}\\s*${id}${suffix}\\s*${LEGACY.tail}|${LEGACY.tail}\\s*${LEGACY.rule_word}\\s*${id}${suffix})`);
  return re.test(text);
}

// ── ② 样本池（规则号在前／在后、suffix、转义、无关文本、空值）──
const SAMPLES = [
  ["本次总结如下", "14"],
  ["已按规则 14 一次性说明", "14"],
  ["规则14 已核对，无违规", "14"],
  ["已核实 规则 18 的要求", "18"],
  ["规则 23 已落地，交付完成", "23"],
  ["规则 23① 已回应", "23"],
  ["规则 12A 已合并提出", "12A"],
  ["规则 3.2 已满足", "12A"],
  ["我已完成实现，稍后验证", "23"],
  ["本条与自证标记无关", "14"],
  ["rule 14 done", "14"],
  ["", "14"],
  ["已按规则 14 一次性说明", ""],
  ["已按规则 14 一次性说明", null]
];

// ── ③ 默认层（未注入）：两键内置默认无中文 ──
resetPatterns();
const builtin = patMap("self_cert_checks");
assert.deepEqual(Object.keys(builtin).sort(), Object.keys(LEGACY).sort(), "内置默认两子键齐备");
for (const [k, v] of Object.entries(builtin)) {
  assert.doesNotMatch(v, /[\u4e00-\u9fff]/, `内置默认 self_cert_checks.${k} 含中文（应语言无关）`);
}
assert.equal(new RegExp(`(?:${builtin.rule_word}\\s*14\\s*(?:${builtin.tail}))`).test("rule 14 done"), true, "英文默认可用（rule_word＋tail 拼装）");

// ── ④ 夹具注入后：两段源逐字一致 ＋ 逐样本等价 ──
const injected = useChinesePatterns();
assert.deepEqual(injected.rejected, [], "中文夹具注入无拒绝");
const map = patMap("self_cert_checks");
for (const k of Object.keys(LEGACY)) assert.equal(map[k], LEGACY[k], `self_cert_checks.${k} 源与 LEGACY 逐字一致`);
assert.deepEqual(Object.keys(TEST_PATTERNS_ZH.self_cert_checks).sort(), Object.keys(LEGACY).sort(), "夹具两子键齐备");
for (const [text, ruleId] of SAMPLES) {
  assert.equal(
    isSelfCertified(text, ruleId),
    isSelfCertifiedLegacy(text, ruleId),
    `isSelfCertified 等价：${JSON.stringify(text)}（ruleId=${JSON.stringify(ruleId)}）`
  );
}
// 两个关键语义的显式断言（不依赖镜像）
assert.equal(isSelfCertified("已按规则 14 一次性说明", "14"), true, "「已按规则 14 一次性说明」→ 抑制（判为已自证）");
assert.equal(isSelfCertified("本次总结如下", "14"), false, "「本次总结如下」无标记 → 仍触发");

// ── ⑤ 缓存活性自证：换配置后立即生效（缓存锁死时必红）──
{
  const before = isSelfCertified("依据条文 14 已按", "14");
  setPatterns({ self_cert_checks: { rule_word: "条文", tail: LEGACY.tail } });
  assert.equal(isSelfCertified("依据条文 14 已按", "14"), true, "setPatterns 后立即生效（缓存已清）");
  assert.equal(before, false, "旧配置下该样本不命中");
  resetPatterns();
  assert.equal(isSelfCertified("依据条文 14 已按", "14"), false, "resetPatterns 后回退内置默认（缓存已清）");
  useChinesePatterns(); // 还原夹具
  assert.equal(isSelfCertified("已按规则 14 一次性说明", "14"), true, "还原夹具后中文样本恢复命中");
}

console.log("self-cert-checks-config.test.mjs PASS");
