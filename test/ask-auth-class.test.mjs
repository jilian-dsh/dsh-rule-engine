// ask-auth-class.test.mjs — 执行单 3-4 已选 (b) 的先红（2026-09-22，session-eb606909）
//   仿 contract-card-hits：临时 DSH_HOME → 动态 import apply（mock Cordis ctx）→ 收集 tools/pre-execute
//   与 session/event 钩子。
//   断言 ①（先红主项）：契约拒绝一次 pwsh 之后，会话上的 lastDeniedType 为 "command"。
//     现盘没有这个字段（拒绝路径只写卡片/lastActive/deniedKeys）→ 应失败即停。
//   断言 ②（其后）：询问文本同时含「提交」与「运行」命令、且没有 lastDeniedType 时，
//     ask 通过后的授权里 command 与 git 都在；现盘只留 git（classifyAskScopeType 单值＋优先序）。
//   本文件不 import index.js 的导出面（只动态 import 整模块并调 apply）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionState } from "../lib/core/state.js";
import { defaultContract } from "../lib/core/contract.js";
// 中文许可词/类型词夹具：内置词表是语言无关英文最小集（机制层零本机内容），
// 「确认」要能被 askResultApproved 认成批准、git/command 要能被 typeHints 命中，须先注入与
// 本机 rule-engine.json 同源的夹具（与 run-all 同法）。
import { useChineseLexicons, useChineseTypeHints } from "./helpers.mjs";

const dir = mkdtempSync(join(tmpdir(), "dsh-rule-engine-askclass-"));
process.env.DSH_HOME = dir;
process.env.DSH_WORKSPACE = process.cwd();

const disposers = [];
const preExecuteHooks = [];
const sessionEventHooks = [];
const ctx = {
  effect(fn) {
    const it = fn();
    const first = it.next();
    if (!first.done && typeof first.value === "function") disposers.push(first.value);
  },
  on(event, fn) {
    if (event === "tools/pre-execute") preExecuteHooks.push(fn);
    if (event === "session/event") sessionEventHooks.push(fn);
  },
  tools: { guard() { return () => {}; } },
  commands: { register() { return () => {}; } },
  agents: { get() { return null; } },
  workspaceRegistry: { list() { return []; } },
  logger: { info() {}, warn() {} }
};

const mod = await import("../lib/index.js");
mod.apply(ctx);
useChineseLexicons(); // 「确认」→ 批准词
useChineseTypeHints(); // 「提交」→ git 等类型词
assert.ok(preExecuteHooks.length > 0, "tools/pre-execute 钩子应已注册");
assert.ok(sessionEventHooks.length > 0, "session/event 钩子应已注册");

// 与 contract-card-hits 同口径：插件闭包读 lib/core/runtime.js 的单例 state
const state = (await import("../lib/core/runtime.js")).state;
state.enabled = true;
const sid = "ask1";
state.taskContract = { taskContractEnabled: true, askEnabled: false, taskContractMode: "armed" };
const s = getSessionState(state, sid);
s.contract = { ...defaultContract(), mode: "answer", level: "guard" };

// 调用工具时逐链把 next 传下去（后续钩子照常执行，不改变本夹具的断言口径）
const makeChain = () => {
  let i = 0;
  const next = async () => {
    while (i < preExecuteHooks.length) {
      const hook = preExecuteHooks[i++];
      const res = await hook(exec, next);
      if (res) return res;
    }
    return undefined;
  };
  return next;
};

let exec = null;
const denyOnePwsh = async () => {
  const next = makeChain();
  const hook = preExecuteHooks[0];
  return hook(exec, next);
};

// ── 断言 ①（先红）：契约拒绝一次 pwsh（node 命令，类型应为 command）→ 会话上记 lastDeniedType ──
exec = {
  name: "pwsh",
  arguments: { command: "node scripts/dualtrack-check.mjs --update" },
  agent: { session: { id: sid } }
};
const denied = await denyOnePwsh();
assert.ok(
  denied && denied.kind === "deny" && String(denied.reason).includes("[guardian:contract]"),
  "前置：契约钩子应对该 pwsh 调用返回 deny"
);
assert.equal(
  getSessionState(state, sid).lastDeniedType,
  "command",
  "契约拒绝后应把该次 operationOf 的 type 记在会话上（lastDeniedType=command）——现盘无此字段"
);

// ── 断言 ②（其后）：ask 通过后，授权里 command 与 git 都在（无 lastDeniedType 时的文本兜底）──
// 走现盘真实链：tool/call 建 pendingAsk → tool/result 带 answers 触发登记（与 phase1c 同法）
const sid2 = "ask2";
const askQuestions = [{ id: "q1", question: "确认提交并运行 node 脚本？", header: "确认", options: [{ label: "确认" }] }];
for (const hook of sessionEventHooks) {
  await hook(
    { id: sid2 },
    { type: "tool/call", data: { name: "ask_user_question", callId: "call-ask-1", arguments: { questions: askQuestions } } }
  );
}
const askEvent = {
  type: "tool/result",
  data: {
    callId: "call-ask-1",
    message: {
      content: [
        {
          type: "tool-result",
          toolCallId: "call-ask-1",
          content: [{ type: "text", text: JSON.stringify({ answers: [{ id: "ask_auth", selected: ["确认"] }] }) }]
        }
      ]
    }
  }
};
for (const hook of sessionEventHooks) {
  await hook({ id: sid2 }, askEvent);
}
const types = (getSessionState(state, sid2).authorizations || []).map((a) => a.type);
assert.ok(types.includes("git"), `ask 授权里应含 git（现盘应命中；实际 ${JSON.stringify(types)}）`);
assert.ok(
  types.includes("command"),
  `ask 授权里也应含 command——询问文本同时含提交与运行命令时两类都留（实际 ${JSON.stringify(types)}）`
);

// ── 断言 ③（新）：同一会话内「先被拦一次 pwsh（→ command）→ 再让询问通过」，
//    类别按被拦那次调用决定，不被询问文本里的 git 词带偏 ──
const sid3 = "ask3";
const s3 = getSessionState(state, sid3);
s3.contract = { ...defaultContract(), mode: "answer", level: "guard" };
const exec3 = {
  name: "pwsh",
  arguments: { command: "node scripts/dualtrack-check.mjs --update" },
  agent: { session: { id: sid3 } }
};
let deny3 = null;
{
  let i = 0;
  const next3 = async () => {
    while (i < preExecuteHooks.length) {
      const hook = preExecuteHooks[i++];
      const res = await hook(exec3, next3);
      if (res) return res;
    }
    return undefined;
  };
  deny3 = await preExecuteHooks[0](exec3, next3);
}
assert.ok(
  deny3 && deny3.kind === "deny" && String(deny3.reason).includes("[guardian:contract]"),
  "断言③前置：该 pwsh 调用应先被契约拒绝一次"
);

const askQuestions3 = [{ id: "q1", question: "确认删除并提交？", header: "确认", options: [{ label: "确认" }] }];
for (const hook of sessionEventHooks) {
  await hook(
    { id: sid3 },
    { type: "tool/call", data: { name: "ask_user_question", callId: "call-ask-3", arguments: { questions: askQuestions3 } } }
  );
}
const askEvent3 = {
  type: "tool/result",
  data: {
    callId: "call-ask-3",
    message: {
      content: [
        {
          type: "tool-result",
          toolCallId: "call-ask-3",
          content: [{ type: "text", text: JSON.stringify({ answers: [{ id: "ask_auth", selected: ["确认"] }] }) }]
        }
      ]
    }
  }
};
for (const hook of sessionEventHooks) {
  await hook({ id: sid3 }, askEvent3);
}
const types3 = (getSessionState(state, sid3).authorizations || []).map((a) => a.type);
assert.ok(types3.includes("command"), `断言③：授权类型里应有 command（实际 ${JSON.stringify(types3)}）`);
assert.ok(types3.includes("delete"), `断言③：授权类型里应有 delete（实际 ${JSON.stringify(types3)}）`);
assert.ok(
  !types3.includes("git"),
  `断言③：授权类型里不该有 git——类别由被拦那次调用决定（实际 ${JSON.stringify(types3)}）`
);

for (const d of disposers) if (typeof d === "function") d();
rmSync(dir, { recursive: true, force: true });
delete process.env.DSH_HOME;

console.log("ask-auth-class.test.mjs PASS");
