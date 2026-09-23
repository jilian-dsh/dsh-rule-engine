// rule2-delivery.test.mjs —— 规则 2 判定与投递的先红集（规则层 A3 拍板口径的可执行化）
//
// 用途：锁定四条拍板口径，作为 A3 改造的先红基线（改造前应 FAIL，改造后应 ALL PASS）——
//   ① 回合末按类撤销：只撤 lane=getdate 且本回合调用过 Get-Date 的那条；lane=evidence 照投并留痕；
//   ② 同一回合两类都命中时合成一条提醒投递，审计按类各记一条（记录带 lane）；
//   ③ detectTimeRule 两类独立判定（缺 Get-Date / 缺事件证据各自成条，不再互斥）；
//   ④ detectTimeRule 为唯一判定源，detectViolations 产出的规则 2 条目须与其逐项相同。
// lane 取值：getdate（缺 Get-Date 核对）/ evidence（缺事件证据锚）。
//
// 先红预期：第 ① 条失败——回合末把 lane=evidence 的待投递整笔撤掉（写 rule2-resolved、不写 correct），
//   因此「缺事件证据」的提醒投不出去。夹具自身报错即停，不改引擎任何文件。
//
// 夹具：临时 DSH_HOME；顶部注入 run-all 同源的中文 patterns 夹具（单跑自足）；
//   state.configs 一条规则 2 配置；回合用 handleSessionEvent 驱动；
//   投递经伪 ctx 的 agent.inject 收集；审计读临时目录的 rule-engine.log.jsonl；
//   每个场景用各自的会话号（避免去重与每小时预算串味）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useChineseLexicons, useChinesePatterns } from "./helpers.mjs";

// ── 临时 DSH_HOME（审计与卡片落临时目录，不污染本机）──
const HOME = mkdtempSync(join(tmpdir(), "dsh-rule-engine-rule2-"));
process.env.DSH_HOME = HOME;
const LOG = join(HOME, "rule-engine.log.jsonl");

// ── 中文 patterns 夹具（内置默认是语言无关最小集，中文样本须与 run-all 同源注入）──
// 模块级状态，须在引擎模块动态 import 之前注入。
{
  const lex = useChineseLexicons();
  const pat = useChinesePatterns();
  if (lex.rejected.length > 0 || pat.rejected.length > 0) {
    throw new Error(`中文夹具注入失败: ${JSON.stringify({ lexicons: lex.rejected, patterns: pat.rejected })}`);
  }
}

// ── 引擎（自包含：屏蔽热重载；只放规则 2 一条配置）──
const { state } = await import("../lib/core/runtime.js");
const { handleSessionEvent } = await import("../lib/index.js");
const { getSessionState } = await import("../lib/core/state.js");
const { understandRule } = await import("../lib/core/understander.js");
const { detectViolations, detectTimeRule } = await import("../lib/core/text-detect.js");

state.lastMtimeCheck = Date.now() + 3600_000;
const rule2 = understandRule({
  index: "2",
  title: "时间信息须真实（执行等级：B）",
  level: "B",
  body: "- **触发**：回答含时间词。\n- **检查**：写时间前必须 Get-Date。\n- **动作**：审计+纠正。\n- **豁免**：无。"
});
state.configs = [rule2];
state.judgeFn = async () => ({ action: "suppress", note: "rule2-delivery stub" }); // 防任何自证嫌疑走真 LLM

// ── 样本（规避缩写路径等旁路）──
const PLAIN_NOW = "昨天做了 X";                                    // 当下词、无证据锚
const NOW_WITH_EVIDENCE = "我昨天看到三条记录（日志 ts=2026-09-23T00:00:00Z）"; // 当下词 + 证据锚
const HIST_NO_EVIDENCE = "复检在 2026-09-23 03:25";                 // 历史日期、无证据锚
const HIST_NO_EVIDENCE_2 = "复检在 2026-09-24 03:25";
const QUOTED = "你说昨天做了 X";                                    // 引述/转述语境

// ── 伪 ctx：收投递（仿 loader-smoke 的 injected 做法）──
const injected = [];
const fakeCtx = { agents: { get: () => ({ inject(message) { injected.push(message); } }) } };
const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const msgText = (m) => (Array.isArray(m.content) ? m.content.map((b) => (b && b.text) || "").join("\n") : String(m.content || ""));

// ── 回合驱动（仿 ask-pending-survives-turn 的 fire 做法）──
const fire = (sid, type, data) => handleSessionEvent(fakeCtx, { id: sid }, { type, data });
const openTurn = (sid, n) => {
  fire(sid, "turn/start", { turn: n });
  fire(sid, "user/message", { message: { content: "请核对时间信息", source: { kind: "user" } } });
};
const reply = (sid, text) => fire(sid, "assistant/message", { message: { content: text } });
const callGetDate = (sid, callId) => fire(sid, "tool/call", {
  callId, name: "pwsh", arguments: { command: "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'" }
});
const closeTurn = (sid, n) => fire(sid, "turn/end", { turn: n });
const deliveries = (from) => injected.slice(from).map(msgText).filter((t) => t.includes("规则 2"));

// ── 审计读取（audit 为同步 appendFileSync 写临时 DSH_HOME）──
function auditRows() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}
const correctAll = () => auditRows().filter((e) => e.kind === "correct" && String(e.rule) === "2");
const resolvedOf = (sid) => auditRows().filter((e) => e.kind === "rule2-resolved" && String(e.rule) === "2" && e.session === sid);

// ── 结果收集（按断言顺序逐条报告；改造后应 0 FAIL）──
const results = [];
async function group(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, err: error }); }
}
const norm = (h) => ({ ruleId: String(h.ruleId), kind: h.kind, lane: h.lane ?? null, reason: h.reason });

// ═══════ ① 真实回合按类撤：Get-Date 在回复之后 / 之前，各一次 ═══════

await group("①-1 历史日期无锚 + Get-Date 在回复之后：evidence 类不被撤、记 correct(lane=evidence)", async () => {
  const sid = "s1a";
  const base = correctAll().length;
  openTurn(sid, 1);
  reply(sid, HIST_NO_EVIDENCE);
  callGetDate(sid, "c-1a");
  closeTurn(sid, 1);
  await wait();
  assert.equal(resolvedOf(sid).length, 0, `回合末不得撤销 evidence 类（实际 rule2-resolved ${resolvedOf(sid).length} 条）`);
  const news = correctAll().slice(base);
  const ev = news.filter((e) => e.lane === "evidence");
  assert.equal(ev.length, 1, `须有 kind=correct、rule=2、lane=evidence 的记录（本回合新增 ${news.length} 条：${JSON.stringify(news)}）`);
});

await group("①-2 历史日期无锚 + Get-Date 在回复之前：同样不被撤、记 correct(lane=evidence)", async () => {
  const sid = "s1b";
  const base = correctAll().length;
  openTurn(sid, 2);
  callGetDate(sid, "c-1b");
  reply(sid, HIST_NO_EVIDENCE);
  closeTurn(sid, 2);
  await wait();
  assert.equal(resolvedOf(sid).length, 0, `回合末不得撤销 evidence 类（实际 rule2-resolved ${resolvedOf(sid).length} 条）`);
  const news = correctAll().slice(base);
  const ev = news.filter((e) => e.lane === "evidence");
  assert.equal(ev.length, 1, `须有 kind=correct、rule=2、lane=evidence 的记录（本回合新增 ${news.length} 条：${JSON.stringify(news)}）`);
});

// ═══════ ② 另一半照旧：缺 Get-Date 类仍被撤 ═══════

await group("② 当下词 + 证据锚 + 回合内 Get-Date：有 rule2-resolved、无 correct", async () => {
  const sid = "s2";
  const base = correctAll().length;
  openTurn(sid, 3);
  reply(sid, NOW_WITH_EVIDENCE);
  callGetDate(sid, "c-2");
  closeTurn(sid, 3);
  await wait();
  assert.ok(resolvedOf(sid).length >= 1, `缺 Get-Date 类应被撤并留痕（实际 ${resolvedOf(sid).length} 条）`);
  assert.equal(correctAll().length - base, 0, `被撤的类不得再记 correct（本回合新增 ${correctAll().length - base} 条）`);
});

// ═══════ ③ 合并投递：两类各记一条 + 只投一次 ═══════

await group("③ 双缺未 Get-Date：两条 correct（lane 各一）+ 合成一次投递（含两类原因）", async () => {
  const sid = "s3";
  const base = correctAll().length;
  const from = injected.length;
  openTurn(sid, 4);
  reply(sid, PLAIN_NOW);
  closeTurn(sid, 4);
  await wait();
  const news = correctAll().slice(base);
  assert.equal(news.length, 2, `两类须各记一条 correct（实际 ${news.length} 条）`);
  assert.deepEqual(news.map((e) => e.lane).sort(), ["evidence", "getdate"], `lane 各一（实际 ${JSON.stringify(news.map((e) => e.lane))}）`);
  const got = deliveries(from);
  assert.equal(got.length, 1, `同一回合只投递一次（实际 ${got.length} 次）`);
  assert.ok(got[0].includes("未先调用 Get-Date"), `投递文字须含 getdate 类原因（实际 ${got[0]}）`);
  assert.ok(got[0].includes("未附事件证据标注"), `投递文字须含 evidence 类原因（实际 ${got[0]}）`);
});

// ═══════ ④ 同类去重：两条回复都触发缺事件证据 → 该类只记一条 ═══════

await group("④ 同回合两次 evidence 命中：该类只记一条 correct", async () => {
  const sid = "s4";
  const base = correctAll().length;
  openTurn(sid, 5);
  reply(sid, HIST_NO_EVIDENCE);
  reply(sid, HIST_NO_EVIDENCE_2);
  closeTurn(sid, 5);
  await wait();
  const news = correctAll().slice(base);
  const ev = news.filter((e) => e.lane === "evidence");
  assert.equal(ev.length, 1, `evidence 类只记一条（实际 ${ev.length} 条；本回合新增 ${JSON.stringify(news)}）`);
});

// ═══════ ⑤ 两类独立：detectTimeRule 纯函数 ═══════

await group("⑤ detectTimeRule：双缺 2 条 / 已 Get-Date 只剩 evidence / 带锚未 Get-Date 只剩 getdate / 引述为空", () => {
  const lanes = (text, getDateSeen) => detectTimeRule({ turn: { getDateSeen } }, text, rule2).map((h) => h.lane);
  assert.deepEqual(lanes(PLAIN_NOW, false).sort(), ["evidence", "getdate"], `双缺须两条（实际 ${JSON.stringify(lanes(PLAIN_NOW, false))}）`);
  assert.deepEqual(lanes(PLAIN_NOW, true), ["evidence"], `已 Get-Date 只剩 evidence（实际 ${JSON.stringify(lanes(PLAIN_NOW, true))}）`);
  assert.deepEqual(lanes(NOW_WITH_EVIDENCE, false), ["getdate"], `带锚未 Get-Date 只剩 getdate（实际 ${JSON.stringify(lanes(NOW_WITH_EVIDENCE, false))}）`);
  assert.deepEqual(detectTimeRule({ turn: { getDateSeen: false } }, QUOTED, rule2), [], "引述语境须为空");
});

// ═══════ ⑥ 单一判定源：detectViolations 与 detectTimeRule 逐项相同（五种输入）═══════

await group("⑥ 五种输入下 detectViolations 的规则 2 条目与 detectTimeRule 逐项相同", () => {
  const cases = [
    { name: "当下词未 Get-Date", text: PLAIN_NOW, getDateSeen: false },
    { name: "已 Get-Date 无锚", text: PLAIN_NOW, getDateSeen: true },
    { name: "历史日期无锚", text: HIST_NO_EVIDENCE, getDateSeen: false },
    { name: "带证据锚", text: NOW_WITH_EVIDENCE, getDateSeen: false },
    { name: "引述语境", text: QUOTED, getDateSeen: false }
  ];
  const diffs = [];
  cases.forEach((c, i) => {
    const session = getSessionState(state, `s6-${i}`);
    session.turn.getDateSeen = c.getDateSeen;
    const viaTime = detectTimeRule(session, c.text, rule2).map(norm);
    const viaDetect = detectViolations({ configs: state.configs, session, text: c.text, reasoningText: "" })
      .filter((v) => String(v.ruleId) === "2").map(norm);
    if (JSON.stringify(viaDetect) !== JSON.stringify(viaTime)) diffs.push({ case: c.name, viaDetect, viaTime });
  });
  assert.equal(diffs.length, 0, `五种输入须逐项相同（不等 ${diffs.length} 种：${JSON.stringify(diffs)}）`);
});

// ═══════ 汇总 + 清理 ═══════
try {
  rmSync(HOME, { recursive: true, force: true });
  delete process.env.DSH_HOME;
} catch { /* 清理失败不影响结论 */ }

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (r.ok) console.log(`PASS ${r.name}`);
  else console.log(`FAIL ${r.name}\n     ← ${r.err && r.err.message}`);
}
console.log(`\nRULE2-DELIVERY: ${results.length - failed.length} PASS / ${failed.length} FAIL`);
if (failed.length > 0) {
  console.log("（先红预期：引擎改造前 FAIL > 0；按类记账/按类撤销/合并投递/单一判定源落地后应 0 FAIL）");
  process.exitCode = 1;
} else {
  console.log("RULE2-DELIVERY: ALL PASSED");
}
