// lang.test.mjs - 首启语言探测单测（第三批第 1 波 §4）
import assert from "node:assert/strict";
import {
  LANGS,
  detectLang,
  getLang,
  getLangSource,
  setLang,
  pickLang,
  resetLang
} from "../lib/core/lang.js";

// ── ① 探测：含 CJK → zh-CN；纯英文 → en ──
resetLang();
assert.equal(getLang(), "en", "默认 en");
assert.equal(getLangSource(), "default");

assert.equal(detectLang("### [规则 1] 异常处理"), "zh-CN", "含中文 → zh-CN");
assert.equal(getLangSource(), "agents-md");
assert.equal(detectLang("# Rule 1 Exception handling"), "en", "纯英文 → en");
assert.equal(detectLang(""), "en", "空文本 → 回默认 en");
assert.equal(getLangSource(), "empty");
assert.equal(detectLang("   "), "en", "空白 → 回默认");
assert.equal(detectLang(null), "en", "null → 回默认");

// 混合文本（中文只占少量）仍判 zh-CN
assert.equal(detectLang("Rule A\n规则 B"), "zh-CN", "混合含 CJK → zh-CN");

// ── ② 缓存语义：探测后 getLang 稳定；再次探测覆盖 ──
detectLang("中文规则集");
assert.equal(getLang(), "zh-CN");
assert.equal(getLang(), "zh-CN", "多次读取稳定");
detectLang("English rules");
assert.equal(getLang(), "en", "重新探测覆盖旧值");

// ── ③ 显式设置与非法值 ──
setLang("zh-CN");
assert.equal(getLang(), "zh-CN");
assert.equal(getLangSource(), "manual");
assert.throws(() => setLang("fr-FR"), /Unknown language/, "非法语言抛错");

// ── ④ 双语选择 ──
setLang("zh-CN");
assert.equal(pickLang("中文", "English"), "中文");
setLang("en");
assert.equal(pickLang("中文", "English"), "English");

// ── ⑤ 常量与重置 ──
assert.deepEqual(LANGS, ["zh-CN", "en"]);
resetLang();
assert.equal(getLang(), "en");
assert.equal(getLangSource(), "default");

console.log("lang.test.js PASS");
