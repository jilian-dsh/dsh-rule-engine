// phase1c-safechannel.test.mjs - 批次 3 ask 链安全精化测试（2026-08-24）
// ① 委托最小 scope 收紧（N-新⑥）：任务书 → 授权集不含全局条目；普通消息回归不受影响
// ② unknown 工具首调 ask→deny（R4，用户拍板分支 A）+ 用户"允许使用 X"白名放行
// ③ 低置信规则跳过审计（N2 防御可观测）
// 先红后绿：改码前本文件应失败；改码后转绿。
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "dsh-rule-engine-phase1c-"));
process.env.DSH_HOME = HOME;
process.env.DSH_WORKSPACE = "D:\\example workspace\\dsh-project";

const { parseUserIntents } = await import("../lib/core/intent.js");
const { scopesFromIntents, isDelegationText } = await import("../lib/core/authorization.js");
const { unknownToolDecision, toolClass } = await import("../lib/core/tool-catalog.js");
const { createState, getSessionState } = await import("../lib/core/state.js");
const { handleSessionEvent } = await import("../lib/index.js");
const { guardDecision } = await import("../lib/core/guard-core.js");

// ═══════════════ ① 委托文本检测 ═══════════════
const DELEGATION_TEXT = `你是 R2④ 委托最小 scope 实测的执行代理。任务：在 Windows 的 D:\\example workspace\\dsh-project\\reports\\d3-probe\\ 目录下依次执行三步，每步之后如实报告结果。

步骤：
1. 用 PowerShell 创建目录和文件：New-Item -ItemType Directory -Force "D:\\example workspace\\dsh-project\\reports\\d3-probe"，然后 Set-Content "D:\\example workspace\\dsh-project\\reports\\d3-probe\\probe.txt" "probe"。
2. 用 read 工具读取 D:\\example workspace\\dsh-project\\reports\\d3-probe\\probe.txt。
3. 用 PowerShell 删除该文件：Remove-Item "D:\\example workspace\\dsh-project\\reports\\d3-probe\\probe.txt" -Force。

严格规则：
- 只允许操作 D:\\example workspace\\dsh-project\\reports\\d3-probe 路径下的内容，绝对不碰其他任何文件。
- 每一步报告格式：步骤N 工具名=xxx 结果=成功/失败/被拦截 原因=原样引用拦截提示（若被拦截）。
- 如果任何调用被拒绝/拦截/弹审批，不要重试、不要换命令绕过，原样报告拦截原因后停止该步骤，继续下一步。
- 最后总结一句：哪些调用被放行、哪些被拦截。

注意：你可能没有 PowerShell 执行权限或被安全机制拦截，这都属于测试数据，如实报告即可。不要额外做任何事。`;
{
  assert.equal(isDelegationText(DELEGATION_TEXT), true, "实测任务书 → 委托文本");
  assert.equal(isDelegationText("修改 D:/a.txt 并删除 D:/b.txt"), false, "短消息不误判");
  assert.equal(isDelegationText("1. 查看 D:/a.txt\n2. 汇报结果"), false, "步骤枚举但缺乏委托框架词/长度 → 不误判");
}

// ═══════════════ ② 委托 scope 收紧 ═══════════════
{
  const scopes = scopesFromIntents(parseUserIntents(DELEGATION_TEXT));
  const globalScopes = scopes.filter((s) => !s.pathPrefix);
  assert.equal(globalScopes.length, 0, `委托任务书授权集不得含全局条目（实际：${JSON.stringify(globalScopes)}）`);
  assert.ok(scopes.some((s) => s.type === "write" && /d3-probe/i.test(s.pathPrefix)), "含 d3-probe write 授权");
  assert.ok(scopes.some((s) => s.type === "delete" && /probe\.txt$/i.test(s.pathPrefix)), "含 probe.txt delete 授权");
}
// 普通消息回归：无路径指代保持全局（规则 22⑤ 语义不变）
{
  const scopes = scopesFromIntents(parseUserIntents("修改它并删除它"));
  assert.ok(scopes.some((s) => !s.pathPrefix), "普通消息无路径 → 保留全局（回归）");
}

// ═══════════════ ③ unknown 首调 deny + 白名放行 ═══════════════
{
  assert.equal(unknownToolDecision("future_tool_xyz", { x: 1 }), "deny", "unknown 首调 → deny（用户拍板分支 A）");
  const whitelist = new Set(["future_tool_xyz"]);
  assert.equal(unknownToolDecision("future_tool_xyz", { x: 1 }, whitelist), null, "会话内已批准 → 放行");
  assert.equal(unknownToolDecision("edit", { file_path: "D:/a.txt" }), null, "已知工具不触发");
  assert.equal(toolClass("report", { output: "交付报告" }), "analysis", "子代理交付工具 report = analysis（无文件副作用，2026-08-24）");
}
// 用户"允许使用 X"→ 白名写入（handleSessionEvent 路径：操作模块级 runtime state，与 phase1b 同法）
{
  const { state: runtimeState } = await import("../lib/core/runtime.js");
  runtimeState.unknownToolApproved = undefined;
  const ses = { id: "wc" };
  handleSessionEvent(null, ses, {
    type: "user/message",
    data: { content: [{ type: "text", text: "允许使用 future_unknown_zzz 吧，它只是只读查询" }], role: "user", id: "m", surfaceOp: "append", source: { kind: "user" } }
  });
  assert.ok(runtimeState.unknownToolApproved && runtimeState.unknownToolApproved.has("future_unknown_zzz"), "用户允许（真 unknown）→ 会话白名");
}

// ask 答复"允许使用 X" → 白名写入（2026-08-25 修复：此前仅用户消息文本写白名，ask 弹窗授权后仍被 unknown deny 拦）
{
  const { state: rt } = await import("../lib/core/runtime.js");
  rt.unknownToolApproved = undefined;
  const ses2 = { id: "ask-wf" };
  handleSessionEvent(null, ses2, {
    type: "tool/call",
    data: { name: "ask_user_question", callId: "ask1", arguments: { questions: [{ id: "q1", question: "是否允许使用 super_future_tool？", options: [{ label: "允许使用 super_future_tool（推荐）", description: "只读使用" }] }] } }
  });
  handleSessionEvent(null, ses2, {
    type: "tool/result",
    data: { callId: "ask1", message: { content: [{ type: "tool-result", toolCallId: "ask1", content: [{ type: "text", text: JSON.stringify({ answers: [{ selected: ["允许使用 super_future_tool（推荐）"], custom: "" }] }) }] }] } }
  });
  assert.ok(rt.unknownToolApproved && rt.unknownToolApproved.has("super_future_tool"), "ask 批准含'允许使用 X' → 会话白名");
}

// ═══════════════ ④ 低置信规则跳过审计（N2 防御） ═══════════════
{
  const st2 = createState();
  st2.configs = [
    {
      ruleId: "99",
      title: "低置信测试规则",
      level: "D",
      actions: ["deny"],
      handler: "rule22-7-direct",
      confidence: "low",
      disabled: false,
      hints: [],
      elements: {},
      triggerKeywords: []
    }
  ];
  const g = getSessionState(st2, "n2");
  g.turn.userText = "请执行";
  g.turn.intents = parseUserIntents("请执行");
  g.turn.scopes = [];
  g.authorizations = [];
  st2.globalAuthorizations = [];
  const seen = [];
  guardDecision(
    st2,
    { name: "edit", agent: { session: { id: "n2" } }, arguments: { file_path: "D:/x.txt", old_string: "a", new_string: "b" } },
    Date.now(),
    { audit: (e) => seen.push(e) }
  );
  assert.ok(
    seen.some((e) => e.kind === "n2-skip" && e.rule === "99"),
    `低置信规则跳过必须留痕（实际 ${JSON.stringify(seen.map((e) => e.kind + ":" + e.rule))}）`
  );
}

// 0.5.9：前缀规则 + 官方全集补全 + 保留工具分类（K-01/K-02/K-03 依据，整体审查交叉结果）
{
  const cases = [
    ["mcp__comfy__server_info", "mutating"],
    ["mcp__web__any", "mutating"],
    ["esr_status", "analysis"],
    ["esr_task", "artifact"],
    ["esr_gc", "artifact"],
    ["run_code", "mutating"],
    ["exit_plan_mode", "artifact"],
    ["cordis_define", "mutating"],
    ["cordis_inspect_query", "analysis"],
    ["cordis_inspect_self", "analysis"],
    ["send_message", "artifact"],
    ["interrupt_agent", "artifact"],
    ["subagent_fork", "artifact"],
    ["job_kill", "mutating"],
    ["session_search", "analysis"],
    ["session_event_read", "analysis"],
    ["terminal_open", "mutating"],
    ["terminal_read", "analysis"],
    ["create_goal", "artifact"],
    ["update_goal", "artifact"],
    ["lsp", "analysis"],
    ["dev_scaffold_plugin", "mutating"],
    ["dev_build_plugin", "mutating"],
    ["dev_release_plugin", "mutating"],
    ["dev_clear_routes", "mutating"],
    ["team_task_create", "mutating"],
    ["future_unknown_xyz", "unknown"]
  ];
  for (const [n, expect] of cases) {
    assert.equal(toolClass(n, {}), expect, `toolClass(${n}) === ${expect}`);
  }
}

console.log("phase1c-safechannel.test.mjs PASS");
