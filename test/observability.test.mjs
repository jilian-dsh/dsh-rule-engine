import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, getSessionState } from "../lib/core/state.js";
import { understandRule } from "../lib/core/understander.js";
import { guardDecision, markAskSeen } from "../lib/core/guard-core.js";
import { parseUserIntents } from "../lib/core/intent.js";
import { scopesFromIntents } from "../lib/core/authorization.js";
import { TEST_DEFAULT_MAP } from "./helpers.mjs";

// 可观测性（阶段 0，2026-08-24）：放行审计回调测试
process.env.DSH_HOME = join(tmpdir(), "dsh-rule-engine-observe-test");
process.env.DSH_WORKSPACE = process.cwd();

const rule12a = understandRule({
  index: "12A",
  title: "执行前确认（执行等级：C+D）",
  level: "C+D",
  body: "- **触发**：创建/删除/覆盖/移动/执行命令/下载/提交等。\n- **检查**：敏感操作需授权证据。\n- **动作**：无授权→拒绝。\n- **豁免**：只读、工作区低风险新建。"
}, { defaultMap: TEST_DEFAULT_MAP });

function makeState12a() {
  const state = createState();
  state.configs = [rule12a];
  const sid = "global"; // 无 agent 的 exec 默认归属 global 会话（与 guard.test 一致）
  const s = getSessionState(state, sid);
  s.turn.userText = "请修改外部配置文件";
  s.turn.intents = parseUserIntents(s.turn.userText);
  s.turn.scopes = scopesFromIntents(s.turn.intents);
  markAskSeen(state, sid);
  // 12A 敏感写授权（全局 any 覆盖路径）
  s.authorizations.push({ type: "any", pathPrefix: "", source: "ask", at: Date.now(), expiresAt: Date.now() + 60000 });
  return { state, sid };
}

// 场景 1：敏感操作（写工作区外文件）已授权 → 放行，且 opts.audit 收到 allow（带授权描述）
{
  const { state, sid } = makeState12a();
  const allows = [];
  const hit = guardDecision(
    state,
    { name: "write", arguments: { file_path: "D:/outside/app.conf", content: "x" } },
    Date.now(),
    { audit: (e) => allows.push(e) }
  );
  assert.equal(hit, null, "authorized sensitive write allowed");
  assert.equal(allows.length, 1, "allow audit fired once");
  assert.equal(allows[0].kind, "allow");
  assert.equal(allows[0].rule, "12A");
  assert.ok(allows[0].reason.includes("授权"), `reason lists auth: ${allows[0].reason}`);
  assert.equal(allows[0].session, sid, "allow audit carries session");
}

// 场景 2：未授权 → 拒绝，且 audit 不被调用（不产生放行假象）
// 注意：markAskSeen 自带测试授权（type:any）会污染本场景，故不用
{
  const state = createState();
  state.configs = [rule12a];
  const sid = "global";
  const s = getSessionState(state, sid);
  s.turn.userText = "请修改外部配置文件";
  s.turn.intents = parseUserIntents(s.turn.userText);
  s.turn.scopes = scopesFromIntents(s.turn.intents);
  const allows = [];
  const hit = guardDecision(
    state,
    { name: "write", arguments: { file_path: "D:/outside/app.conf", content: "x" } },
    Date.now(),
    { audit: (e) => allows.push(e) }
  );
  assert.ok(hit && hit.ruleId === "12A", "unauthorized sensitive write denied");
  assert.equal(allows.length, 0, "no allow audit on deny");
}

// 场景 3：不传 opts（旧调用）→ 行为兼容，无副作用
{
  const { state } = makeState12a();
  const hit = guardDecision(
    state,
    { name: "write", arguments: { file_path: "D:/outside/app.conf", content: "x" } }
  );
  assert.equal(hit, null, "legacy call without opts still allows authorized op");
}

// 场景 4：规则 22 粒度放行（最高频放行路径）→ audit 收到 allow
{
  const rule22 = understandRule({
    index: "22",
    title: "沟通直接性（执行等级：C+D）",
    level: "C+D",
    body: "- **触发**：所有交流场景。\n- **检查**：疑问句禁止变更类工具调用。\n- **动作**：拒绝。\n- **豁免**：非疑问句+动作词；授权答复；只读/展示类。"
  }, { defaultMap: TEST_DEFAULT_MAP });
  const state22 = createState();
  state22.configs = [rule22];
  const g22 = getSessionState(state22, "global");
  g22.turn.userText = "修改 D:/tmp/a.txt";
  g22.turn.intents = parseUserIntents(g22.turn.userText);
  g22.turn.scopes = scopesFromIntents(g22.turn.intents);
  const allows = [];
  const hit = guardDecision(
    state22,
    { name: "edit", arguments: { file_path: "D:/tmp/a.txt", old_string: "a", new_string: "b" } },
    Date.now(),
    { audit: (e) => allows.push(e) }
  );
  assert.equal(hit, null, "scoped edit allowed by rule22 granular");
  assert.equal(allows.length, 1, "rule22 granular allow audited");
  assert.equal(allows[0].rule, "22");
  assert.ok(allows[0].reason.includes("粒度命中"), `reason mentions granular: ${allows[0].reason}`);
}

console.log("observability.test.js PASS");