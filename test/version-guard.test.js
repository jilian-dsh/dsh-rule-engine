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

// 同一行内短正文修正：行锚点一致即放行（不再卡 8 字符前缀）
res = validateEditedFile(
  "- **动作**：a\n",
  "- **动作**：b\n",
  "- **动作**：a",
  "- **动作**：b"
);
assert.equal(res.ok, true, "same anchor short line modification should pass");

// 编号列表项同标签正文修正应放行
res = validateEditedFile(
  "1. **修正**：错误内容\n",
  "1. **修正**：正确内容\n",
  "1. **修正**：错误内容",
  "1. **修正**：正确内容"
);
assert.equal(res.ok, true, "numbered list same-field correction should pass");

// 多行整段重写仍应拦截（安全兜底）
res = validateEditedFile(
  "第一行\n第二行\n",
  "第一行\n修改后的第二行\n",
  "第一行\n第二行",
  "第一行\n修改后的第二行"
);
assert.equal(res.ok, false, "multi-line rewrite should still be blocked");

// 短行首词相同、后半修正应放行（旧逻辑 8 字符前缀会误拦）
res = validateEditedFile(
  "foo a\n",
  "foo b\n",
  "foo a",
  "foo b"
);
assert.equal(res.ok, true, "short same-first-word line modification should pass");

// 首词不同的单行替换仍应拦截
res = validateEditedFile(
  "foo a\n",
  "bar a\n",
  "foo a",
  "bar a"
);
assert.equal(res.ok, false, "different first word should fail");

// 修正版 #4：表格行内单元格修改应放行（插件快照 1.4.5→1.4.6）
res = validateEditedFile(
  "| 包名 | 版本 | 说明 |\n| dsh-rules-manager | 1.4.5 | 规则管理 |\n",
  "| 包名 | 版本 | 说明 |\n| dsh-rules-manager | 1.4.6 | 规则管理 |\n",
  "| dsh-rules-manager | 1.4.5 | 规则管理 |",
  "| dsh-rules-manager | 1.4.6 | 规则管理 |"
);
assert.equal(res.ok, true, "table row cell replacement should pass");

// 修正版 #5：中间插入多行段落应放行（旧内容所有非空行按序出现在新内容）
res = validateEditedFile(
  "第一行\n第三行\n",
  "第一行\n第二行\n第三行\n",
  "第一行\n第三行",
  "第一行\n第二行\n第三行"
);
assert.equal(res.ok, true, "ordered middle insertion should pass");

// 修正版 #7：同一行内仅版本号数字变更应放行（徽章行 version-1.4.3 → version-1.4.7，
// 文档审计发现：README 徽章更新被版本守卫误拦为"覆盖上一行"）
res = validateEditedFile(
  "![version](https://img.shields.io/badge/version-1.4.3-blue)\n",
  "![version](https://img.shields.io/badge/version-1.4.7-blue)\n",
  "![version](https://img.shields.io/badge/version-1.4.3-blue)",
  "![version](https://img.shields.io/badge/version-1.4.7-blue)"
);
assert.equal(res.ok, true, "inline version badge change should pass");
// 同一行内非版本号数字变化仍应拦截（前后缀相同但中间不是版本号语义——保守起见仍按版本号模式放行，这里验证数字之外的改动不误放）
res = validateEditedFile(
  "![version](https://img.shields.io/badge/version-1.4.3-blue)\n",
  "![version](https://img.shields.io/badge/version-1.4.3-green)\n",
  "![version](https://img.shields.io/badge/version-1.4.3-blue)",
  "![version](https://img.shields.io/badge/version-1.4.3-green)"
);
assert.equal(res.ok, false, "same-version different-suffix change should still fail");

console.log("version-guard.test.js PASS");
