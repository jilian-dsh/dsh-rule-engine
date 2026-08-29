// rules-health.mjs - 规则触发率统计（阶段 2"数据驱动精简"的基础工具，2026-08-24）
// 用法：node scripts/rules-health.mjs [--top 10]
// 数据源：DSH_HOME/rule-engine.log.jsonl（引擎审计日志——四类审计自 2026-08-24 起）
// 输出：① 各规则触发统计（按 total 排序）② 零命中清单（对照 rule-understanding.json 规则全集）
//       ③ 样本标注：总量 < MIN_SAMPLE 时提示"样本不足，暂不据此删/并/浓缩规则"。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const DSH_HOME = process.env.DSH_HOME || join(os.homedir(), ".dsh");
const LOG = join(DSH_HOME, "rule-engine.log.jsonl");
const UNDERSTANDING = join(DSH_HOME, "rule-understanding.json");
const MIN_SAMPLE = 200;
const TOP = Number((process.argv.find((a) => a.startsWith("--top=")) || "").split("=")[1]) || 10;

if (!existsSync(LOG)) {
  console.log(`NO LOG: ${LOG}`);
  process.exit(0);
}

const stats = new Map(); // ruleId -> Map(kind -> count)
let total = 0;
for (const line of readFileSync(LOG, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  if (!e || !e.kind || !e.rule) continue;
  total++;
  const byKind = stats.get(String(e.rule)) || new Map();
  byKind.set(e.kind, (byKind.get(e.kind) || 0) + 1);
  stats.set(String(e.rule), byKind);
}

// 规则全集（对照零命中）
let ruleIds = new Set();
try {
  const u = JSON.parse(readFileSync(UNDERSTANDING, "utf8"));
  ruleIds = new Set((u.rules || []).map((r) => String(r.ruleId)));
} catch { /* 理解产物缺失时只统计日志内规则 */ }

const rows = [...stats.entries()]
  .map(([rule, byKind]) => ({ rule, total: [...byKind.values()].reduce((a, b) => a + b, 0), byKind }))
  .sort((a, b) => b.total - a.total);

console.log(`规则触发率统计（样本总量 ${total}${total < MIN_SAMPLE ? `，⚠ 样本不足 ${MIN_SAMPLE}——暂不据此删/并规则` : ""}）`);
console.log("规则      触发数  分类明细");
for (const { rule, total, byKind } of rows.slice(0, TOP)) {
  const detail = [...byKind.entries()].map(([k, n]) => `${k}:${n}`).join(" ");
  console.log(`${String(rule).padEnd(10)} ${String(total).padEnd(7)} ${detail}`);
}
const zero = [...ruleIds].filter((id) => !stats.has(id));
if (zero.length > 0) {
  console.log(`\n零命中规则（${zero.length}）：${zero.join(", ")}`);
  console.log("注：零命中 ≠ 无用（条件触发型低频规则正常）；仅作体检参考，勿据单次样本删规则。");
}
