// messages.test.mjs - 文案层机制单测（第三批清淤 1a）
import assert from "node:assert/strict";
import {
  DEFAULT_MESSAGES,
  effectiveMessages,
  setMessages,
  resetMessages,
  getMessage,
  hasMessage,
  hasMessageOverride
} from "../lib/messages.js";

// ── ① 内置默认：取词 + 参数插值 ──
resetMessages();
assert.equal(hasMessageOverride(), false);
assert.equal(getMessage("guard.usage.header"), "Usage:", "内置默认取词");
assert.equal(
  getMessage("guard.unlock.done", { minutes: 10 }),
  "Config write protection unlocked for 10 minutes. You may now let the assistant edit rule-engine.json / rule-understanding.json / AGENTS.md; run /guard lock afterwards or wait for auto-restore.",
  "参数插值"
);
// 缺参数时保留占位符（不吞成 undefined）
assert.match(getMessage("guard.unlock.done"), /\{minutes\}/, "缺参数保留占位符");
assert.match(getMessage("guard.status.lang", { lang: "zh-CN" }), /zh-CN/, "部分参数插值");
assert.match(getMessage("guard.status.lang", { lang: "zh-CN" }), /\{source\}/, "未提供的占位符保留");

// ── ② 缺失 key 返回 key 本身（可见失败，不静默）──
assert.equal(getMessage("no.such.key"), "no.such.key");
assert.equal(hasMessage("no.such.key"), false);
assert.equal(hasMessage("guard.usage.header"), true);

// ── ③ Override：按键完全替换 ──
{
  const r = setMessages({ "guard.usage.header": "用法：", "guard.freedom.title": "守卫自由面：" });
  assert.deepEqual(r.applied.sort(), ["guard.freedom.title", "guard.usage.header"]);
  assert.deepEqual(r.rejected, []);
  assert.equal(hasMessageOverride(), true);
  assert.equal(getMessage("guard.usage.header"), "用法：", "覆盖生效");
  // 未覆盖的键回退内置默认
  assert.equal(getMessage("guard.usage.footer"), "Notes:", "未覆盖键回退内置");
  // effectiveMessages 反映合并结果
  const eff = effectiveMessages();
  assert.equal(eff["guard.usage.header"], "用法：");
  assert.equal(eff["guard.usage.footer"], "Notes:");
}

// ── ④ 语义边界：undefined 不干预 / {} 回退 / 非法值拒绝 ──
{
  assert.equal(setMessages(undefined).noop, true);
  assert.equal(hasMessageOverride(), true, "undefined 不得清掉已注入的覆盖");
  assert.equal(getMessage("guard.usage.header"), "用法：");

  const r = setMessages({ "guard.usage.header": "", "guard.invalid": 123, "guard.freedom.tip": "x" });
  assert.deepEqual(r.applied, ["guard.freedom.tip"]);
  assert.deepEqual(
    r.rejected.map((x) => `${x.key}:${x.reason}`).sort(),
    ["guard.invalid:empty-or-not-string", "guard.usage.header:empty-or-not-string"]
  );
  assert.equal(getMessage("guard.usage.header"), "Usage:", "被拒的键回退内置");

  setMessages({});
  assert.equal(hasMessageOverride(), false, "空对象回退内置");
  assert.equal(getMessage("guard.usage.header"), "Usage:");
}

// ── ⑤ 内置默认不含 CJK（发布面零中文的前提）──
{
  resetMessages();
  for (const [k, v] of Object.entries(DEFAULT_MESSAGES)) {
    assert.doesNotMatch(v, /[\u4e00-\u9fff]/, `内置默认 ${k} 含中文`);
  }
  console.log(`文案层：${Object.keys(DEFAULT_MESSAGES).length} 条内置默认，全部无中文：PASS`);
}

console.log("messages.test.js PASS");
