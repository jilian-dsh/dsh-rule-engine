// state.test.js - reloadRules 的 disabled-rules.json 对接（P0-2）与理解产物统一刷新（P0-3）
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createState, reloadRules } from "../lib/core/state.js";
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

cleanupTempHome(dir);
console.log("state.test.js PASS");
