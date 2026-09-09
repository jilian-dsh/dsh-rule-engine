// understander.test.mjs — 理解器测试（T4 通用化，2026-08-31）
// 通用夹具：不绑定任何"本机规则编号/本机映射数"。断言随机制走：
//   ① 声明式绑定四层优先级（声明 > handlerOverrides > 默认偏好表 > 空）
//   ② 禁用存档占位重建（disabledEntries）
//   ③ 等级→动作解析（组合等级）
//   ④ hints/confidence 提取（通用规则特征）
// 本机规则集的语义回归由 consistency-live.test（真实 AGENTS.md 守门）承担。
import assert from "node:assert/strict";
import {
  understandRule,
  understandAll,
  actionsForLevel,
  resolveHandler,
  normalizeHandlerName
} from "../lib/core/understander.js";

// ── 等级 → 动作（通用语义） ──
assert.deepEqual(actionsForLevel("A 弱"), ["deny"]);
assert.deepEqual(actionsForLevel("A+D"), ["deny", "self-certify"]);
assert.deepEqual(actionsForLevel("B"), ["correct"]);
assert.deepEqual(actionsForLevel("C"), ["ask"]);
assert.deepEqual(actionsForLevel("M"), ["meta"]);
// 空格组合等级（B + D / B 弱 + D）必须解析出 D 自证动作
assert.deepEqual(actionsForLevel("B + D"), ["correct", "self-certify"]);
assert.deepEqual(actionsForLevel("B 弱 + D"), ["correct", "self-certify"]);
assert.deepEqual(actionsForLevel("D 强"), ["self-certify"]);

// ── 通用夹具（编号/标题不含本机规则影子） ──
const genericRule = {
  index: "R-1",
  title: "通用规则一（执行等级：A+D）",
  section: "通用分区",
  level: "A+D",
  body: "- **触发**：使用内联命令。\n- **检查**：拦 node -e / pwsh -c；拦 utf8BOM 写 .json。\n- **动作**：硬拦项拒绝 + 台账。\n- **豁免**：无。"
};

// ④ 空层：无声明、无覆盖、默认表无此编号 → handler 为空（纯自证规则分流）
assert.equal(understandRule(genericRule).handler, "", "未绑定=纯自证规则");
assert.equal(resolveHandler(genericRule), "", "resolveHandler 空层");

// ② 声明层：正文内联声明优先于默认表（即使默认表无该编号）
const declaredRule = { ...genericRule, body: genericRule.body + "\n<!-- handler: rule9-inline-bom -->" };
assert.equal(understandRule(declaredRule).handler, "inline-command", "内联声明生效（旧内部名归一为 kind）");

// ②b kind 名声明（架构 v3 P1）：陌生用户只写 kind 名，无需知道任何规则号
const semanticDecl = { ...genericRule, body: genericRule.body + "\n<!-- handler: approval -->" };
assert.equal(understandRule(semanticDecl).handler, "approval", "kind 名声明 approval → kind approval");
assert.equal(normalizeHandlerName("backup"), "backup", "normalizeHandlerName kind 名幂等");
assert.equal(normalizeHandlerName("rule13a-backup"), "backup", "normalizeHandlerName 旧内部名 → kind");
assert.equal(normalizeHandlerName("something-new"), "something-new", "normalizeHandlerName 未知名原样");

// ① 覆盖层：handlerOverrides 优先于内联声明（兼容语义名/内部名归一）
const overridden = understandRule(declaredRule, { handlerOverrides: { "R-1": "intent-direct" } });
assert.equal(overridden.handler, "intent-direct", "handlerOverrides 最高优先（语义名归一为 kind）");

// ③ 默认表层（残余1 剥离后）：代码层无默认表——兜底仅来自注入 defaultMap
const noDefault = understandRule({
  index: "1",
  title: "通用默认表样例（执行等级：A）",
  section: "通用分区",
  level: "A",
  body: "- **触发**：x。\n- **检查**：y。\n- **动作**：z。"
});
assert.equal(noDefault.handler, "", "剥离后无注入 → 纯自证（空 handler）");

// defaultMap 注入（本机偏好下沉配置）：编号命中 → 兜底绑定；未命中 → 空
const viaInjected = understandRule({ index: "1", title: "通用默认表样例（执行等级：A）", section: "通用分区", level: "A", body: "- **触发**：x。\n- **检查**：y。\n- **动作**：z。" }, { defaultMap: { "1": "rule1-retry" } });
assert.equal(viaInjected.handler, "retry", "注入 defaultMap 兜底（旧内部名归一为 kind）");
const viaCustom = understandRule({ ...genericRule, index: "C-9" }, { defaultMap: { "C-9": "custom-handler" } });
assert.equal(viaCustom.handler, "custom-handler", "defaultMap 可整体替换/清空");
const viaEmptyMap = understandRule(genericRule, { defaultMap: {} });
assert.equal(viaEmptyMap.handler, "", "空 defaultMap（通用部署）→ 纯自证");

// ── 禁用存档占位重建（T1） ──
const disabledEntries = [
  { index: "D-2", title: "已禁用规则（执行等级：C）", section: "通用分区", header: "### [规则 D-2] 已禁用规则（执行等级：C）", body: "- **触发**：z。\n- **检查**：w。\n- **动作**：q。\n- **豁免**：无。", disabledAt: "2026-08-30T16:41:22.736Z" }
];
const withPlaceholder = understandAll([genericRule], { disabledEntries });
assert.equal(withPlaceholder.length, 2, "缺场禁用规则以占位重建");
const placeholder = withPlaceholder.find((c) => String(c.ruleId) === "D-2");
assert.ok(placeholder, "占位规则存在");
assert.equal(placeholder.disabled, true, "占位规则标记 disabled");
assert.equal(placeholder.level, "C", "占位规则等级从表头提取");
assert.ok(placeholder.actions.includes("ask"), "C 级占位规则动作含 ask");
// 占位不会覆盖在场规则（在场同 id 只标 disabled，不重建）
const both = understandAll(
  [{ index: "D-3", title: "在场（执行等级：B）", section: "s", level: "B", body: "- **触发**：t。\n- **检查**：u。\n- **动作**：v。" }],
  { disabledEntries: [{ index: "D-3", title: "存档（执行等级：A）", section: "s", body: "- **触发**：t。\n- **检查**：u。\n- **动作**：v。" }] }
);
assert.equal(both.length, 1, "在场规则不重复重建");
assert.equal(both[0].disabled, true, "在场禁用规则仅标记");
assert.equal(both[0].title, "在场（执行等级：B）", "在场规则保留 AGENTS.md 标题（不被存档覆盖）");

// ── hints / confidence（通用规则特征提取） ──
assert.ok(understandRule(genericRule).hints.includes("inline-command"), "内联命令特征");
assert.ok(understandRule(genericRule).hints.includes("bom-write"), "BOM 写特征");
assert.equal(understandRule(genericRule).confidence, "high", "四要素齐全且非 D 级→high");
assert.equal(understandRule({ ...genericRule, level: "D" }).confidence, "high", "D 级自证→high");

console.log("understander.test.js PASS");
