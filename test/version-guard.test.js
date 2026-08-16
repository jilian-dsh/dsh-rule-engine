import assert from "node:assert/strict";
import {
  extractVersions,
  isVersionedFile,
  validateEditedFile,
  validateVersionContinuity
} from "../lib/core/version-guard.js";

// 文件识别
assert.equal(isVersionedFile("C:/x/SKILL.md"), true);
assert.equal(isVersionedFile("C:/x/AGENTS.md"), true);
assert.equal(isVersionedFile("C:/x/CHANGELOG.md"), true);
assert.equal(isVersionedFile("C:/x/readme.md"), true);
assert.equal(isVersionedFile("C:/x/普通.txt"), false);

// 版本提取
const text = [
  "| v3.1 | 2026-08-14 | a |",
  "| v3.2 | 2026-08-15 | b |",
  "| v3.3 | 2026-08-16 | c |"
].join("\n");
const versions = extractVersions(text);
assert.equal(versions.length, 3);
assert.deepEqual(versions[0], { major: 3, minor: 1 });

// 连续通过
let res = validateVersionContinuity(text);
assert.equal(res.ok, true);

// 缺号失败
res = validateVersionContinuity(text.replace("v3.2", "v3.4"));
assert.equal(res.ok, false);
assert.ok(res.errors.some((e) => e.includes("v3.2 缺失") || e.includes("不连续")));

// append 覆盖上一行检测
res = validateEditedFile(
  "| v3.1 | a |\n| v3.2 | b |\n",
  "| v3.1 | a |\n| v3.3 | c |\n",
  "| v3.2 | b |",
  "| v3.3 | c |"
);
assert.equal(res.ok, false, "new_string not starting with old_string should fail");

// 正确 append 通过
res = validateEditedFile(
  "| v3.1 | a |\n",
  "| v3.1 | a |\n| v3.2 | b |\n",
  "| v3.1 | a |",
  "| v3.1 | a |\n| v3.2 | b |"
);
assert.equal(res.ok, true);

// 正文中的插件版本（非表格行）不得参与版本连续性校验
res = validateVersionContinuity(text + "\n插件版本：dsh-usage@0.1.1、super-injector v0.3.3\n");
assert.equal(res.ok, true, "plugin versions in body should not break continuity");

// 表头插入：new_string 包含 old_string 即可，允许 v3.33 插在 v3.32 前
res = validateEditedFile(
  "| v3.32 | z |\n",
  "| v3.33 | new |\n| v3.32 | z |\n",
  "| v3.32 | z |",
  "| v3.33 | new |\n| v3.32 | z |"
);
assert.equal(res.ok, true, "top insertion should pass");

// 删除/缩短：new_string 是 old_string 的子串时放行
res = validateEditedFile(
  "| v3.1 | a |\n| v3.2 | b |\n",
  "| v3.1 | a |\n",
  "| v3.2 | b |",
  ""
);
assert.equal(res.ok, true, "deletion (substring) should pass");

// 版本记录行内仅版本号变更（重编号）应放行
res = validateEditedFile(
  "| v3.41 | 2026-08-16 | old |\n",
  "| v3.42 | 2026-08-16 | old |\n",
  "| v3.41 | 2026-08-16 | old |",
  "| v3.42 | 2026-08-16 | old |"
);
assert.equal(res.ok, true, "version renumber should pass");

// 非表格单行修改应放行（整行替换但行首锚点一致）
res = validateEditedFile(
  "- **动作**：违规项自证说明。\n",
  "- **动作**：硬拦项拒绝 + 台账；自证项自证说明。\n",
  "- **动作**：违规项自证说明。",
  "- **动作**：硬拦项拒绝 + 台账；自证项自证说明。"
);
assert.equal(res.ok, true, "non-table same-line modification should pass");

// 非表格单行替换为不同字段标签应拦截
res = validateEditedFile(
  "- **动作**：违规项自证说明。\n",
  "- **检查**：违规项自证说明。\n",
  "- **动作**：违规项自证说明。",
  "- **检查**：违规项自证说明。"
);
assert.equal(res.ok, false, "different field label should fail");

// 规则标题同编号修改应放行
res = validateEditedFile(
  "### [规则 12A] 执行前确认\n",
  "### [规则 12A] 执行前确认（含授权证据）\n",
  "### [规则 12A] 执行前确认",
  "### [规则 12A] 执行前确认（含授权证据）"
);
assert.equal(res.ok, true, "same rule id heading modification should pass");

// 规则标题不同编号替换应拦截
res = validateEditedFile(
  "### [规则 12A] 执行前确认\n",
  "### [规则 12B] 执行前确认\n",
  "### [规则 12A] 执行前确认",
  "### [规则 12B] 执行前确认"
);
assert.equal(res.ok, false, "different rule id heading should fail");

console.log("version-guard.test.js PASS");
