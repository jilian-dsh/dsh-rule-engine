// phase1f-inject.test.mjs - O1 注入通道修复验证（2026-08-24，批次 6）。
// 背景：maybeInject 在 session/event 观察回调内同步调用 agent.inject → 底层同步
// session.append（agent/inbox/spliced）命中 dsh-session 的同步重入保护
//（entry.appending → "session append cannot reenter while another append is being published"）
// → 注入从未到达模型/界面（README 局限 6）。
// 修复：延迟到 append 发布边界之后（宏任务 setTimeout 0）。
// 本测试用"同步栈内抛重入异常"的假 agent 模拟真实 dsh-session 行为：
//   - 修复前：同步栈内直接调用 → 抛异常 → 注入对象 0 次（测试失败）
//   - 修复后：同步栈内不调用（0 次）→ 延迟后成功投递 1 次（测试通过）
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 自包含环境（仿 phase1b/1c）：临时 DSH_HOME + import index.js（须保持在 run-all 末尾加载）
const home = mkdtempSync(join(tmpdir(), "dsh-re-phase1f-"));
process.env.DSH_HOME = home;

const { state } = await import("../lib/core/runtime.js");
const { handleSessionEvent } = await import("../lib/index.js");

// 屏蔽 AGENTS.md 解析/热重载（自包含规则集不依赖真实文件）
state.lastMtimeCheck = Date.now() + 3600_000;
state.configs = [
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
  }
];

const SID = "phase1f";
const ses = { id: SID };
const fire = (type, data) => handleSessionEvent(fakeCtx, ses, { type, data });

// A4（0.6.0）：M8 默认关闭 → 本机组显式配置 m8（与生产本机 rule-engine.json 同形态）
state.localIntegrations = { m8: { enabled: true, entryMarker: "example-manual-write.mjs" } };

// 假 ctx：agents.get 返回假 agent——inject 在"append 发布中"（同步栈内）抛真实异常，
// 发布边界后正常投递。audit 写临时 DSH_HOME 日志（测试隔离，不污染真实审计）。
const syncGuard = { appending: false };
const injected = [];
const fakeCtx = {
  agents: {
    get: () => ({
      inject(message) {
        if (syncGuard.appending) {
          throw new Error("session append cannot reenter while another append is being published");
        }
        injected.push(message);
      }
    })
  }
};

// 1) 建立一次 turn（turn/start）
fire("turn/start", { turn: 1 });

// 2) 模拟 M8 缺失：本回合 example-manual-write 落盘但未 engram_store → turn/end 触发 maybeInject
{
  const s = state.sessions.get(SID);
  assert.ok(s, "会话状态已建立");
  s.turn.manualWriteSeen = true;
  s.turn.engramStoreSeen = false;
}

// 3) 在"append 发布中"（同步栈内）触发 turn/end —— 正是真实重入场景
syncGuard.appending = true;
fire("turn/end", { turn: 1 });
syncGuard.appending = false;

// 修复前：同步栈内直接 agent.inject → 抛"cannot reenter" → 注入失败（injected 恒 0）
// 修复后：同步栈内不得直接投递——立即断言 0 次（否则就重蹈重入覆辙）
assert.equal(injected.length, 0, "同步栈内不得直接投递（必须避开 append 重入保护）");

// 4) 延迟投递验证：等过宏任务后 agent.inject 应被调用一次
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(injected.length, 1, "延迟后恰好投递一次");
assert.ok(
  Array.isArray(injected[0].content) && injected[0].content[0]?.text?.includes("[规则引擎]"),
  "注入内容为规则引擎纠正提示"
);
assert.equal(injected[0].source?.kind, "plugin", "注入来源标记为插件");
// 批次 6 收尾（O1 实弹观测）：官方消息必须有唯一 id + role（无 id → Inbox validate 用 undefined 身份，
// 同批第二条起抛 `message "undefined" is already pending`——实弹 17:56:37 八连发）
assert.equal(typeof injected[0].id, "string", "注入消息带 id 字段");
assert.ok(injected[0].id.length > 0, "id 非空（防 pending 撞车）");
assert.equal(injected[0].role, "user", "注入消息 role=user（官方 createUserMessage 结构）");

// 5) 重复触发同规则 → 计数上限 3 内的第二次仍投递；超出不投递（injectCounts 逻辑保持）
{
  const s = state.sessions.get(SID);
  s.turn.manualWriteSeen = true;
  s.turn.engramStoreSeen = false;
}
fire("turn/end", { turn: 2 });
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(injected.length, 2, "同规则同会话第 2 次仍投递（上限内）");

// 6) 注入噪音治理 v0.5.6（建议1/B1 聚合注入）：assistant/message 同回合多条违规 → 聚合为一条注入
{
  const { understandRule } = await import("../lib/core/understander.js");
  state.configs = state.configs.concat([
    understandRule({ index: "14", title: "汇报规范", level: "D", body: "- **触发**：汇报/总结。\n- **检查**：一次性完整汇报。\n- **动作**：自证。" }),
    understandRule({ index: "16", title: "建议提出规范", level: "D强", body: "- **触发**：建议。\n- **检查**：绑定检查格式。\n- **动作**：自证。" }),
    understandRule({ index: "26", title: "GitHub Release 发布规范", level: "D", body: "- **触发**：发布 Release。\n- **检查**：确认正式 Release Asset。\n- **动作**：自证。" })
  ]);
  fire("turn/start", { turn: 3 });
  // v0.5.7 适配：违规检测只在"真实用户在场"回合进行——本用例先发一条真实用户消息
  fire("user/message", { message: { content: "继续处理", source: { kind: "user" } } });
  // v0.5.7 适配：D 级嫌疑走裁决——stub 裁决返回"确认违规"（生产=judge.js LLM 实现）
  state.judgeFn = async (_ctx, _st, _sid, v, _text) => ({ action: "deliver", note: "stub", model: "stub" });
  const before = injected.length;
  fire("assistant/message", { message: { content: "本次总结如下：建议优化，已发布 Release 附件" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(injected.length, before + 1, "多条违规聚合为一条注入（3 项 → 1 条）");
  const aggText = injected[injected.length - 1].content?.[0]?.text || "";
  assert.ok(aggText.includes("[规则引擎]"), "聚合注入仍为规则引擎提示");
  assert.ok(aggText.includes("裁决通过 3 项"), "v0.5.7：聚合注入列明裁决通过数量（嫌疑→裁决→聚合）");
  assert.ok(
    aggText.includes("规则 14（") && aggText.includes("规则 16（") && aggText.includes("规则 26（"),
    "聚合注入列出全部规则明细"
  );
}

// ── v0.5.7 系列：① 注入轮不检测（乒乓根治）② 裁决通过才投递 ③ 每规则一次 ④ 预算拦截 ──

// ① 注入轮：无真实用户消息的回合 → assistant/message 不检测、不投递
{
  const before = injected.length;
  fire("turn/start", { turn: 4 });
  fire("assistant/message", { message: { content: "等待你的指令，不再提出新建议。规则 16 自证：无新建议、无重复推销" } });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(injected.length, before, "注入轮（无真实用户消息）不检测不投递——乒乓燃料清零");
}

// ② 真实用户轮：嫌疑→裁决（stub=确认违规）→ 投递（先清空预算窗口，保证额度）
{
  state.injectBudget.set(SID, [Date.now() - 2 * 3600 * 1000]); // 预算窗口外（历史上第一条计入前窗口）
  const before = injected.length;
  fire("turn/start", { turn: 5 });
  fire("user/message", { message: { content: "帮我看下这个问题", source: { kind: "user" } } });
  fire("assistant/message", { message: { content: "等待你的指令，不再提出新建议。规则 16 自证：无新建议、无重复推销" } });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(injected.length, before + 1, "真实用户轮：裁决通过 → 投递 1 条（judge-pass）");
}

// ③ 每规则一次：同规则再次"裁决通过"→ dedup 拦截（不重复投递）
{
  const before = injected.length;
  fire("turn/start", { turn: 6 });
  fire("user/message", { message: { content: "继续排查一下", source: { kind: "user" } } });
  fire("assistant/message", { message: { content: "正在排查，建议优化一下路径配置" } });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(injected.length, before, "同规则同会话第二次 → dedup（提醒一次并记住）");
}

// ④ 预算：把预算时间戳填满（3 条/小时）→ 新规则裁决通过也不投递（inject-skip 审计兜底）
{
  const now = Date.now();
  state.injectBudget.set(SID, [now - 1000, now - 2000, now - 3000]);
  const before = injected.length;
  fire("turn/start", { turn: 7 });
  fire("user/message", { message: { content: "再检查一遍", source: { kind: "user" } } });
  fire("assistant/message", { message: { content: "本次总结如下：关键点已列出" } });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(injected.length, before, "会话每小时预算已满（3 条）→ 不投递（只审计 inject-skip）");
}

console.log("phase1f-inject.test.mjs PASS");
