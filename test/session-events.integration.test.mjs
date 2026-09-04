// session-events.integration.test.mjs - 事件→状态→裁决全链路集成测试（2026-08-24 根因修复验证）。
// 官方事件结构基准：@deepseek-ai/dsh-session/surface.js ——
//   user/message 的 event.data 就是消息对象本身（deriveEventMessage case 'user/message' 返回 event.data），
//   content 内嵌 <system-reminder> 注入块（官方注入机制烤进 content）。
// 旧引擎误取 d.message → 永远提取空文本 → 全拦（空 intents）/ 全放行（跳过）两个错误方向，本测试按官方结构锁定行为。
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setWorkspaceRoot } from "../lib/core/patterns.js";

setWorkspaceRoot("D:\\example workspace\\dsh-project");

// 2026-08-31（遗留项修复）：固定隔离 DSH_HOME，且目录真实创建——
// 此前依赖前置测试残留的环境状态（index.js 加载刻的 DSH_HOME 可能是已被删除的随机临时目录），
// audit() 的 appendFileSync 写失败被 catch 静默吞掉（audit.js L24），mount-audit-error 断言
// 读"最近 N 条"恒红（环境既有失败）。固定目录 + 创建 → 写/读同源、无滚动。
const INTEG_HOME = join(tmpdir(), "dsh-rule-engine-integration-test");
mkdirSync(INTEG_HOME, { recursive: true });
process.env.DSH_HOME = INTEG_HOME;

// 自包含规则集：run-all 中前置测试（guard.test.mjs）会污染 process.env.DSH_HOME，
// 动态 import 保证 index.js 在本文件设置完成后加载，并将 configs 固定为测试规则、
// 禁用 maybeReloadIfChanged 覆盖——不依赖真实 AGENTS.md。
const { state } = await import("../lib/core/runtime.js");
const { handleSessionEvent, extractUserText } = await import("../lib/index.js");
const { guardDecision } = await import("../lib/core/guard-core.js");
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

const SID = "itest";
const ses = { id: SID };
const fire = (type, data) => handleSessionEvent(null, ses, { type, data });
const exec = (name, args) => ({ name, agent: { session: { id: SID } }, arguments: args });
const WRITE = exec("write", { file_path: "D:\\example workspace\\dsh-project\\_inbox\\x.md", content: "x" });

// 1) 官方结构：合并注入 + 真实消息（当前 DSH 真实形态）
fire("user/message", {
  content: [{ type: "text", text: "<system-reminder>\n注入示例（含【执行】与“为什么吗”）\n</system-reminder>\n我已重启" }],
  role: "user", id: "m1", surfaceOp: "append"
});
{
  const s = state.sessions.get(SID);
  assert.equal(s.turn.userText, "我已重启", "剥离注入后取到真实消息");
  assert.equal(s.turn.intents.hasStatus, true, "状态信号识别");
  assert.equal(guardDecision(state, WRITE), null, "状态信号回合变更放行");
}

// 2) 官方结构：执行类消息 → 放行；疑问消息 → 规则 22 拦截（两个方向都验证）
fire("user/message", {
  content: [{ type: "text", text: "1、请补充进事故报告 2、请继续完善引擎" }],
  role: "user", id: "m2", surfaceOp: "append"
});
{
  const s = state.sessions.get(SID);
  assert.equal(s.turn.intents.hasExecute, true, "执行分点识别");
  assert.equal(guardDecision(state, WRITE), null, "执行回合变更放行");
}

fire("user/message", {
  content: [{ type: "text", text: "这个方案你了解吗？" }],
  role: "user", id: "m3", surfaceOp: "append"
});
{
  const s = state.sessions.get(SID);
  assert.equal(s.turn.intents.hasQuestion, true, "疑问识别");
  // 2026-08-28 A 方案（用户拍板，覆盖 2026-08-26 旧豁免）：疑问回合写 _inbox/正式路径 = 落盘/产出
  // → 应拦（_inbox 按分类文本定位=暂存待归位的产物，非调研工具）；临时区（logs/.analysis-tmp）仍放行；
  // 工作区外写入仍由 22 拦住（安全不降级）——三向都验证
  const hitInbox = guardDecision(state, WRITE);
  assert.ok(hitInbox && hitInbox.ruleId === "22", "疑问回合 + _inbox 落盘 → 规则 22 拦（A 方案）");
  assert.match(hitInbox.reason, /确认后保存|落盘/, "拦截文案含确认后落盘指引");
  const tmpCall = exec("write", { file_path: "D:\\example workspace\\dsh-project\\logs\\.analysis-tmp\\probe.mjs", content: "x" });
  assert.equal(guardDecision(state, tmpCall), null, "疑问回合 + 临时区诊断脚本 → 放行（调研工具）");
  const outsideCall = exec("write", { file_path: "D:\\tmp-zone\\outside.md", content: "x" });
  const hitOut = guardDecision(state, outsideCall);
  assert.ok(hitOut && hitOut.ruleId === "22", "疑问回合 + 工作区外写入 → 规则 22 仍拦（不误放行）");
}

// 3) 纯注入事件 → 跳过（状态不被覆盖）
fire("user/message", {
  content: [{ type: "text", text: "<system-reminder>只有注入内容</system-reminder>" }],
  role: "user", id: "m4", surfaceOp: "append"
});
{
  const s = state.sessions.get(SID);
  assert.equal(s.turn.userText, "这个方案你了解吗？", "纯注入不覆盖状态");
}

// 4) 旧形态 data.message 兼容
fire("user/message", { message: { content: [{ type: "text", text: "请继续" }] }, surfaceOp: "append" });
{
  const s = state.sessions.get(SID);
  assert.equal(s.turn.userText, "请继续", "旧形态 data.message 兼容");
}

// 4.5) 引擎自我注入消息（[规则引擎]...）不得被当成用户消息，也不得记录授权
{
  const s = state.sessions.get(SID);
  const authBefore = s.authorizations.length;
  fire("user/message", {
    content: [{ type: "text", text: "[规则引擎] 已有授权，无需重复询问：请直接执行" }],
    role: "user", id: "m4b", surfaceOp: "append"
  });
  assert.equal(s.turn.userText, "请继续", "引擎注入消息不覆盖用户状态");
  assert.equal(s.authorizations.length, authBefore, "引擎注入消息不新增授权记录");
}

// 5) 规则 22 粒度升级全链路：特定执行子句只放行覆盖范围内的变更
const SID2 = "itest-granular";
const ses2 = { id: SID2 };
const fire2 = (type, data) => handleSessionEvent(null, ses2, { type, data });
const exec2 = (name, args) => ({ name, agent: { session: { id: SID2 } }, arguments: args });
fire2("user/message", {
  content: [{ type: "text", text: "1. 修改 D:/a.txt\n2. 给出方案" }],
  role: "user", id: "m5", surfaceOp: "append"
});
{
  const s = state.sessions.get(SID2);
  assert.equal(s.turn.intents.hasExecute, true, "粒度量有执行分点");
  assert.ok(Array.isArray(s.turn.scopes) && s.turn.scopes.length === 1, "turn.scopes 已由 execute 子句填充");
  assert.equal(guardDecision(state, exec2("edit", { file_path: "D:/a.txt", old_string: "a", new_string: "b" })), null, "匹配路径放行");
  const hit = guardDecision(state, exec2("edit", { file_path: "D:/b.txt", old_string: "a", new_string: "b" }));
  assert.ok(hit && hit.ruleId === "22", "未覆盖路径被规则 22 拦截");
}

// 6) M8 双通道机制：统一入口落盘成功但同轮无 engram_store → turn/end 注入纠正
// A4（0.6.0）：M8 默认关闭 → 本机组显式注入 localIntegrations.m8 后断言生效
{
  const SID3 = "itest-m8";
  const injections = [];
  const fakeCtx = {
    agents: {
      get() {
        return {
          inject: (msg) => injections.push(msg)
        };
      }
    }
  };
  const ses3 = { id: SID3 };
  state.localIntegrations = {
    ...(state.localIntegrations || {}),
    m8: { enabled: true, entryMarker: "example-manual-write.mjs" }
  };
  const fire3 = (type, data) => handleSessionEvent(fakeCtx, ses3, { type, data });
  fire3("user/message", {
    content: [{ type: "text", text: "请落盘手册" }],
    role: "user", id: "m6", surfaceOp: "append"
  });
  fire3("tool/call", {
    name: "pwsh",
    callId: "c1",
    arguments: { command: "node scripts/example-manual-write.mjs local \"D:/.dsh/AGENTS.md\" x" }
  });
  fire3("tool/result", {
    callId: "c1",
    message: {
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          content: [{ type: "text", text: "ok" }]
        }
      ]
    }
  });
  fire3("turn/end", {});
  // 2026-08-24 批次 6（O1）：注入改为延迟投递（setTimeout 0，避开 session append 同步重入保护），
  // 断言需等待宏任务边界后再检查。
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    injections.some((i) => i.content?.[0]?.text?.includes("engram_store")),
    "M8: 统一入口后同轮缺 engram_store 会注入纠正（显式开启语义）"
  );
  // A4 新增用例 4b：无 m8 配置（默认关）→ 同样场景不注入
  const SID3b = "itest-m8-off";
  const injections2 = [];
  const fakeCtx2 = { agents: { get: () => ({ inject: (msg) => injections2.push(msg) }) } };
  const ses3b = { id: SID3b };
  delete state.localIntegrations?.m8; // 恢复默认关（正例配置文件为共享单例，需显式清除）
  const fire3b = (type, data) => handleSessionEvent(fakeCtx2, ses3b, { type, data });
  fire3b("user/message", {
    content: [{ type: "text", text: "请落盘手册" }],
    role: "user", id: "m6b", surfaceOp: "append"
  });
  fire3b("tool/call", {
    name: "pwsh",
    callId: "c1b",
    arguments: { command: "node scripts/example-manual-write.mjs local \"D:/.dsh/AGENTS.md\" x" }
  });
  fire3b("tool/result", {
    callId: "c1b",
    message: {
      content: [{ type: "tool-result", toolCallId: "c1b", content: [{ type: "text", text: "ok" }] }]
    }
  });
  fire3b("turn/end", {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    !injections2.some((i) => i.content?.[0]?.text?.includes("engram_store")),
    "A4-4b: 无 m8 配置（默认关）→ 不注入 M8 提醒"
  );
}

// extractUserText 单元（官方结构与兼容路径）
assert.equal(extractUserText({ content: [{ type: "text", text: "a" }] }), "a", "data 即消息对象");
assert.equal(extractUserText({ message: { content: [{ type: "text", text: "b" }] } }), "b", "data.message 兼容");
assert.equal(extractUserText({ content: "c" }), "c", "content 字符串");
assert.equal(extractUserText(undefined), "", "undefined → 空");

// 8) A1（2026-08-29）：审计命令被拦截（isError 无输出）≠ 审计发现 DUPLICATES——
// 被拦不注入"先移除多余挂载"（误导）；真 DUPLICATES 才注入；通过后 revision 同步。
{
  const SID4 = "itest-a1";
  const injections = [];
  const fakeCtx4 = {
    agents: {
      get() {
        return {
          inject: (msg) => injections.push(msg)
        };
      }
    }
  };
  const ses4 = { id: SID4 };
  const fire4 = (type, data) => handleSessionEvent(fakeCtx4, ses4, { type, data });
  fire4("user/message", {
    content: [{ type: "text", text: "请执行审计" }],
    role: "user", id: "a1m1", surfaceOp: "append"
  });
  const AUDIT_CMD = "node scripts/audit-mount-consistency.mjs --profile web";
  const hasRemoveHint = () =>
    injections.some((i) => String(i.content?.[0]?.text ?? "").includes("先移除多余挂载"));

  // 场景 A：审计命令被规则 22 拦截（result 带 error，无审计输出）→ 不注入误导性移除提示
  fire4("tool/call", { name: "pwsh", callId: "a1c-blocked", arguments: { command: AUDIT_CMD } });
  fire4("tool/result", {
    callId: "a1c-blocked",
    error: { message: "【硬拦截】用户消息是询问/没有明确执行分点（规则 22）" },
    message: {
      content: [
        { type: "tool-result", toolCallId: "a1c-blocked", content: [{ type: "text", text: "【硬拦截】用户消息是询问（规则 22）" }] }
      ]
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!hasRemoveHint(), "A1: 审计命令被拦（isError）不注入误导性移除提示");
  const { readAuditLog } = await import("../lib/core/audit.js");
  // 2026-08-31：视窗放宽（隔离目录下仅测试自身写入；防未来滚动/小波动）
  assert.ok(
    readAuditLog(500).some((e) => e.kind === "mount-audit-error" && e.session === SID4),
    "A1: 被拦审计留痕 mount-audit-error"
  );

  // 场景 B：审计输出真 DUPLICATES → 仍注入移除提示（回归保护）
  fire4("tool/call", { name: "pwsh", callId: "a1c-fail", arguments: { command: AUDIT_CMD } });
  fire4("tool/result", {
    callId: "a1c-fail",
    message: {
      content: [
        { type: "tool-result", toolCallId: "a1c-fail", content: [{ type: "text", text: "RESULT: DUPLICATES FOUND" }] }
      ]
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(hasRemoveHint(), "A1: 真 DUPLICATES 仍注入移除提示");

  // 场景 C：审计输出 MOUNT CONSISTENT → 本会话 audit revision 同步
  fire4("tool/call", { name: "pwsh", callId: "a1c-pass", arguments: { command: AUDIT_CMD } });
  fire4("tool/result", {
    callId: "a1c-pass",
    message: {
      content: [
        { type: "tool-result", toolCallId: "a1c-pass", content: [{ type: "text", text: "RESULT: MOUNT CONSISTENT — SAFE TO RESTART" }] }
      ]
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    state.sessions.get(SID4)?.mountAuditRevision,
    state.mountRevision,
    "A1: 审计通过后本会话 audit revision 同步"
  );
}

console.log("session-events.integration.test.mjs PASS");