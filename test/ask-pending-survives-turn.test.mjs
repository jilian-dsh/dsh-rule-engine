// ask-pending-survives-turn.test.mjs —— D2 回归（2026-09-10，独立 DSH_HOME 试点反馈 ERR-M9Z47H）
//
// 缺陷（已修）：待决 ask 原存在**回合级** `s.turn.pendingAsk`；用户先发新消息 → turn/start
//   → resetTurn 整体替换 `s.turn = freshTurn()` → pendingAsk 被刷成 null
//   → 随后到达的 ask 答复走不进登记分支（index.js `if (pending)`）→ **该次 ask 授权一条都不登记**。
// 实测证据：试点 session-46c74947 —— 用户消息 09:23:37.281Z → ask 答复 09:23:39.917Z（2.6s 后）
//   → 拦截 09:23:44.287Z；同会话另 11 次 ask（无并发用户消息）均登记成功。
//
// 本测试的**变红条件**（任一条失败即红）：
//   ① 步骤 ③b 直断「pendingAsk 跨 turn/start 存活」——旧实现此处为 null；
//   ② 步骤 ⑤ 断言授权池出现 source=ask 记录——旧实现此处为 0 条。
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离 DSH_HOME（audit 落盘同源；与 session-events.integration.test 同款做法）
const HOME = join(tmpdir(), "dsh-rule-engine-ask-pending-test");
mkdirSync(HOME, { recursive: true });
process.env.DSH_HOME = HOME;

const { state } = await import("../lib/core/runtime.js");
const { handleSessionEvent } = await import("../lib/index.js");
state.lastMtimeCheck = Date.now() + 3600_000;
state.configs = []; // 本测试只验证 ask 授权登记链，不涉及规则集

const SID = "ask-pending-survives-turn";
const ses = { id: SID };
const fire = (type, data) => handleSessionEvent(null, ses, { type, data });

// ① 回合开始
fire("turn/start", { turn: 1 });

// ② ask 发出（tool/call）
fire("tool/call", {
  callId: "c-ask-1",
  name: "ask_user_question",
  arguments: JSON.stringify({
    questions: [
      { id: "q_src", question: '确认授权：从 "D:\\example workspace\\src" 读取包，作为安装源？' },
      { id: "q_dst", question: '确认授权：向 "D:\\example workspace\\dst" 写入（安装插件与建 junction）？' }
    ]
  })
});

// ③ ★ 关键复现点：用户**先发新消息**（新回合开始 → resetTurn）
fire("turn/start", { turn: 2 });
fire("user/message", {
  content: [{ type: "text", text: "1、引擎阻拦反馈请补充完全" }],
  role: "user",
  id: "m-2",
  surfaceOp: "append"
});

// ③b 直断：待决 ask 必须跨 turn/start 存活（**旧实现下此处为 null → 红**）
{
  const s = state.sessions.get(SID);
  assert.ok(
    s.pendingAsk && s.pendingAsk.callId === "c-ask-1",
    `待决 ask 应跨 turn/start 存活（实际 ${JSON.stringify(s.pendingAsk)}）——变红条件①：pendingAsk 被 resetTurn 清空`
  );
  assert.equal(s.turn.pendingAsk, undefined, "回合级不再持有 pendingAsk（已迁会话级）");
}

// ④ ask 答复到达（tool/result）
fire("tool/result", {
  callId: "c-ask-1",
  result: {
    answers: [
      { id: "q_src", selected: ['授权：读取 "D:\\example workspace\\src" (Recommended)'] },
      { id: "q_dst", selected: ['授权：写入 "D:\\example workspace\\dst" (Recommended)'] }
    ]
  }
});

// ⑤ 断言：授权已登记（**旧实现下 0 条 → 红**）
{
  const s = state.sessions.get(SID);
  const auths = s.authorizations || [];
  assert.ok(
    auths.length >= 1,
    `ask 授权应被登记（实际 ${auths.length} 条）——变红条件②：登记分支因 pendingAsk 为空被跳过`
  );
  assert.ok(auths.some((a) => a.source === "ask"), "授权池应含 source=ask 记录");
  assert.equal(s.pendingAsk, null, "答复处理后应清空待决 ask（防跨回合误登记）");
}

console.log("ask-pending-survives-turn：跨回合待决 ask 存活 + 授权登记 2 项通过（D2 回归锁定）");
