// m8-hint.test.mjs - D 项「M8 提示前移到 tool/result」的先红测试（2026-09-13）。
//
// 背景：M8 双通道（统一入口落盘后必须同回合 engram_store）的检测与提示都在 turn/end，
// 而 turn/end 之后模型不再行动 → 提示只能影响下一回合，等于「事后才说」。
// D 项把**提示**前移到 tool/result（落盘成功被识别的那一刻），turn/end 的审计保留。
//
// 本测试断言的是「提示在 tool/result 阶段即投递」——实现前必红（当前只在 turn/end 投递）。
//
// 测试隔离：自包含临时 DSH_HOME + import index.js（须与 run-all 的加载顺序约定一致）。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "dsh-re-m8hint-"));
process.env.DSH_HOME = home;

const { state } = await import("../lib/core/runtime.js");
const { handleSessionEvent } = await import("../lib/index.js");

// 屏蔽 AGENTS.md 解析/热重载（自包含规则集，不依赖真实文件）
state.lastMtimeCheck = Date.now() + 3600_000;
state.configs = [];

const ENTRY_CMD = 'node scripts/example-manual-write.mjs local "D:/.dsh/AGENTS.md" x';

function makeHarness(sid) {
  const injections = [];
  const ctx = { agents: { get: () => ({ inject: (msg) => injections.push(msg) }) } };
  const ses = { id: sid };
  const fire = (type, data) => handleSessionEvent(ctx, ses, { type, data });
  const runEntryWrite = (callId) => {
    fire("user/message", { content: [{ type: "text", text: "落盘手册" }], role: "user", id: `m-${callId}`, surfaceOp: "append" });
    fire("tool/call", { name: "pwsh", callId, arguments: { command: ENTRY_CMD } });
    fire("tool/result", {
      callId,
      message: { content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text: "MANUAL_WRITE_OK" }] }] }
    });
  };
  return { injections, fire, runEntryWrite };
}

// ── 正例：hintOnWrite 开启 → 落盘成功后提示应在 tool/result 阶段投递 ──
{
  state.localIntegrations = { m8: { enabled: true, entryMarker: "example-manual-write.mjs", hintOnWrite: true } };
  const h = makeHarness("m8h-on");
  h.runEntryWrite("c1");
  await new Promise((r) => setTimeout(r, 60)); // 注入为 setTimeout(0) 延迟投递
  assert.equal(
    h.injections.length,
    1,
    "★ 落盘成功后应在 tool/result 阶段即投递提示（D 项核心；实现前此处为 0 → 必红）"
  );
  assert.ok(
    h.injections[0].content?.[0]?.text?.includes("engram_store"),
    "提示内容指向 engram_store（双通道约定）"
  );
  assert.ok(
    h.injections[0].content?.[0]?.text?.includes("[规则引擎]"),
    "提示沿用规则引擎注入格式"
  );

  // 一次性闸：随后 turn/end 不得重复投递（maybeInject 同会话同规则只投递一次）
  h.fire("turn/end", {});
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.injections.length, 1, "turn/end 不重复投递（同会话同规则一次性）");
}

// ── 反例：hintOnWrite 缺省（未开启）→ 不提前提示；turn/end 审计路径仍在 ──
{
  state.localIntegrations = { m8: { enabled: true, entryMarker: "example-manual-write.mjs" } };
  const h = makeHarness("m8h-off");
  h.runEntryWrite("c2");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.injections.length, 0, "未开启 hintOnWrite → 不在 tool/result 阶段提示（默认关）");

  // turn/end 的既有路径保留：此时才投递（一次性闸尚未被消耗）
  h.fire("turn/end", {});
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.injections.length, 1, "turn/end 既有路径保留（默认关时行为与改动前一致）");
}

// ── 反例：同回合已先 engram_store → 其后的落盘不再提示 ──
// 顺序说明：现实中常见「先落盘、后沉淀」，落盘那一刻引擎无法预知模型会不会补，故提示一次（预期行为）。
// 本用例覆盖的是「已沉淀」的事实分支：engramStoreSeen 已置位 → 后续落盘不再提示。
{
  state.localIntegrations = { m8: { enabled: true, entryMarker: "example-manual-write.mjs", hintOnWrite: true } };
  const h = makeHarness("m8h-done");
  h.fire("user/message", { content: [{ type: "text", text: "沉淀记忆" }], role: "user", id: "m-done", surfaceOp: "append" });
  h.fire("tool/call", { name: "engram_store", callId: "c5", arguments: { text: "x" } });
  h.fire("tool/result", {
    callId: "c5",
    message: { content: [{ type: "tool-result", toolCallId: "c5", content: [{ type: "text", text: "stored" }] }] }
  });
  h.runEntryWrite("c6");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.injections.length, 0, "同回合已先 engram_store → 其后的落盘不再提示");
}

// ── C1（批 3，2026-09-15）：干跑／失败**不得**置位落盘标记 ──
// 原判据只看「命令文本含 entryMarker」（lib/index.js 的 M8 段），不看是否真的落盘成功 →
// `--dry-run`、写夹具目录、脚本中途失败（只要工具层未标 isError）都会置位 manualWriteSeen，
// 进而于 turn/end 判 `__engram-gap` 并要求同回合 engram_store（本会话实证：dry-run 亦被提示）。
// 判据收紧为「命令含 entryMarker **且** 结果文本含 MANUAL_WRITE_OK」（统一入口成功标志）。
{
  state.localIntegrations = { m8: { enabled: true, entryMarker: "example-manual-write.mjs", hintOnWrite: true } };
  const h = makeHarness("m8c1-dry");
  h.fire("user/message", { content: [{ type: "text", text: "落盘手册" }], role: "user", id: "m-dry", surfaceOp: "append" });
  h.fire("tool/call", { name: "pwsh", callId: "c1dry", arguments: { command: ENTRY_CMD + " --dry-run" } });
  h.fire("tool/result", {
    callId: "c1dry",
    message: { content: [{ type: "tool-result", toolCallId: "c1dry", content: [{ type: "text", text: "DRY-RUN: 将应用 2 处编辑（不写入）" }] }] }
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(
    h.injections.length,
    0,
    "★ 干跑（结果无 MANUAL_WRITE_OK）不得置位落盘标记、不得提示（C1 修复点；实现前此处为 1 → 必红）"
  );

  // 反向锁（防收紧过头）：真落盘（结果含 MANUAL_WRITE_OK）仍须标记并提示一次。
  // 用独立会话，避免「同会话同规则投递上限」干扰判定。
  const h2 = makeHarness("m8c1-ok");
  h2.runEntryWrite("c1ok");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h2.injections.length, 1, "真落盘（有 MANUAL_WRITE_OK）仍须提示一次——防判据收紧过头");
}

console.log("m8-hint.test.mjs PASS");
