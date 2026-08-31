// session-addressing.test.mjs — /guard 命令会话寻址（T2，2026-08-31）
// 背景：官方 CommandInvocation 无 session 字段（commandId/agent/rawInput/attachments/signal），
// 旧代码 invocation?.session?.id 恒 undefined → 永远写 "global"（模板），当前会话契约不变
// ——"/guard mode change 放行无效"根因。修复：sessionIdOfInvocation 从 invocation.agent 取 id。
// 本测试自设 DSH_HOME + import index.js（与 phase1b 同款前提，固定放 run-all 末尾）。
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_HOME = join(tmpdir(), `dsh-rule-engine-session-addr-${Date.now()}`);
process.env.DSH_WORKSPACE = process.cwd();

const { sessionIdOfInvocation } = await import("../lib/index.js");

// 1) 官方形态：invocation.agent = Agent，Agent.id 与 session.id 同一身份 → 取 agent.id
assert.equal(
  sessionIdOfInvocation({ agent: { id: "sess-abc", session: { id: "sess-abc" } } }),
  "sess-abc",
  "agent.id 优先（官方 Agent.id 与 session.id 同一身份）"
);

// 2) 兼容形态：agent 只有 session 对象
assert.equal(
  sessionIdOfInvocation({ agent: { session: { id: "sess-xyz" } } }),
  "sess-xyz",
  "agent.session 对象兜底"
);

// 3) 兼容形态：agent.session 是字符串
assert.equal(
  sessionIdOfInvocation({ agent: { session: "sess-str" } }),
  "sess-str",
  "agent.session 字符串兜底"
);

// 4) 缺失 → global（保守 fallback，不抛错）
assert.equal(sessionIdOfInvocation({}), "global", "无 agent → global");
assert.equal(sessionIdOfInvocation(null), "global", "null → global");

console.log("session-addressing.test.js PASS");
