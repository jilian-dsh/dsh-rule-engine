// verify-v474.mjs - v4.74 记录项引擎在位抽查（分点切分/规则2双检/词表跑）
import { parseUserIntents } from "../lib/core/intent.js";
import { ACTION_WORDS_RE } from "../lib/core/lexicon.js";
import { EVIDENCE_MARK_RE, TIME_WORDS } from "../lib/core/patterns.js";

// ① 分点切分（标点后编号——用户"1、问2、问3、跑"同行）
const mixed = parseUserIntents("1、为什么预算会满？2、检查时间规则？3、跑");
console.log("分点(同行标点):", mixed.hasExecute && mixed.clauses[2].type === "execute" ? "✅" : "❌");
// ② 词表补跑
console.log("词表含跑:", ACTION_WORDS_RE.test("跑") ? "✅" : "❌");
// ③ 规则2双检：EVIDENCE_MARK_RE 存在、TIME_WORDS 具体词
console.log("规则2证据词表:", EVIDENCE_MARK_RE.test("日志 ts=2026-08-27T15:21:05Z") ? "✅" : "❌");
console.log("规则2具体词(昨天):", TIME_WORDS.test("昨天") ? "✅" : "❌");
console.log("规则2模糊词(之前):", TIME_WORDS.test("之前") ? "❌(应不命中)" : "✅(不命中)");
