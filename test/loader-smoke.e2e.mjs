// loader-smoke.e2e.mjs - 组合冒烟测试（2026-08-26，对齐官方 docs/testing.zh.md）。
// 落实官方原则：
//  1. 真实实现优先：import 真实 index.js（引擎主体全真）+ 真实审计文件（自设临时 DSH_HOME）；
//     guardDecision（22-7 判定）真实调用——"可以"授权判定走真实裁决链。
//  2. 只 mock 不确定边界：LLM 适配器（ctx.llm.stream 按 prompt 类型返回预置 JSON）。
//  3. 验证外部世界而非自我报告：断言临时 DSH_HOME 的审计 JSONL 里真实出现
//     judge-false / judge-pass / inject 记录——不是对输出做关键词探测。
// 场景：
//  A. 用户消息"可以" → 词表低置信 → LLM 意图判定（mock 判 hasExecute:true）→
//     guardDecision(write) 放行（"可以"归位的验收线）。
//  B. 真实用户轮 + assistant 含嫌疑文本 → 真实裁决接线 → mock LLM 判 violated:false
//     → 审计落 judge-false、无注入（合规声明不打扰）。
//  C. mock LLM 翻转为 violated:true → judge-pass + 投递 1 条（聚合形态）。
// 断言失败条件（测试有效性声明）：B/C 若裁决接线断开（judgeFn 未接 judgeViolation）→ 红；
//  A 若 llmIntent 未接入 22-7 → 红；任一断言若在"删除对应接线"后仍绿 = 该断言无效。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useChineseLexicons, useChinesePatterns } from "./helpers.mjs";

const home = mkdtempSync(join(tmpdir(), "dsh-re-smoke-"));
process.env.DSH_HOME = home;

// P8 词表配置化（2026-09-08）后内置词表=语言无关通用最小集，而本测试样本全为中文——
// 必须与 run-all 入口同源注入中文夹具（模块级状态，须在引擎模块动态 import 之前）。
// 缺此注入：C 步「本次总结如下」检测不到 → 裁决未触发 → 断言 0 !== 1（verify-all 组合冒烟曾因此红）。
{
  const lex = useChineseLexicons();
  const pat = useChinesePatterns();
  if (lex.rejected.length > 0 || pat.rejected.length > 0) {
    throw new Error(`中文夹具注入失败: ${JSON.stringify({ lexicons: lex.rejected, patterns: pat.rejected })}`);
  }
}

const { state } = await import("../lib/core/runtime.js");
const { handleSessionEvent, criticismFreezeDecision } = await import("../lib/index.js");
const { guardDecision } = await import("../lib/core/guard-core.js");

state.lastMtimeCheck = Date.now() + 3600_000; // 屏蔽文件热重载（自包含）
state.configs = [
  // 22：沟通直接性（22-7 主干）——手写 cfg（与 phase1f 同形态）
  {
    ruleId: "22",
    title: "沟通直接性",
    level: "C+D",
    actions: ["ask", "deny"],
    handler: "rule22-7-direct",
    confidence: "high",
    disabled: false,
    hints: [],
    elements: {},
    triggerKeywords: []
  },
  { ruleId: "16", title: "建议提出规范", level: "D强", actions: ["self-certify"], handler: null, confidence: "high", disabled: false, hints: [], elements: {}, triggerKeywords: [] },
  { ruleId: "14", title: "汇报规范", level: "D", actions: ["self-certify"], handler: null, confidence: "high", disabled: false, hints: [], elements: {}, triggerKeywords: [] }
];

const SID = "smoke";
const ses = { id: SID };
const injected = [];
let judgeCalls = 0; // 区分 judge 场景：第一次 false、第二次 true

// 唯一 mock 边界：LLM 适配器——按 prompt 类型返回预置 JSON
const fakeLlm = {
  listProviders: () => [{ id: "fake-official", name: "Fake Official" }],
  listModels: async () => [{ id: "fake-model", name: "Fake" }],
  async *stream(options) {
    const text = (options && options.messages && options.messages[0] && options.messages[0].content && options.messages[0].content[0]?.text) || "";
    if (text.includes("意图判定器")) {
      yield { type: "text-delta", text: '{"hasExecute":true,"hasPlan":false,"hasQuestion":false,"ambiguous":false,"reason":"用户授权确认","confidence":0.85}' };
      return;
    }
    judgeCalls += 1;
    // B（第1次）判假（合规声明）、C（第2次）判真（确属违规）、D（第3次）判假（"完成"字样但非交付声明）
    const verdict = judgeCalls === 2
      ? '{"violated": true, "note": "确属重复推销"}'
      : '{"violated": false, "note": "非交付声明或合规表述"}';
    yield { type: "text-delta", text: verdict };
  }
};
const fakeCtx = {
  llm: fakeLlm,
  agents: {
    get: () => ({
      inject(message) {
        injected.push(message);
      }
    })
  }
};

const fire = (type, data) => handleSessionEvent(fakeCtx, ses, { type, data });
const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));

// ── A. "可以" 授权归位（验收线）：词表低置信 → LLM 意图判定 → 22-7 放行 ──
fire("turn/start", { turn: 1 });
fire("user/message", { message: { content: "可以", source: { kind: "user" } } });
await wait(); // 等 LLM 意图预取落位（turn.llmIntent）
const exec = { name: "write", arguments: { file_path: join(home, "ok.txt") }, agent: { session: ses } };
const hitA = guardDecision(state, exec, Date.now(), { audit: () => {} });
assert.equal(hitA, null, "A：用户'可以'经 LLM 意图裁决 → 22-7 放行（归位验收线）");

// ── B. 嫌疑（12:37 原文：泛化 16 命中，含合规声明） → 裁决判假 → judge-false 落审计、无注入 ──
fire("turn/start", { turn: 2 });
fire("user/message", { message: { content: "帮我看下方案", source: { kind: "user" } } });
fire("assistant/message", { message: { content: "等待你的指令，不再提出新建议。规则 16 自证：无新建议、无重复推销；只等待你的明确指令。" } });
await wait();
assert.equal(injected.length, 0, "B：合规声明+已自证 → 不应该产生任何注入");

// ── C. 嫌疑（规则 14 泛化） → 裁决判真 → judge-pass + 投递 1 条 ──
fire("turn/start", { turn: 3 });
fire("user/message", { message: { content: "再确认一次", source: { kind: "user" } } });
fire("assistant/message", { message: { content: "本次总结如下：关键点已列出" } });
await wait();
assert.equal(injected.length, 1, "C：裁决判真 → 投递 1 条");
assert.ok(injected[0].content?.[0]?.text?.includes("[规则引擎]"), "C：投递内容为规则引擎提示");

// ── D. 23④ 暗示型（用户拍板）：词面"完成"命中但非交付声明 → 裁决判假 → 不新增投递 ──
fire("turn/start", { turn: 4 });
fire("user/message", { message: { content: "检查一下", source: { kind: "user" } } });
fire("assistant/message", { message: { content: "已完成社区检索和手册比对，结果如下" } });
await wait();
assert.equal(injected.length, 1, "D：'完成'字样（非交付声明）→ 裁决判假 → 不新增投递");

// ── E. 白名单 v2 持久化（0.5.9）：用户"允许使用 X" → 会话白名 + 落盘 v2 对象数组（带时间/来源元数据）──
fire("turn/start", { turn: 5 });
fire("user/message", { content: [{ type: "text", text: "允许使用 future_tool_e2e" }], role: "user", id: "me5", surfaceOp: "append", source: { kind: "user" } });
await wait();
const wl = JSON.parse(readFileSync(join(home, "rule-engine-tools.json"), "utf8"));
assert.ok(Array.isArray(wl) && wl.some((r) => r.name === "future_tool_e2e" && typeof r.time === "number" && r.session === SID), "E：白名单落盘 v2（对象数组，带 time/session 元数据）");
assert.ok(state.unknownToolApproved?.has("future_tool_e2e"), "E：会话白名内存态生效");
assert.ok(state.unknownToolSessionAdded?.has("future_tool_e2e"), "E：本会话新增标记（/guard tools 可区分）");

// ── F. §1.3 行为闸（2026-09-08 第二批 A″）：批评疑似回合 → 写类工具冻结（真实纯函数调用）──
{
  const frozen = { turn: { criticismFrozen: true, criticismSuspect: "strong" } };
  assert.ok(criticismFreezeDecision(frozen, "write", {}), "F：批评回合 write 被冻结");
  assert.ok(criticismFreezeDecision(frozen, "pwsh", { command: "Set-Content f.txt x" }), "F：批评回合 pwsh（写命令）被冻结");
  assert.equal(criticismFreezeDecision(frozen, "pwsh", { command: "Get-Content f.txt" }), null, "F：批评回合 pwsh（只读命令）不受限");
  assert.ok(String(criticismFreezeDecision(frozen, "write", {})).includes("四段模板"), "F：拒绝原因含四段模板指引");
  assert.equal(criticismFreezeDecision(frozen, "read", {}), null, "F：只读工具不受限");
  assert.equal(criticismFreezeDecision({ turn: {} }, "write", {}), null, "F：普通回合 write 不受限");
  assert.equal(criticismFreezeDecision({ turn: { criticismFrozen: true } }, "grep", {}), null, "F：批评回合 grep 不受限");
}

// ── 外部世界断言：审计 JSONL 真实存在对应记录 ──
const log = readFileSync(join(home, "rule-engine.log.jsonl"), "utf8");
assert.ok(log.includes('"kind":"judge-false"'), "审计存在 judge-false（裁决判假留痕）");
assert.ok(log.includes('"kind":"judge-pass"'), "审计存在 judge-pass（裁决判真留痕）");
assert.ok(log.includes('"kind":"verify-gap"'), "审计存在 verify-gap（23④ 嫌疑留痕——含 D 场景）");
assert.ok(log.includes('"kind":"inject"'), "审计存在投递记录");
assert.ok(log.includes('"kind":"intent-llm"'), "审计存在 LLM 意图判定记录（A 场景）");
assert.ok(log.includes('"kind":"unknown-tool-whitelist"'), "审计存在白名单放行记录（E 场景）");

console.log("loader-smoke.e2e.mjs PASS（组合冒烟：真实接线 + 外部世界验证 + 「可以」归位验收线 + 白名单 v2 元数据）");
