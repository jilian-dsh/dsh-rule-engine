// state.test.js - reloadRules 的 disabled-rules.json 对接（P0-2）与理解产物统一刷新（P0-3）
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createState, loadTurnCardsFromDisk, reloadRules, saveTurnCardsToDisk, turnCardsArchiveFilePath } from "../lib/core/state.js";
import { makeTempHome, cleanupTempHome } from "./helpers.mjs";

const dir = makeTempHome();

const agents = `## 一、执行与安全

### [规则 12A] 执行前确认（执行等级：C+D）
- **触发**：敏感操作前。
- **检查**：先 ask_user_question 获取授权。
- **动作**：违规拒绝。

### [规则 2] 时间信息须真实（执行等级：B）
- **触发**：回答出现时间表述。
- **检查**：先调用 Get-Date。
`;

writeFileSync(join(dir, "AGENTS.md"), agents, "utf8");
// P0-2：rules-manager 禁用 12A（字母编号存字符串；纯数字编号存 Number，String() 归一兼容）
writeFileSync(join(dir, "disabled-rules.json"), JSON.stringify([
  { index: "12A", title: "执行前确认", section: "一、执行与安全", body: "..." },
  { index: 2, title: "时间信息须真实", section: "一、执行与安全", body: "..." }
]), "utf8");

const state = createState();
reloadRules(state);

assert.equal(state.configOk, true, "reload ok");
assert.equal(state.configs.length, 2, "2 rules parsed");
const rule12a = state.configs.find((c) => c.ruleId === "12A");
const rule2 = state.configs.find((c) => c.ruleId === "2");
assert.ok(rule12a, "rule 12A exists");
assert.equal(rule12a.disabled, true, "12A marked disabled from disabled-rules.json");
assert.equal(rule2.disabled, true, "numeric-index disabled rule also marked");

// P0-3：reload 后理解产物统一刷新（含 disabled 标记）
const uf = join(dir, "rule-understanding.json");
assert.ok(existsSync(uf), "rule-understanding.json written on reload");
const understanding = JSON.parse(readFileSync(uf, "utf8"));
assert.equal(understanding.rules.length, 2, "understanding has 2 rules");
assert.equal(understanding.rules.find((r) => r.ruleId === "12A").disabled, true, "understanding reflects disabled flag");

// 清空禁用清单后 reload → 恢复
rmSync(join(dir, "disabled-rules.json"), { force: true });
reloadRules(state);
assert.equal(state.configs.find((c) => c.ruleId === "12A").disabled, false, "disabled cleared after file removal");
assert.equal(state.configs.find((c) => c.ruleId === "2").disabled, false, "rule 2 disabled cleared after file removal");

// ── 判例保护（2026-09-08 第二批 §1.1-①）：205 卡（5 带标最旧 + 200 无标）→ 带标全存活 + 归档收到被裁卡 ──
{
  const st = createState();
  st.cardByMessage = new Map();
  const labeledIds = [];
  for (let i = 0; i < 205; i++) {
    const id = `m${i}`;
    const card = i < 5
      ? { ruleIds: ["22"], blocks: [{ label: "incorrect", text: `labeled-${i}` }] }
      : { ruleIds: ["22"], blocks: [{ text: `plain-${i}` }] };
    if (i < 5) labeledIds.push(id);
    st.cardByMessage.set(id, card);
  }
  saveTurnCardsToDisk(st);
  const loaded = loadTurnCardsFromDisk();
  assert.equal(loaded.size, 200, "裁剪后 200 张");
  for (const id of labeledIds) assert.ok(loaded.has(id), `带标卡存活：${id}`);
  const arc = readFileSync(turnCardsArchiveFilePath(), "utf8").trim().split("\n").filter(Boolean);
  assert.equal(arc.length, 5, "归档收到 5 张被裁卡");
  const arcIds = arc.map((l) => JSON.parse(l).messageId);
  for (const id of labeledIds) assert.ok(!arcIds.includes(id), "带标卡未被裁（归档不含）");

  // 边界：全带标超限 → 无标耗尽后才按最旧裁带标
  const st2 = createState();
  st2.cardByMessage = new Map();
  for (let i = 0; i < 205; i++) st2.cardByMessage.set(`L${i}`, { label: `l-${i}`, blocks: [] });
  saveTurnCardsToDisk(st2);
  const loaded2 = loadTurnCardsFromDisk();
  assert.equal(loaded2.size, 200, "全带标仍裁剪到 200");
  assert.ok(!loaded2.has("L0") && loaded2.has("L204"), "无标耗尽后按最旧裁带标");
}

cleanupTempHome(dir);
console.log("state.test.js PASS");
