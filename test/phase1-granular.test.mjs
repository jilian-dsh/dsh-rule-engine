import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, getSessionState } from "../lib/core/state.js";
import { understandRule } from "../lib/core/understander.js";
import { guardDecision } from "../lib/core/guard-core.js";
import { parseUserIntents } from "../lib/core/intent.js";
import { scopesFromIntents } from "../lib/core/authorization.js";
import { TEST_DEFAULT_MAP } from "./helpers.mjs";

// 阶段 1 P0（RB-01）：同一回复分点精确配对——"修改 A 并删除 B"
process.env.DSH_HOME = join(tmpdir(), "dsh-rule-engine-phase1-test");
process.env.DSH_WORKSPACE = process.cwd();

// ── scopesFromIntents 精确配对（不再笛卡尔积）──────────────────────
{
  const intents = parseUserIntents("修改 D:/tmp/a.txt 并删除 D:/tmp/b.txt");
  assert.equal(intents.hasExecute, true, "has execute");
  const scopes = scopesFromIntents(intents);
  const has = (type, path) => scopes.some((s) => s.type === type && s.pathPrefix === path);
  assert.ok(has("write", "d:/tmp/a.txt"), `write A present: ${JSON.stringify(scopes)}`);
  assert.ok(has("delete", "d:/tmp/b.txt"), `delete B present: ${JSON.stringify(scopes)}`);
  assert.ok(!has("write", "d:/tmp/b.txt"), "no crossed write B");
  assert.ok(!has("delete", "d:/tmp/a.txt"), "no crossed delete A");
  assert.ok(!scopes.some((s) => s.type === "any" && s.pathPrefix === ""), "no any-global fallback");
}

// 共享路径多路径：修改 A 和 B → 两条 write
{
  const scopes = scopesFromIntents(parseUserIntents("修改 D:/tmp/x.txt 和 D:/tmp/y.txt"));
  assert.ok(scopes.some((s) => s.type === "write" && s.pathPrefix === "d:/tmp/x.txt"));
  assert.ok(scopes.some((s) => s.type === "write" && s.pathPrefix === "d:/tmp/y.txt"));
}

// 动词前路径（"把 X 修改一下"）也应绑定
{
  const scopes = scopesFromIntents(parseUserIntents("把 D:/tmp/z.txt 修改一下"));
  assert.ok(scopes.some((s) => s.type === "write" && s.pathPrefix === "d:/tmp/z.txt"), `bind leading path: ${JSON.stringify(scopes)}`);
}

// 无路径动作 → 全局 any（规则 22⑤：宽泛指令"执行/开始/做"无具体操作 = 全局范围；2026-08-24 用户裁定）
{
  const scopes = scopesFromIntents(parseUserIntents("立即执行"));
  assert.ok(scopes.some((s) => s.type === "any" && s.pathPrefix === ""), `global any scope: ${JSON.stringify(scopes)}`);
}

// ── guardDecision 四向断言（P0）───────────────────────────────────
{
  const rule22 = understandRule({
    index: "22",
    title: "沟通直接性（执行等级：C+D）",
    level: "C+D",
    body: "- **触发**：所有交流场景。\n- **检查**：疑问句禁止变更类工具调用。\n- **动作**：拒绝。\n- **豁免**：非疑问句+动作词；授权答复；只读/展示类。"
  }, { defaultMap: TEST_DEFAULT_MAP });
  const state = createState();
  state.configs = [rule22];
  const g = getSessionState(state, "global");
  g.turn.userText = "修改 D:/tmp/a.txt 并删除 D:/tmp/b.txt";
  g.turn.intents = parseUserIntents(g.turn.userText);
  g.turn.scopes = scopesFromIntents(g.turn.intents);

  const noAudit = () => {};
  // Edit(A) ✅
  let hit = guardDecision(state, { name: "edit", arguments: { file_path: "D:/tmp/a.txt", old_string: "a", new_string: "b" } }, Date.now(), { audit: noAudit });
  assert.equal(hit, null, "Edit(A) allowed");
  // Delete(B) ✅（pwsh Remove-Item）
  hit = guardDecision(state, { name: "pwsh", arguments: { command: "Remove-Item -Path D:/tmp/b.txt" } }, Date.now(), { audit: noAudit });
  assert.equal(hit, null, "Delete(B) allowed");
  // Edit(B) ❌
  hit = guardDecision(state, { name: "edit", arguments: { file_path: "D:/tmp/b.txt", old_string: "a", new_string: "b" } }, Date.now(), { audit: noAudit });
  assert.ok(hit && hit.ruleId === "22", "Edit(B) denied");
  // Delete(A) ❌
  hit = guardDecision(state, { name: "pwsh", arguments: { command: "Remove-Item -Path D:/tmp/a.txt" } }, Date.now(), { audit: noAudit });
  assert.ok(hit && hit.ruleId === "22", "Delete(A) denied");
  // 未提及 C ❌
  hit = guardDecision(state, { name: "edit", arguments: { file_path: "D:/tmp/c.txt", old_string: "a", new_string: "b" } }, Date.now(), { audit: noAudit });
  assert.ok(hit && hit.ruleId === "22", "Edit(C) denied (untouched path)");
}

console.log("phase1-granular.test.js PASS");