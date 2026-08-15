import assert from "node:assert/strict";
import { loadRules, extractElements } from "../lib/core/parser.js";
import { cleanupTempHome, makeTempHome, writeAgents } from "./helpers.js";

const dir = makeTempHome();
const sample = `# 测试规则

## 一、执行与安全

### [规则 18] 先查手册再动手（执行等级：A 弱）
- **触发**：任务涉及 DSH 使用/配置/迁移/插件/技能/规则。
- **检查**：引擎弱检测——该任务首次工具调用前，会话内未 grep/read 过手册。
- **动作**：拒绝首次工具调用（一次），提示先查手册。
- **豁免**：读取手册本身。

### [规则 9] PS 编码与命令执行（执行等级：A+D）
- **触发**：任何含中文的脚本/命令。
- **检查**：拦内联命令（node -e / pwsh -c / node -p）；拦 Set-Content -Encoding UTF8 写 .json。
- **动作**：硬拦项拒绝 + 台账。
- **豁免**：无。

## 二、沟通与汇报

### [规则 2] 时间信息须真实（执行等级：B）
- **触发**：回答中出现时间表述。
- **检查**：写出时间表述前必须先调用 Get-Date。
- **动作**：违规 → 审计台账 + 纠正注入。
- **豁免**：无。
`;
writeAgents(dir, sample);

const result = loadRules();
assert.equal(result.ok, true, "loadRules ok");
assert.equal(result.rules.length, 3, "should parse 3 rules");
assert.equal(result.rules[0].index, "18");
assert.equal(result.rules[0].level, "A弱");
assert.equal(result.rules[2].index, "2");
assert.equal(result.rules[2].level, "B");

const elems = extractElements(result.rules[0].body);
assert.ok(elems.trigger.includes("DSH"), "trigger extracted");
assert.ok(elems.check.includes("grep/read"), "check extracted");
assert.ok(elems.exemption.includes("读取手册"), "exemption extracted");

cleanupTempHome(dir);
console.log("parser.test.js PASS");
