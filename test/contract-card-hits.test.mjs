// contract-card-hits.test.mjs — 件 B 先红（2026-09-22，session-eb606909）
//   件 B：契约拒绝与未归类工具拒绝要写进 cardHits（回合卡片数据源）。
//   本夹具仿 test/runtime-smoke.mjs：临时 DSH_HOME → 动态 import apply（mock Cordis ctx）→
//   用 ctx.on 收集 tools/pre-execute 钩子（不 import index.js 的导出面）。
//   场景：会话契约 mode=answer、level=guard；任务契约 enabled 且 mode=armed；
//        对 write 工具（edit）调用契约钩子 → 返回 deny；
//        且该会话 s.turn.cardHits 至少一条、ruleId === "__task-contract"。
//   现盘：契约钩子（lib/index.js L2032–2043）只 audit 不写 cardHits → 本夹具应红。
//   未归类工具本枪不测（按用户口径）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionState } from "../lib/core/state.js";
import { defaultContract } from "../lib/core/contract.js";

const dir = mkdtempSync(join(tmpdir(), "dsh-rule-engine-cardhits-"));
process.env.DSH_HOME = dir;
process.env.DSH_WORKSPACE = process.cwd();

const disposers = [];
const preExecuteHooks = [];
const ctx = {
  effect(fn) {
    const it = fn();
    const first = it.next();
    if (!first.done && typeof first.value === "function") disposers.push(first.value);
  },
  on(event, fn) {
    if (event === "tools/pre-execute") preExecuteHooks.push(fn);
  },
  tools: { guard() { return () => {}; } },
  commands: { register() { return () => {}; } },
  agents: { get() { return null; } },
  workspaceRegistry: { list() { return []; } },
  logger: { info() {}, warn() {} }
};

const mod = await import("../lib/index.js");
mod.apply(ctx);
assert.ok(preExecuteHooks.length > 0, "tools/pre-execute 钩子应已注册（含契约钩子）");

// ── 契约钩子（唯一裁决点）：deny 由它返回；逐个试已注册的 pre-execute 钩子，取契约那条 ──
// 关键：必须用插件同一份运行时单例（lib/core/runtime.js 的 state）——index.js 钩子闭包读的就是它；
// 另建 createState() 的 state 与插件不是同一个对象，契约设置对钩子不可见（本夹具首版即踩此坑）。
const state = (await import("../lib/core/runtime.js")).state;
state.enabled = true;
const sid = "card1";
state.taskContract = { taskContractEnabled: true, askEnabled: false, taskContractMode: "armed" };
const s = getSessionState(state, sid);
s.contract = { ...defaultContract(), mode: "answer", level: "guard" };

const exec = {
  name: "edit",
  arguments: { file_path: "D:/a.txt", old_string: "a", new_string: "b" },
  agent: { session: { id: sid } }
};

const next = async () => undefined;
let contractDeny = null;
for (const hook of preExecuteHooks) {
  const res = await hook(exec, next);
  if (res && res.kind === "deny" && typeof res.reason === "string" && res.reason.includes("[guardian:contract]")) {
    contractDeny = res;
    break;
  }
}

// ── 断言 ①：契约钩子对该 write 调用返回 deny ──
assert.ok(contractDeny, "契约钩子应对 answer 模式下的 write 调用返回 deny");

// ── 断言 ②（先红）：该会话 cardHits 至少一条 ──
const hits = Array.isArray(s.turn.cardHits) ? s.turn.cardHits : [];
assert.ok(hits.length >= 1, `契约拒绝应写入 cardHits（现盘应 0 条，实际 ${hits.length} 条）`);

// ── 断言 ③：其中一条 ruleId 为 __task-contract ──
assert.ok(
  hits.some((h) => h && h.ruleId === "__task-contract"),
  `cardHits 应含 ruleId="__task-contract" 的条目（实际：${JSON.stringify(hits)}）`
);

// ── 断言 ④（件 C 先红）：契约拒绝的钥匙要记进 deniedKeys ──
// 钥匙算法＝名字 ＋ 冒号 ＋ JSON.stringify(参数)，与 lib/index.js L852／L1915 逐字同；
// 不记则失败回执侧仍给 retryCounts 加一，第 4 次会从契约文案变成规则 1。
const expectKey = `${exec.name}:${JSON.stringify(exec.arguments || {})}`;
assert.ok(
  state.deniedKeys instanceof Set && state.deniedKeys.has(expectKey),
  `契约拒绝应记入 deniedKeys（键「${expectKey}」）——现盘契约钩子绕开 guard，不记此键`
);

// ── 断言 ⑤（件 B 后半）：未归类工具拒绝同样进卡片 ──
const sid2 = "card2";
getSessionState(state, sid2);
let unknownDeny = null;
for (const hook of preExecuteHooks) {
  const res = await hook(
    { name: "mystery_plugin_tool", arguments: { foo: "bar" }, agent: { session: { id: sid2 } } },
    next
  );
  if (res && res.kind === "deny" && typeof res.reason === "string" && res.reason.includes("尚未归类")) {
    unknownDeny = res;
    break;
  }
}
assert.ok(unknownDeny, "未归类工具钩子应对未知工具名返回 deny（「尚未归类」）");
const hits2 = getSessionState(state, sid2).turn.cardHits || [];
assert.ok(
  hits2.some((h) => h && h.ruleId === "__unknown-tool"),
  `未归类工具拒绝应写入 cardHits 且 ruleId="__unknown-tool"（实际：${JSON.stringify(hits2)}）`
);

// ── 断言 ⑥（件 C 后半）：未归类拒绝的钥匙同样要记进 deniedKeys（同名＋冒号＋JSON.stringify(参数)）──
const unknownArgs = { foo: "bar" };
const expectKeyU = `mystery_plugin_tool:${JSON.stringify(unknownArgs)}`;
assert.ok(
  state.deniedKeys instanceof Set && state.deniedKeys.has(expectKeyU),
  `未归类拒绝应记入 deniedKeys（键「${expectKeyU}」）`
);

for (const d of disposers) if (typeof d === "function") d();
rmSync(dir, { recursive: true, force: true });
delete process.env.DSH_HOME;

console.log("contract-card-hits.test.mjs PASS");
