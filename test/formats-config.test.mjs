// formats-config.test.mjs - (c) 格式描述对象配置化：等价性 + 双层模型 + 拒绝面（2026-09-21）
//
// ① 等价性证明方式（与 patterns-config.test.mjs 同构，不循环）：
//    迁移前基线 LEGACY = 迁移前 parser.js 五处格式预设的**逐字快照**（硬编码于本文件）；
//    「迁移前实现」= new RegExp(LEGACY[...].source, LEGACY[...].flags) 直接编；
//    「迁移后实现」= parser.js 经 formats.js 默认取值（不注入 formats）。
//    对同一份样本规则文件比较两端产物，要求**逐字段深等**（规则集 / 正文 / 等级）。
// ② 双层模型：setFormats 三态（undefined 不干预 / 对象按键替换 / {} 回内置）+ 拒绝面。
// ③ 具名捕获组切换：rule_header 换成自定义具名组后仍能取值。
import assert from "node:assert/strict";
import { loadRules, levelFromTitle, extractElements } from "../lib/core/parser.js";
import {
  setFormats,
  resetFormats,
  hasFormatOverride,
  getFormat,
  getFormatCapture,
  DEFAULT_FORMATS,
  FORMAT_KEYS
} from "../lib/core/formats.js";
import { cleanupTempHome, makeTempHome, writeAgents } from "./helpers.mjs";

// ── ① 迁移前基线：现盘（0.6.5）五处格式预设逐字快照 ──
const LEGACY = {
  rule_header: {
    source: "^###\\s*\\[规则\\s*([0-9A-Za-z]+)\\]\\s*(.+?)\\s*(?:（来源[^）]*）)?\\s*$",
    flags: "g"
  },
  section: { source: "^##\\s+(.+?)\\s*$", flags: "g" },
  free_zone_start: { source: "^\\s*<!--\\s*free-zone:start\\s*-->\\s*$", flags: "g" },
  free_zone_end: { source: "^\\s*<!--\\s*free-zone:end\\s*-->\\s*$", flags: "g" },
  level: {
    source: "执行等级[：:]\\s*([A-DM+](?:\\s*[强弱])?(?:\\s*[+＋、]\\s*[A-DM+](?:\\s*[强弱])?)*)",
    flags: "g"
  },
  elements: {
    source: "\\*\\*(?:__LABEL__)(?:（[^）]*）)?\\*\\*[：:]\\s*(?:([^\\n]*(?:\\n(?!\\s*\\*\\*)[^\\n]*)*))",
    flags: "i"
  }
};
const legacyRe = (k) => new RegExp(LEGACY[k].source, LEGACY[k].flags);
/** 把具名组 `(?<name>` 规范回编号组 `(`——用于证明「默认 source == 旧源码的具名组改写」 */
const normGroups = (s) => String(s).replace(/\(\?<[A-Za-z_$][A-Za-z0-9_$]*>/g, "(");

/** 迁移前实现（照抄现盘 loadRules 逻辑；旧实现用非 g 的 match 取捕获组，此处等价用 exec） */
function loadRulesLegacy(text) {
  const rHead = legacyRe("rule_header");
  const sRe = legacyRe("section");
  const zStart = legacyRe("free_zone_start");
  const zEnd = legacyRe("free_zone_end");
  const lines = text.split("\n");
  const rules = [];
  let currentSection = "未分区";
  let current = null;
  let inFreeZone = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (zStart.test(line)) {
      if (current) rules.push(finalizeLegacy(current, lines));
      current = null;
      inFreeZone = true;
      continue;
    }
    if (zEnd.test(line)) {
      inFreeZone = false;
      continue;
    }
    if (inFreeZone) continue;
    const sec = sRe.exec(line);
    if (sec) {
      if (current) rules.push(finalizeLegacy(current, lines));
      currentSection = sec[1].trim();
      current = null;
      continue;
    }
    const rule = rHead.exec(line);
    if (rule) {
      if (current) rules.push(finalizeLegacy(current, lines));
      current = { index: rule[1], title: rule[2].trim(), section: currentSection, startLine: i, endLine: i + 1 };
    } else if (current) {
      current.endLine = i + 1;
    }
  }
  if (current) rules.push(finalizeLegacy(current, lines));
  return rules;
}

function finalizeLegacy(rule, lines) {
  const body = lines.slice(rule.startLine + 1, rule.endLine).join("\n").trim();
  const m = String(rule.title || "").match(new RegExp(LEGACY.level.source));
  return { ...rule, level: m ? m[1].replace(/\s+/g, "") : "", body };
}

/** 迁移前实现的四要素提取（照抄现盘 grab()，label 换成中文字面量） */
function extractElementsLegacy(body) {
  const grab = (label) => {
    const re = new RegExp(`\\*\\*${label}(?:（[^）]*）)?\\*\\*[：:]\\s*([^\\n]*(?:\\n(?!\\s*\\*\\*)[^\\n]*)*)`, "i");
    const m = String(body).match(re);
    return m ? m[1].trim() : "";
  };
  return { trigger: grab("触发"), check: grab("检查"), action: grab("动作"), exemption: grab("豁免") };
}

// ── ② 样本规则文件（覆盖：分区 / 来源后缀 / 组合等级 / 多行四要素 / 括号标签 / 自由区域）──
const sample = `# 测试规则

## 一、执行与安全

### [规则 18] 先查手册再动手（执行等级：A 弱）
- **触发**：任务涉及 DSH 使用/配置/迁移/插件/技能/规则，或需本环境经验。
- **检查**：引擎弱检测——该任务首次工具调用前，会话内未 grep/read 过手册。
- **动作**：拒绝首次工具调用（一次），提示先查手册。
- **豁免**：读取手册本身。

### [规则 9] PowerShell 命令执行与编码（执行等级：A+D）
- **触发**：使用内联命令或含中文的脚本。
- **检查**：① 内联命令被硬拦；
  ② 脚本统一 UTF-8 无 BOM（PS7 默认即此）。
- **动作**：硬拦项拒绝加台账。
- **豁免**：用户明确要求使用内联命令时。

### [规则 2] 时间信息须真实（执行等级：B + D）
- **触发**：回答中出现时间表述。
- **动作**：违规 → 审计台账 + 纠正注入。
- **豁免**：无。

### [规则 28] 工作区文件放置（执行等级：D）（来源：/rules 命令）
- **触发**：在工作区创建文件。
- **检查**：先按手册目录索引归类。
- **动作**：不确定时查 README 或问用户。
- **豁免**：根目录必要文件。

## 五、自由区域

<!-- free-zone:start -->

### [规则 F1] 中国法律工作守则
- 区内内容不解析。

<!-- free-zone:end -->

## 六、区后分区

### [规则 19] 知识必沉淀（执行等级：D 强）
- **触发**：学到新知识。
- **检查（引擎硬拦）**：硬拦内容。
  引擎硬拦的补充说明行。
- **检查（自证）**：自证内容。
- **动作**：更新手册。
- **豁免**：读取手册本身。
`;

const ELEMENT_KEYS = ["trigger", "check", "action", "exemption"];

const dir = makeTempHome();
writeAgents(dir, sample);

// ── ③ 默认生效 ≡ 旧行为（逐字段等价）──
const now = loadRules();
const before = loadRulesLegacy(sample);
assert.equal(now.ok, true, "loadRules ok");
assert.equal(now.rules.length, before.length, "规则数一致");
assert.equal(now.rules.length, 5, "自由区域内 2 条被排除，区外 5 条（18/9/2/28/19）");
for (let i = 0; i < before.length; i++) {
  assert.deepEqual(
    {
      index: now.rules[i].index,
      title: now.rules[i].title,
      section: now.rules[i].section,
      startLine: now.rules[i].startLine,
      endLine: now.rules[i].endLine,
      level: now.rules[i].level
    },
    {
      index: before[i].index,
      title: before[i].title,
      section: before[i].section,
      startLine: before[i].startLine,
      endLine: before[i].endLine,
      level: before[i].level
    },
    `规则 ${i} 头部字段等价`
  );
  assert.equal(now.rules[i].body, before[i].body, `规则 ${i} 正文等价`);
}
assert.equal(now.rules[0].level, "A弱", "组合等级 A 弱 归并");
assert.equal(now.rules[1].level, "A+D", "组合等级 A+D 归并");
assert.equal(now.rules[2].level, "B+D", "带空格组合等级 B + D 归并");
assert.equal(now.rules[3].title, "工作区文件放置（执行等级：D）", "（来源：…）后缀被剥离");
assert.equal(now.rules[3].level, "D", "剥离后等级仍可取");
assert.equal(now.rules[4].section, "六、区后分区", "自由区域内的 ## 不切分区");

// 四要素：与旧实现逐字段等价（含 E7 括号标签、多行正文）
for (const rule of now.rules) {
  assert.deepEqual(extractElements(rule.body), extractElementsLegacy(rule.body), `规则 ${rule.index} 四要素等价`);
}
const el18 = extractElements(now.rules[0].body);
assert.ok(el18.trigger.includes("DSH"), "trigger 抽取");
assert.ok(el18.check.includes("grep/read"), "check 抽取");
assert.ok(el18.exemption.includes("读取手册"), "exemption 抽取");
const el9 = extractElements(now.rules[1].body);
assert.ok(el9.check.includes("PS7 默认即此"), "多行元素正文抽取（续行并入）");
const el19 = extractElements(now.rules[4].body);
assert.ok(el19.check.includes("硬拦内容"), "E7：带括号标签的检查可抽取");
assert.ok(el19.check.includes("引擎硬拦的补充说明行"), "续行并入 check（与旧实现同口径）");
assert.equal(extractElements(now.rules[4].body).check, extractElementsLegacy(now.rules[4].body).check, "规则 19 四要素与旧实现逐字相同");

// 等级单点：与旧实现等价（含无等级 / 弱档 / 顿号连接）
for (const t of [
  "先查手册再动手（执行等级：A 弱）",
  "时间信息须真实（执行等级：B + D）",
  "变更与交付验证（执行等级：D 强）",
  "规则管理（执行等级：M）",
  "自由区域（引擎不强制，正常生效）",
  ""
]) {
  const legacy = (String(t || "").match(new RegExp(LEGACY.level.source)) || [null, ""])[1].replace(/\s+/g, "");
  assert.equal(levelFromTitle(t), legacy, `levelFromTitle 等价：${t}`);
}
assert.equal(levelFromTitle(""), "", "空标题不给等级");

// ── ④ 双层模型 + 拒绝面 ──
assert.deepEqual(setFormats(undefined), { applied: [], rejected: [], noop: true }, "undefined 不干预");
assert.equal(hasFormatOverride(), false, "默认无覆盖");
const defHeader = getFormat("rule_header");
assert.equal(normGroups(defHeader.source), LEGACY.rule_header.source, "默认 source = 现盘 L7 的具名组改写（编号↔具名同构）");
assert.equal(normGroups(getFormat("section").source), LEGACY.section.source, "默认 source = 现盘 L8 的具名组改写");
assert.equal(normGroups(getFormat("free_zone").start.source), LEGACY.free_zone_start.source, "默认 start = 现盘 L9 逐字");
assert.equal(normGroups(getFormat("free_zone").end.source), LEGACY.free_zone_end.source, "默认 end = 现盘 L10 逐字");
assert.equal(normGroups(getFormat("level").source), LEGACY.level.source, "默认 source = 现盘 L81 的具名组改写");
for (const k of FORMAT_KEYS) {
  const f = getFormat(k);
  assert.equal(f.flags, "", `${k} 默认 flags 为空（现盘原正则无 flags，不写 g）`);
}
assert.ok(getFormat("elements").source.includes("__LABEL__"), "elements 默认 source 带 __LABEL__ 占位符");
assert.ok(getFormat("elements").source.includes("(?<body>"), "elements 默认 source 的正文用具名组");
assert.deepEqual(getFormat("elements").capture, { body: "body" }, "elements 默认具名组 body");
assert.equal(getFormat("elements").labels.trigger, "触发", "elements 默认标签词");
assert.deepEqual(getFormatCapture("rule_header"), { id: "id", title: "title" }, "rule_header 具名组映射");

// 按键替换：只换 rule_header，其余键保持默认
const custom = setFormats({ rule_header: { source: "^###\\s*\\[规则\\s*(?:([0-9A-Za-z]+))\\]\\s*(?:((.+)))$", flags: "g", capture: { id: "1", title: "2" } } });
assert.deepEqual(custom.applied, ["rule_header"], "按键替换 applied");
assert.deepEqual(custom.rejected, [], "按键替换无拒绝");
assert.equal(hasFormatOverride(), true, "进入覆盖态");
assert.equal(normGroups(getFormat("section").source), LEGACY.section.source, "未给的键保持内置默认");
writeAgents(dir, sample);
assert.equal(loadRules().rules.length, 5, "自定义 rule_header 仍可解析");

// 自定义**具名**捕获组：取值走 m.groups
setFormats({
  rule_header: {
    source: "^###\\s*\\[规则\\s*(?<num>[0-9A-Za-z]+)\\]\\s*(?<name>.+)$",
    flags: "g",
    capture: { id: "num", title: "name" }
  }
});
const namedRes = loadRules();
assert.equal(namedRes.rules.length, 5, "具名组 source 可解析");
assert.equal(namedRes.rules[0].index, "18", "具名组 id 取值");
assert.equal(namedRes.rules[0].title, "先查手册再动手（执行等级：A 弱）", "具名组 title 取值");

// 自定义 elements：占位符 __LABEL__ 代入 + flags 生效（英文标签 + i 忽略大小写）
setFormats({
  elements: {
    source: "\\*\\*(?:__LABEL__)(?:（[^）]*）)?\\*\\*[：:]\\s*(?<body>[^\\n]*(?:\\n(?!\\s*\\*\\*)[^\\n]*)*)",
    flags: "i",
    capture: { body: "body" },
    labels: { trigger: "Trigger", check: "Check", action: "Action", exemption: "Exemption" }
  }
});
const elCustom = extractElements("- **trigger**：英文小写标签也能取（i 生效）。\n- **Check**：第二项。");
assert.ok(elCustom.trigger.includes("英文小写标签也能取"), "占位符代入 + flags=i 生效");
assert.ok(elCustom.check.includes("第二项"), "第二个标签同样代入");
resetFormats();

// 拒绝面：未知键 / 非法形状 / 非法正则 / 非法 capture 值（不静默半套生效）
const bad = setFormats({
  rule_header: { source: "^###", flags: "g" },
  nope: { source: "^##" },
  free_zone: { start: { source: "^<!--" } },
  level: { source: "([" },
  section: { source: "^##\\s+(.+)$", capture: { title: "1x" } }
});
assert.deepEqual(bad.applied, ["rule_header"], "合法键仍按按键替换生效");
assert.deepEqual(
  bad.rejected.map((r) => `${r.key}:${r.reason}`).sort(),
  ["free_zone:missing-end", "level:invalid-regex-source", "nope:unknown-key", "section:invalid-capture:title"].sort(),
  "拒绝明细逐键可读"
);

// {} = 回退内置默认
const empty = setFormats({});
assert.deepEqual(empty.applied, [], "空对象无生效键");
assert.equal(hasFormatOverride(), false, "空对象回退内置默认");

// ── ⑤ 键面自证 ──
assert.deepEqual(FORMAT_KEYS, ["rule_header", "section", "free_zone", "level", "elements"], "五键且 free_zone 算一处");
assert.deepEqual(Object.keys(DEFAULT_FORMATS).sort(), [...FORMAT_KEYS].sort(), "默认表与键清单一致");

resetFormats();
cleanupTempHome(dir);
console.log("formats-config.test.mjs PASS");
