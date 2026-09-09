// measure-kinds.test.mjs - 措施类型注册表与兼容归一（架构 v3 · P1，2026-09-10）
//
// P1 验收口径（架构正本 §八）：「npm test + verify-all 全绿；**行为等价**」。
// 本测试锁三件事：
//   ① 注册表完整（每个 kind 有定义、每个旧名都能归一到已注册 kind）；
//   ② 归一语义（旧名→kind / kind 幂等 / 未知名原样 / 空值）；
//   ③ **行为等价**：同一 cfg 写旧名或写 kind 名，matcher 分派结果必须一致
//      （P1 把 26 处 `cfg.handler === "ruleXX-*"` 换成 `kindOf(cfg.handler) === "<kind>"`，
//       等价性正是靠这一层保证——旧配置/旧测试夹具零改动仍生效）。
import assert from "node:assert/strict";

const { kindOf, MEASURE_KINDS, LEGACY_HANDLER_ALIASES } = await import("../lib/core/measure-kinds.js");
const { activateForToolCall, activateForUserMessage } = await import("../lib/core/matcher.js");

// ① 全表：旧名 → kind，且 kind 必须已注册、归一幂等
const legacyEntries = Object.entries(LEGACY_HANDLER_ALIASES);
assert.ok(legacyEntries.length >= 18, `兼容别名表至少 18 项（实际 ${legacyEntries.length}）`);
for (const [legacy, kind] of legacyEntries) {
  assert.equal(kindOf(legacy), kind, `旧名 ${legacy} → ${kind}`);
  assert.ok(Object.prototype.hasOwnProperty.call(MEASURE_KINDS, kind), `kind ${kind} 必须在注册表中`);
  assert.equal(kindOf(kind), kind, `kind ${kind} 幂等`);
}

// ② 注册表值域与别名值域一致（防止加了 kind 却漏了旧名映射，或反之）
const kindKeys = Object.keys(MEASURE_KINDS).sort();
const aliasValues = [...new Set(Object.values(LEGACY_HANDLER_ALIASES))].sort();
assert.deepEqual(aliasValues, kindKeys, "别名值集合 === 注册表键集合");
assert.equal(Object.values(LEGACY_HANDLER_ALIASES).length, aliasValues.length, "别名值无重复");

// ③ 归一三态
assert.equal(kindOf("something-new"), "something-new", "未知名原样（由覆盖自省提示未覆盖）");
assert.equal(kindOf(""), "", "空串 → 空");
assert.equal(kindOf(undefined), "", "undefined → 空");
assert.equal(kindOf(null), "", "null → 空");
assert.equal(kindOf("  retry  "), "retry", "首尾空白容错");

// ④ 行为等价：旧名 cfg 与 kind 名 cfg 经 matcher 分派结果逐项一致
const TOOLS = ["pwsh", "bash", "edit", "write", "skill", "read", "ask_user_question", "webfetch"];
let checked = 0;
for (const [legacy, kind] of legacyEntries) {
  for (const tool of TOOLS) {
    const viaLegacy = activateForToolCall([{ handler: legacy, triggerKeywords: [] }], tool, {}).length;
    const viaKind = activateForToolCall([{ handler: kind, triggerKeywords: [] }], tool, {}).length;
    assert.equal(viaLegacy, viaKind, `工具 ${tool}｜${legacy} 与 ${kind} 分派一致`);
    checked++;
  }
}
// 用户消息面同理（时间/来源/备份等激活面）
const MSGS = ["帮我看看", "现在几点", "来源在哪", "请备份", "Hello world"];
for (const [legacy, kind] of legacyEntries) {
  for (const msg of MSGS) {
    const viaLegacy = activateForUserMessage([{ handler: legacy, triggerKeywords: [] }], msg).length;
    const viaKind = activateForUserMessage([{ handler: kind, triggerKeywords: [] }], msg).length;
    assert.equal(viaLegacy, viaKind, `消息「${msg}」｜${legacy} 与 ${kind} 分派一致`);
    checked++;
  }
}

console.log(`measure-kinds：注册表 ${kindKeys.length} kind / 别名 ${legacyEntries.length} 项 / 等价性对照 ${checked} 组，全部通过`);
