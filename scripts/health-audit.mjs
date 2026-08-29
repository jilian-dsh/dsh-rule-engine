// health-audit.mjs - 健康审计（找茬，不是证明；2026-08-26）。
// 输出"问题清单"（近 24h），无问题也要列出"查了什么"：
// ① 失败/降级类统计：intent-llm（成功/失败降级）、judge-pass/false/unavailable、
//    verify-gap、inject-skip、source-skip——失败可见化（"LLM 意图 31 次全降级"从此自浮现）；
// ② 接口接线交叉：关键导出符号在 lib 下引用计数 ≤1（仅定义，无引用）→ 疑似未接线；
// ③ 与 verify-all 的真实判例口径一致（供人工核对）。
import { readdirSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const auditPath = join(process.env.DSH_HOME || join(process.env.USERPROFILE || "", ".dsh"), "rule-engine.log.jsonl");
const now = Date.now();
const cuts = { intentFail: 0, intentOk: 0, judgePass: 0, judgeFalse: 0, judgeUnavail: 0, verifyGap: 0, injectSkip: 0, sourceSkip: 0, denyTotal: 0, labelIncorrect: 0, labelCorrect: 0, errorHint: 0 };

try {
  for (const line of readFileSync(auditPath, "utf8").split("\n")) {
    const m = line.match(/"ts":"([^"]+)"/);
    if (!m || now - new Date(m[1]).getTime() > 24 * 3600 * 1000) continue;
    if (line.includes('"kind":"intent-llm"')) (line.includes("LLM 失败降级") ? cuts.intentFail++ : cuts.intentOk++);
    if (line.includes('"kind":"judge-pass"')) cuts.judgePass++;
    if (line.includes('"kind":"judge-false"')) cuts.judgeFalse++;
    if (line.includes('"kind":"judge-unavailable"')) cuts.judgeUnavail++;
    if (line.includes('"kind":"verify-gap"')) cuts.verifyGap++;
    if (line.includes('"kind":"inject-skip"')) cuts.injectSkip++;
    if (line.includes('"kind":"source-skip"')) cuts.sourceSkip++;
    if (line.includes('"kind":"deny"')) cuts.denyTotal++;
    if (line.includes('"kind":"task-label"') && line.includes("incorrect")) cuts.labelIncorrect++;
    if (line.includes('"kind":"task-label"') && line.includes("correct")) cuts.labelCorrect++;
    if (line.includes('"kind":"error-hint"')) cuts.errorHint++;
  }
} catch {
  // 无日志文件：一切 0
}

// ② 接线交叉：导出符号引用计数（>1 = 定义+引用；=1 = 疑似仅定义未接线）
const EXPORTS = [
  "setSessionWorkspaceRoot", "setWorkspaceRoots", "isVerificationCommand",
  "isNegatingSuggestion", "isPromiseQuoteContext", "judgeViolation",
  "shouldDetectTurn", "shouldDeliver", "isReadOnlyCommand"
];
let libText = "";
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.js$/.test(f)) libText += readFileSync(p, "utf8") + "\n";
  }
})(join(root, "lib"));
const orphans = EXPORTS.filter((n) => ((libText.match(new RegExp("\\b" + n + "\\b", "g")) || []).length) <= 1);

console.log("== 健康审计（近 24h）==");
console.log(`intent-llm 失败降级 ${cuts.intentFail} 条 / 成功 ${cuts.intentOk} 条`);
console.log(`judge-pass ${cuts.judgePass} 条 / judge-false ${cuts.judgeFalse} 条 / judge-unavailable ${cuts.judgeUnavail} 条`);
console.log(`verify-gap ${cuts.verifyGap} 条 / inject-skip ${cuts.injectSkip} 条 / source-skip ${cuts.sourceSkip} 条`);
console.log(`误判打标（建议4）：deny 总数 ${cuts.denyTotal} 条 → label incorrect ${cuts.labelIncorrect} 条 / correct ${cuts.labelCorrect} 条${cuts.denyTotal > 0 && cuts.labelIncorrect > 0 ? `（incorrect 占比 ${(cuts.labelIncorrect / cuts.denyTotal * 100).toFixed(1)}%）` : ""}——词表迭代量化依据`);
console.log(`已知坑召回（建议5）：error-hint ${cuts.errorHint} 条`);
console.log(`接线交叉：${EXPORTS.length} 个关键导出 → 疑似未接线 ${orphans.length ? orphans.join("、") : "0 个"}`);
if (cuts.judgePass + cuts.judgeFalse === 0) {
  console.log("⚠️ 问题：近 24h 无真实判例——裁决器无运行证据（需实弹）");
}
if (cuts.intentFail > 0) {
  console.log(`⚠️ 问题：intent-llm 失败降级 ${cuts.intentFail} 条——LLM 意图判定不可用（需查模型路由/密钥）`);
}
console.log(orphans.length ? `❌ 问题：疑似未接线：${orphans.join("、")}` : `✅ 接线：全部导出有引用`);
console.log("（已查：失败统计 8 类 + 接线交叉 9 个导出；无问题也列出如上）");
