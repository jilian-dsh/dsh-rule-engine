// phase1b-mechanism.test.mjs - 机制式改造测试（2026-08-24）
// A 消息注入判别（source.kind 主判 + 模板兜底，覆盖所有注入类插件）
// B 工具分类制（analysis/artifact/mutating/unknown + 命令链只读 + unknown→ask）
// C 授权双轨存储 + revoke 全清 + authMatches 路径边界
// 先红后绿：改码前本文件应失败；改码后转绿。
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "dsh-rule-engine-phase1b-"));
process.env.DSH_HOME = HOME;
process.env.DSH_WORKSPACE = "D:\\example workspace\\dsh-project";
const LOG = join(HOME, "rule-engine.log.jsonl");

// ═══════════════ ① 注入模板判别（机制 A 兜底层）═══════════════
const { isKnownSystemInjection } = await import("../lib/core/intent.js");
{
  assert.equal(
    isKnownSystemInjection("Current runtime context. This snapshot supersedes earlier runtime-context snapshots."),
    true,
    "runtime context 模板"
  );
  assert.equal(
    isKnownSystemInjection("Background subagent a8193535-bd2b-471b-8c64-a12bb4024f7b finished and will do no further work unless you send it more."),
    true,
    "subagent 完成通知模板"
  );
  assert.equal(isKnownSystemInjection("[规则引擎] 已有授权，无需重复询问：请直接执行"), true, "引擎注入前缀");
  assert.equal(
    isKnownSystemInjection("本轮消息包含图片，像素级视觉工具已自动挂载：vision_describe（看图问答）"),
    true,
    "vision 挂载提醒模板"
  );
  assert.equal(isKnownSystemInjection("请修改 D:/a.txt 并删除 D:/b.txt"), false, "真实用户消息不误判");
  assert.equal(isKnownSystemInjection("Current runtime context 这个词是什么意思"), false, "仅提及不构成模板（需句点锚定）");
}

// ═══════════════ ② source.kind 事件级判别（机制 A 主判）═══════════════
const { state } = await import("../lib/core/runtime.js");
const { handleSessionEvent } = await import("../lib/index.js");
const { getSessionState } = await import("../lib/core/state.js");
const { guardDecision } = await import("../lib/core/guard-core.js");
const { parseUserIntents } = await import("../lib/core/intent.js");
state.lastMtimeCheck = Date.now() + 3600_000; // 禁止 maybeReloadIfChanged 重载（自包含规则集）
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

const SID = "mech";
const ses = { id: SID };
const fire = (text, extra = {}) =>
  handleSessionEvent(null, ses, {
    type: "user/message",
    data: { content: [{ type: "text", text }], role: "user", id: "m", surfaceOp: "append", ...extra }
  });
const exec = (name, args) => ({ name, agent: { session: { id: SID } }, arguments: args });

function freshTurn(text) {
  const s = getSessionState(state, SID);
  s.turn.userText = text;
  s.turn.intents = parseUserIntents(text);
  s.turn.scopes = [];
  s.authorizations = [];
  return s;
}

{
  const s = getSessionState(state, SID);
  fire("修改 D:/a.txt", { source: { kind: "user" } });
  assert.equal(s.turn.userText, "修改 D:/a.txt", "kind=user 正常进入");
  assert.ok(s.turn.scopes.length > 0, "user 消息产生 scopes");
  const before = s.turn.userText;
  const authBefore = s.authorizations.length;
  fire("修改 D:/a.txt", { source: { kind: "agent-instructions" } });
  assert.equal(s.turn.userText, before, "agent-instructions 注入不覆盖状态");
  assert.equal(s.authorizations.length, authBefore, "agent-instructions 注入不产生授权");
  fire("本轮消息包含图片，像素级视觉工具已自动挂载：vision_describe（看图问答）", {
    source: { kind: "plugin", plugin: "dsh-vision-router" }
  });
  assert.equal(s.turn.userText, before, "plugin 注入（vision 挂载提醒）不覆盖状态");
  fire("Current runtime context. This snapshot supersedes earlier runtime-context snapshots.", {
    source: { kind: "user" } // 伪装 user 的注入（example-injector 同类风险）
  });
  assert.equal(s.turn.userText, before, "kind=user 但模板命中 → 跳过");
  fire("Background subagent a8193535 finished and will do no further work unless you send it more.", {
    source: { kind: "user" }
  });
  assert.equal(s.turn.userText, before, "subagent 通知模板命中 → 跳过");
  // 审计留痕：source-skip 至少 3 条
  assert.ok(existsSync(LOG), "审计日志存在");
  const logText = readFileSync(LOG, "utf8");
  const skipCount = (logText.match(/"kind":"source-skip"/g) || []).length;
  assert.ok(skipCount >= 3, `source-skip 审计 ≥3（实际 ${skipCount}）`);
}

// ═══════════════ ③ 工具分类制（机制 B）═══════════════
const { toolClass, unknownToolDecision } = await import("../lib/core/tool-catalog.js");
{
  assert.equal(toolClass("edit", { file_path: "D:/a.txt" }), "mutating", "edit = mutating");
  assert.equal(toolClass("vision_describe", { paths: ["D:/x.png"] }), "analysis", "vision 分析类");
  assert.equal(toolClass("vision_crop", { image: "D:/x.png", region: "1,2,3,4" }), "artifact", "vision 产物类");
  assert.equal(toolClass("read", { file_path: "D:/a.txt" }), "analysis", "read = analysis");
  assert.equal(toolClass("web_fetch", { url: "https://example.com" }), "analysis", "web_fetch = analysis（官方只读联网，2026-08-25 补）");
  assert.equal(toolClass("web_search", { queries: ["x"] }), "analysis", "web_search = analysis（官方只读联网，2026-08-25 补）");
  assert.equal(toolClass("list_subagent_models", {}), "analysis", "list_subagent_models = analysis（官方子代理模型发现，2026-09-06 工具目录漂移补录）");
  assert.equal(toolClass("future_tool_xyz", { x: 1 }), "unknown", "未归类工具 = unknown");
  assert.equal(toolClass("pwsh", { command: "npm test" }), "analysis", "只读命令 = analysis");
  assert.equal(toolClass("pwsh", { command: "Remove-Item D:/x" }), "mutating", "写命令 = mutating");
  assert.equal(unknownToolDecision("future_tool_xyz", ""), "deny", "unknown 工具 → deny（批次 3：ask 被 approval 自动放行的 fail-open 修复）");
  assert.equal(unknownToolDecision("future_tool_xyz", "", new Set(["future_tool_xyz"])), null, "会话白名后放行");
  assert.equal(unknownToolDecision("edit", ""), null, "已知工具不触发 ask");
}

// ═══════════════ ④ 命令链只读（机制 B 补强）═══════════════
const { isReadOnlyCommand } = await import("../lib/core/patterns.js");
{
  assert.equal(isReadOnlyCommand("git -C D:/a status --short; echo ok"), true, "git -C 变体 + 链式只读");
  assert.equal(isReadOnlyCommand("git status; echo x > f.txt"), false, "链中含写 → 非只读");
  assert.equal(isReadOnlyCommand("npm test"), true, "npm test 只读");
  assert.equal(isReadOnlyCommand("npm install"), false, "npm install 变更");
  assert.equal(isReadOnlyCommand("node --check lib/index.js"), true, "node --check 只读");
  assert.equal(isReadOnlyCommand("gh auth status"), true, "gh auth status 只读");
  assert.equal(isReadOnlyCommand("Get-Date"), true, "Get-Date 只读");
  assert.equal(isReadOnlyCommand("Remove-Item D:/x"), false, "删除非只读");
}

// ═══════════════ ⑤ guardDecision 行为（机制 B 落点）═══════════════
{
  const s = freshTurn("这个方案你了解吗？");
  const vd = guardDecision(state, exec("vision_describe", { paths: ["D:/x.png"] }), Date.now(), { audit: () => {} });
  assert.equal(vd, null, "疑问回合 vision 分析类放行（不再被规则 22 拦）");
  const hit = guardDecision(state, exec("future_tool_xyz", { x: 1 }), Date.now(), { audit: () => {} });
  assert.equal(hit, null, "unknown 工具不物理拦（由 pre-execute ask 层负责）");
  const s2 = freshTurn("修改 D:/a.txt");
  const hit2 = guardDecision(state, exec("edit", { file_path: "D:/b.txt", old_string: "a", new_string: "b" }), Date.now(), { audit: () => {} });
  assert.ok(hit2 && hit2.ruleId === "22", "变更类超出范围仍拦");
}

// ═══════════════ ⑥ authMatches 路径边界（机制 C）═══════════════
const { authMatches } = await import("../lib/core/authorization.js");
{
  assert.equal(
    authMatches({ type: "write", pathPrefix: "d:/tmp/a.txt" }, { type: "write", pathPrefix: "d:/tmp/a.txt" }),
    true,
    "精确相等"
  );
  assert.equal(
    authMatches({ type: "write", pathPrefix: "d:/tmp/a.txt" }, { type: "write", pathPrefix: "d:/tmp/a.txt.bak" }),
    false,
    "文件授权不误伤同前缀文件（a.txt ≠ a.txt.bak）"
  );
  assert.equal(
    authMatches({ type: "write", pathPrefix: "d:/tmp/a.txt" }, { type: "write", pathPrefix: "d:/tmp/a.txt/2.txt" }),
    true,
    "文件路径作为目录前缀时子路径匹配（边界为 /）"
  );
  assert.equal(
    authMatches({ type: "write", pathPrefix: "d:/example/injector-pkg" }, { type: "write", pathPrefix: "d:/example/injector-pkg/lib/client.js" }),
    true,
    "目录前缀匹配（无尾斜杠也能作为目录边界）"
  );
}

// ═══════════════ ⑦ 双轨存储 + revoke 全清（机制 C）═══════════════
const { createState, recordAuthorization, clearAuthorizations } = await import("../lib/core/state.js");
{
  const st = createState();
  recordAuthorization(st, "s1", { type: "write", pathPrefix: "d:/a.txt" });
  const s1 = getSessionState(st, "s1");
  assert.equal(s1.authorizations.length, 1, "session 授权已记录");
  assert.equal(st.globalAuthorizations.length, 0, "自动授权不进 global");
  s1.turn.scopes.push({ type: "write", pathPrefix: "d:/a.txt", source: "clause", clauseId: "1" });
  st.globalAuthorizations.push({ type: "any", pathPrefix: "" });
  st.askRejections.push({ sessionId: "s1", at: Date.now() });
  clearAuthorizations(st, "s1");
  assert.equal(s1.authorizations.length, 0, "revoke 清 session");
  assert.equal(s1.turn.scopes.length, 0, "revoke 清 turn.scopes");
  assert.equal(st.globalAuthorizations.length, 0, "revoke 清 global");
  assert.equal(st.askRejections.length, 0, "revoke 清 askRejections");
}

// ═══════════════ ⑧ 执行分点授权不进 global（index.js 路径）═══════════════
{
  const s = getSessionState(state, SID);
  s.authorizations = [];
  state.globalAuthorizations = [];
  fire("修改 D:/b.txt", { source: { kind: "user" } });
  assert.ok(s.authorizations.length >= 1, "执行分点授权已记录（session 级）");
  const autoGlobal = state.globalAuthorizations.filter((a) => a.source === "user-message-clause").length;
  assert.equal(autoGlobal, 0, "自动授权绝不进 global（显式白名单唯一入口）");
}

// ═══════════════ ⑨ 12A 敏感拦截回归（hints 截胡修复，2026-08-24 实测发现）═══════════════
// 真实理解产物里规则 12A 的 hints = ["ask","skill","sensitive","backup","manual"]——含 "skill"，
// 旧实现 12B 分支 `handler==='rule12b-skill' || hints.includes('skill')` 会把 12A 的 cfg 截胡
// （非 skill 工具 → return null），导致 12A 敏感授权检查从未执行（Move-Item 静默放行实测）。
{
  const st2 = createState();
  st2.configs = [
    {
      ruleId: "12A",
      title: "执行前确认（执行等级：C+D）",
      level: "C+D",
      actions: ["ask", "self-certify"],
      handler: "rule12a-approval",
      confidence: "high",
      disabled: false,
      hints: ["ask", "skill", "sensitive", "backup", "manual"], // 与真实理解产物一致（含 skill 截胡诱因）
      elements: {},
      triggerKeywords: []
    }
  ];
  const g2 = getSessionState(st2, SID);
  g2.turn.userText = "已输入";
  g2.turn.intents = parseUserIntents("已输入");
  g2.turn.scopes = [];
  g2.authorizations = [];
  st2.globalAuthorizations = [];
  // 敏感移动（非备份语义：目标不在 .backups/trash-）→ 无授权 → 12A 必须拦
  const hitSensitive = guardDecision(
    st2,
    exec("pwsh", { command: 'Move-Item "D:/a.txt" "D:/b.txt"' }),
    Date.now(),
    { audit: () => {} }
  );
  assert.ok(hitSensitive && String(hitSensitive.ruleId) === "12A", `12A 敏感操作无授权必拦（实际 ${hitSensitive ? hitSensitive.ruleId : "放行"}）`);
  // 备份语义 → 12A 豁免（规则 12A 正文：移动文件到 .backups/trash- 免询问）
  const hitBackup = guardDecision(
    st2,
    exec("pwsh", { command: 'Move-Item "D:/a.txt" "D:/example workspace/dsh-project/.backups/trash-x/a.txt"' }),
    Date.now(),
    { audit: () => {} }
  );
  assert.equal(hitBackup, null, "12A 对备份语义（.backups/trash-）豁免");
}

console.log("phase1b-mechanism.test.mjs PASS");
