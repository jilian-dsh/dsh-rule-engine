// session-event.test.mjs - 守卫裁决集成级回归（2026-08-24 事故复盘新增）。
// 覆盖：时序竞态根修（上一轮文本不得裁决本轮）、无消息回合不判 22（12A 仍把关）、
// 状态信号放行（规则 22⑩）、system-reminder 被跳过后的行为。
// 说明：不 import index.js（避免读取/写入 DSH_HOME 副作用），直接以 guardDecision 构造会话状态验证裁决路径。
import assert from "node:assert/strict";
import { createState, getSessionState } from "../lib/core/state.js";
import { guardDecision } from "../lib/core/guard-core.js";
import { parseUserIntents } from "../lib/core/intent.js";
import { setWorkspaceRoot } from "../lib/core/patterns.js";

// 模拟 index.js apply 阶段的工作区初始化（否则测试进程内绝对路径全被判“工作区外”→ 误触发 12A 敏感）
setWorkspaceRoot("D:\\example workspace\\dsh-project");

const SID = "test";
const EDIT_CALL = {
  name: "edit",
  agent: { session: { id: SID } },
  arguments: { file_path: "D:\\example workspace\\dsh-project\\_inbox\\x.md", old_string: "a", new_string: "b" }
};
const DELETE_CALL = {
  name: "pwsh",
  agent: { session: { id: SID } },
  arguments: { command: "Remove-Item -Path 'D:\\tmp\\a.txt' -Force" }
};

function makeState() {
  const state = createState();
  state.configs = [
    {
      ruleId: "22",
      title: "沟通直接性",
      level: "C+D",
      actions: ["deny", "ask"],
      handler: "rule22-7-direct",
      confidence: "high",
      disabled: false,
      hints: [],
      elements: {}
    },
    {
      ruleId: "12A",
      title: "执行前确认",
      level: "C+D",
      actions: ["deny", "ask"],
      handler: "rule12a-approval",
      confidence: "high",
      disabled: false,
      hints: [],
      elements: {}
    }
  ];
  // 阻止 maybeReloadIfChanged 把 mock configs 覆盖成真实 AGENTS.md 解析结果（测试隔离）
  state.lastMtimeCheck = Date.now() + 3600_000;
  return state;
}

// 场景 1：时序竞态根修——上一轮是询问（含“为什么”），本轮无新消息 → 不得用旧文本裁决（22 不拦）
{
  const state = makeState();
  const s = getSessionState(state, SID);
  s.lastUserText = "为什么此前升级会发生严重事故？";
  s.turn.userText = ""; // resetTurn 根修后：新回合等待真实消息，不继承
  s.turn.intents = null;
  const hit = guardDecision(state, EDIT_CALL);
  assert.equal(hit, null, "无消息回合不做规则 22 判定（旧文本不得裁决本轮）");
}

// 场景 2：上一轮询问文本残留 + 本轮消息已处理（userText 已更新为含执行点的同行编号列表）→ 22 放行
{
  const state = makeState();
  const s = getSessionState(state, SID);
  s.lastUserText = "为什么此前升级会发生严重事故？";
  s.turn.userText = "1、请补充进事故报告 2、请继续完善方案的其他部分";
  s.turn.intents = parseUserIntents(s.turn.userText);
  assert.equal(s.turn.intents.hasExecute, true, "本轮含执行分点（同行编号切分）");
  const hit = guardDecision(state, EDIT_CALL);
  assert.equal(hit, null, "本轮含执行分点 → 放行（不被上一轮询问污染）");
}

// 场景 3（2026-08-28 重建，A 方案用户拍板）：纯疑问回合——
// ① 写临时区/分析通道（logs/.analysis-tmp 等）→ 放行（调研工具）；
// ② edit/write 工作区正式路径或 _inbox（落盘/产出）→ 拦 + 确认文案（原 2026-08-26"低风险新建豁免"场景作废：当时用 edit _inbox\x.md 代表"低风险新建"，但 edit=修改已存在文件，与"你了解吗"只读语义不符；且 _inbox=落盘前的暂存=产物，按分类文本定位应确认）；
// ③ 工作区外/受保护仍拦（安全不降级）
{
  // ① 临时区（调研工具）放行——用 write 到 logs\.analysis-tmp 新脚本模拟"纯疑问调研需写诊断脚本"
  const state3t = makeState();
  const s3t = getSessionState(state3t, SID);
  s3t.turn.userText = "这个方案你了解吗？";
  s3t.turn.intents = parseUserIntents(s3t.turn.userText);
  const probeCall = {
    name: "write",
    agent: { session: { id: SID } },
    arguments: { file_path: "D:\\example workspace\\dsh-project\\logs\\.analysis-tmp\\probe.mjs", content: "// 诊断脚本" }
  };
  const hit3t = guardDecision(state3t, probeCall);
  assert.equal(hit3t, null, "纯疑问 + 临时区诊断脚本 → 放行（调研工具，A 方案）");

  // ② edit/inbox/正式路径 → 拦（A 方案：落盘需确认）
  const state3a = makeState();
  const s3a = getSessionState(state3a, SID);
  s3a.turn.userText = "这个方案你了解吗？";
  s3a.turn.intents = parseUserIntents(s3a.turn.userText);
  // edit 已存在文件语义（注：测试环境 _inbox\x.md 不存在——用 write 到 _inbox 模拟"产物落盘"）
  const inboxCall = {
    name: "write",
    agent: { session: { id: SID } },
    arguments: { file_path: "D:\\example workspace\\dsh-project\\_inbox\\x.md", content: "# x" }
  };
  const hit3a = guardDecision(state3a, inboxCall);
  assert.ok(hit3a && hit3a.ruleId === "22", "纯疑问 + _inbox 落盘 → 拦（A 方案，分类文本定位：_inbox=暂存=产物需确认）");
  assert.match(hit3a.reason, /确认后保存|落盘/, "拦截文案含确认后落盘指引");

  // ③ 工作区外仍拦（安全不降级）
  const state3b = makeState();
  const s3b = getSessionState(state3b, SID);
  s3b.turn.userText = "这个方案你了解吗？";
  s3b.turn.intents = parseUserIntents(s3b.turn.userText);
  const outsideCall = {
    name: "edit",
    agent: { session: { id: SID } },
    arguments: { file_path: "D:\\tmp-zone\\outside.md", old_string: "a", new_string: "b" }
  };
  const hit3b = guardDecision(state3b, outsideCall);
  assert.ok(hit3b && hit3b.ruleId === "22", "纯疑问 + 工作区外写入 → 规则 22 仍拦（安全不降级）");
}

// 场景 4：状态信号（用户回复“我已重启”）→ 22 放行；敏感操作仍由 12A 把关
{
  const state = makeState();
  const s = getSessionState(state, SID);
  s.turn.userText = "我已重启";
  s.turn.intents = parseUserIntents(s.turn.userText);
  assert.equal(s.turn.intents.hasStatus, true, "我已重启 → status");
  const hit = guardDecision(state, EDIT_CALL);
  assert.equal(hit, null, "状态信号回合 → 规则 22 不拦");
  // 同回合敏感删除无授权 → 12A 仍拦（安全不降级）
  const delHit = guardDecision(state, DELETE_CALL);
  assert.ok(delHit && delHit.ruleId === "12A", "状态信号回合敏感操作仍由 12A 把关");
}

// 场景 5：ask 答复后（无新消息）继续执行 → 22 不拦（12A 有授权证据放行）
{
  const state = makeState();
  const s = getSessionState(state, SID);
  s.turn.userText = "";
  s.turn.askSeen = true;
  s.turn.intents = null;
  s.authorizations.push({ at: Date.now(), type: "write", pathPrefix: "d:/example workspace/dsh-project/", source: "ask" });
  const hit = guardDecision(state, EDIT_CALL);
  assert.equal(hit, null, "ask 答复后续动作不被 22 误拦（授权由 12A 证据把关）");
}

console.log("session-event.test.mjs PASS");