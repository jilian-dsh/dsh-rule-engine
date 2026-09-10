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

// ═══ P2（2026-09-10）：个人层措施声明 → 措施实例 + 12B round-trip 样板（架构正本 §三 L2/L3）═══
// 验收口径（§八）：加 12B → 措施出现；删 12B → 消失。每条断言注明「变红条件」。
{
  const { parseHandlerDecl, validateMeasure } = await import("../lib/core/measure-kinds.js");
  const { understandRule, understandAll } = await import("../lib/core/understander.js");
  const mk = (index, body) => ({ index, title: `规则 ${index}（执行等级：A）`, section: "自定义分区", level: "A", body });

  // T1 无参声明 → kind + 空 params　（变红：解析器漏捕获 kind）
  assert.deepEqual(parseHandlerDecl("正文\n<!-- handler: backup -->"), { kind: "backup", params: {} }, "T1 无参声明");

  // T2 带参声明　（变红：JSON 未解析 / 数组参数被吞）
  const d2 = parseHandlerDecl('<!-- handler: backup { "max": 3, "targets": [".backups/"] } -->');
  assert.equal(d2.params.max, 3, "T2 数值参数");
  assert.deepEqual(d2.params.targets, [".backups/"], "T2 数组参数");
  assert.equal(parseHandlerDecl("<!-- handler: rule13a-backup -->").kind, "backup", "T2b 旧内部名归一后解析");

  // T3 非法 JSON → error，且实例侧 fail-closed　（变红：解析失败被静默吞掉）
  assert.ok(parseHandlerDecl("<!-- handler: backup { max: 3 } -->").error, "T3 非法 JSON → error");
  assert.ok(parseHandlerDecl("<!-- handler: -->").error, "T3b 空声明 → error");
  const c3 = understandRule(mk("D-3", "<!-- handler: backup { max: 3 } -->"));
  assert.equal(c3.handler, "", "T3c 声明非法 → handler 空（fail-closed）");
  assert.ok(c3.measureError, "T3c measureError 非空");

  // T4 未注册 kind → fail-closed + 明确报错　（变红：未注册 kind 静默放行 → handler 非空）
  const c4 = understandRule(mk("D-4", "<!-- handler: no-such-kind -->"));
  assert.equal(c4.handler, "", "T4 未注册 kind → handler 空");
  assert.match(c4.measureError, /kind 未注册/, "T4 measureError 明示未注册");
  assert.equal(c4.measure, null, "T4 不产出措施实例");

  // T5 ★ round-trip（12B 样板）　（变红：措施脱离规则本体即自带化 → 删规则后仍存在）
  const rule12B = mk("12B", '<!-- handler: backup { "max": 5 } -->');
  const withRule = understandAll([rule12B]);
  assert.equal(withRule.length, 1, "T5a 规则在 → 1 条 config");
  assert.equal(withRule[0].measure.kind, "backup", "T5a 措施实例出现");
  assert.equal(withRule[0].measure.params.max, 5, "T5a 参数随声明生成");
  const withoutRule = understandAll([]);
  assert.equal(withoutRule.length, 0, "T5b 规则删 → config 消失");
  assert.ok(!withoutRule.some((c) => c.measure), "T5b 措施随之消失（非自带）");

  // T6 兼容：旧格式（无参）handler 值与 P1 基线逐字一致　（变红：兼容破坏）
  const c6 = understandRule(mk("D-6", "<!-- handler: approval -->"));
  assert.equal(c6.handler, "approval", "T6 旧格式 handler 值不变");
  assert.equal(c6.measure.kind, "approval", "T6 measure 同步");
  assert.equal(c6.measureError, "", "T6 无错误");

  // T7 无声明 → 不产生措施、不报错　（变红：无声明被误判为错误）
  const c7 = understandRule(mk("D-7", "- **触发**：x。\n- **检查**：y。"));
  assert.equal(c7.measure, null, "T7 无声明 → measure null");
  assert.equal(c7.measureError, "", "T7 无声明不报错");
  assert.equal(validateMeasure(null), null, "T7b validateMeasure(null) → 通过");
}

console.log(`measure-kinds：注册表 ${kindKeys.length} kind / 别名 ${legacyEntries.length} 项 / 等价性对照 ${checked} 组，全部通过`);
