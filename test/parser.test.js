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

// 自由区域测试：区内 `### [规则 F1]` 不解析、`##` 不切换分区，区外规则不受影响
const sampleFree = `# 测试规则

## 一、执行与安全

### [规则 18] 先查手册再动手（执行等级：A 弱）
- **触发**：任务涉及 DSH。
- **动作**：拒绝首次工具调用。

## 五、自由区域（引擎不强制，正常生效）

<!-- free-zone:start -->

### [规则 F1] 中国法律工作守则
任务涉及中国法律实务时：
- 所有法律输出均为律师审查草稿。

### [规则 F2] 另一条自由规则
- 区内内容。

<!-- free-zone:end -->

## 六、区后分区

### [规则 19] 知识必沉淀（执行等级：D）
- **触发**：学到新知识。
`;
writeAgents(dir, sampleFree);
const r2 = loadRules();
assert.equal(r2.ok, true, "free-zone loadRules ok");
assert.equal(r2.rules.length, 2, "free-zone rules should be excluded (only 18 and 19)");
assert.equal(r2.rules[0].index, "18", "rule 18 still parsed");
assert.equal(r2.rules[1].index, "19", "rule 19 after zone parsed");
assert.equal(r2.rules[1].section, "六、区后分区", "section after zone correct, zone ## ignored");

// E7：带括号标签的四要素（如“检查（引擎硬拦）”）也能提取
const elemsParenthetical = extractElements(`- **触发**：触发条件。
- **检查（引擎硬拦）**：硬拦内容。
- **检查（自证）**：自证内容。
- **动作**：动作内容。
- **豁免**：豁免内容。`);
assert.ok(elemsParenthetical.check.includes("硬拦内容"), "parenthetical check label extracted");
assert.ok(elemsParenthetical.action.includes("动作内容"), "action extracted");

cleanupTempHome(dir);
console.log("parser.test.js PASS");
