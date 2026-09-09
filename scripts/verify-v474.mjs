// verify-v474.mjs - v4.74 记录项引擎在位抽查（分点切分/规则2双检/词表跑）
import { parseUserIntents } from "../lib/core/intent.js";
import { actionWordsRe } from "../lib/core/lexicon.js";
import { evidenceMarkRe, timeWordsRe } from "../lib/core/patterns.js";

// ① 分点切分（标点后编号——用户"1、问2、问3、跑"同行）
const mixed = parseUserIntents("1、为什么预算会满？2、检查时间规则？3、跑");
console.log("分点(同行标点):", mixed.hasExecute && mixed.clauses[2].type === "execute" ? "✅" : "❌");
// ② 词表补跑（P8 小批 A 起词表经函数取；本机需 lexicons 配置注入中文词表）
console.log("词表含跑:", actionWordsRe().test("跑") ? "✅" : "❌");
// ③ 规则2双检：证据锚、具体时间词（P8 小批 B 起经访问器取；本机需 patterns 配置注入中文表）
console.log("规则2证据词表:", evidenceMarkRe().test("日志 ts=2026-08-27T15:21:05Z") ? "✅" : "❌");
console.log("规则2具体词(昨天):", timeWordsRe().test("昨天") ? "✅" : "❌");
console.log("规则2模糊词(之前):", timeWordsRe().test("之前") ? "❌(应不命中)" : "✅(不命中)");
