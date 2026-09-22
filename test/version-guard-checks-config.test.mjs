// version-guard-checks-config.test.mjs - 版本守卫判定词迁配置层（第三批，2026-09-21）
//
// ① 等价性：LEGACY 两条源逐字快照；夹具注入后 isVersionedFile／validateEditAppend（含 lineAnchor 的
//    rule_bracket 路径）与"旧内联实现"逐样本等价——含「### [规则 12A]」同号放行、不同号拦截。
// ② 缓存不被锁死：setPatterns 后立即生效（缓存活性自证）。
// ③ 报错字符串不动（直接断言字面量）。
import assert from "node:assert/strict";
import { isVersionedFile, validateEditAppend } from "../lib/core/version-guard.js";
import { patMap, setPatterns, resetPatterns } from "../lib/core/patterns.js";
import { useChinesePatterns, TEST_PATTERNS_ZH } from "./helpers.mjs";

// ── ① 迁移前基线（两条逐字快照 + 旧实现口径）──
const LEGACY = {
  path_mark: "版本|version|changelog",
  rule_bracket: "\\[规则\\s+([^\\]]+)\\]"
};
const VERSIONED_NAMES = new Set(["skill.md", "agents.md", "changelog.md", "readme.md"]);

function isVersionedFileLegacy(p) {
  if (typeof p !== "string") return false;
  const name = p.replace(/^.*[\\/]/, "").toLowerCase();
  if (VERSIONED_NAMES.has(name)) return true;
  return new RegExp(LEGACY.path_mark, "i").test(p);
}
function lineAnchorLegacy(s) {
  const rule = String(s).match(new RegExp(LEGACY.rule_bracket));
  if (rule) return "rule:" + rule[1].trim();
  const h = String(s).match(/^(#{1,6})\s+(.+)$/);
  if (h) return "h" + h[1].length + ":" + h[2].trim().split(/\s+/)[0];
  const li = String(s).match(/^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/);
  if (li) return "li:" + li[2].trim().split(/[：:\s]/)[0];
  const m = String(s).match(/^(\S+)/);
  return "txt:" + (m ? m[1] : "");
}
const isSingleLine = (s) => !s.includes("\n") && !s.includes("\r");
const isTableRow = (s) => /^\s*\|/.test(s);
function validateEditAppendLegacy(oldString, newString, uniqueMatch = false) {
  if (typeof oldString !== "string" || typeof newString !== "string") return { ok: true, errors: [] };
  if (oldString.length === 0) return { ok: true, errors: [] };
  // 迁移前同序判定（本测试只覆盖 lineAnchor 相关分支：单行替换）
  if (newString.includes(oldString)) return { ok: true, errors: [] };
  if (oldString.includes(newString)) return { ok: true, errors: [] };
  if (isSingleLine(oldString) && isSingleLine(newString) && !isTableRow(oldString) && !isTableRow(newString)) {
    if (lineAnchorLegacy(oldString) === lineAnchorLegacy(newString)) return { ok: true, errors: [] };
  }
  if (uniqueMatch && isSingleLine(oldString) && isSingleLine(newString)) return { ok: true, errors: [] };
  return { ok: false, errors: ["new_string 未包含 old_string，疑似覆盖上一行"] };
}

// ── ② 默认层（未注入）：两键内置默认无中文 ──
resetPatterns();
const builtin = patMap("version_guard_checks");
assert.deepEqual(Object.keys(builtin).sort(), Object.keys(LEGACY).sort(), "内置默认两子键齐备");
for (const [k, v] of Object.entries(builtin)) {
  assert.doesNotMatch(v, /[\u4e00-\u9fff]/, `内置默认 version_guard_checks.${k} 含中文（应语言无关）`);
}
assert.equal(new RegExp(builtin.path_mark, "i").test("docs/CHANGELOG.md"), true, "内置 path_mark 命中英文样本（i 生效）");
assert.equal(new RegExp(builtin.rule_bracket).exec("[rule 12A]")[1], "12A", "内置 rule_bracket 保留捕获组");

// ── ③ 夹具注入后：两条源逐字一致 ＋ isVersionedFile 逐样本等价 ──
const injected = useChinesePatterns();
assert.deepEqual(injected.rejected, [], "中文夹具注入无拒绝");
const map = patMap("version_guard_checks");
for (const k of Object.keys(LEGACY)) assert.equal(map[k], LEGACY[k], `version_guard_checks.${k} 源与 LEGACY 逐字一致`);
assert.deepEqual(Object.keys(TEST_PATTERNS_ZH.version_guard_checks).sort(), Object.keys(LEGACY).sort(), "夹具两子键齐备");

const PATH_SAMPLES = [
  "D:/x/skills/example-usage-manual/SKILL.md",
  "D:/x/CHANGELOG.md",
  "D:/x/readme.md",
  "D:/x/AGENTS.md",
  "D:/x/notes.txt",
  "D:/x/版本记录.md",
  "D:/x/version-log.md",
  "D:/x/CHANGELOG-zh.txt",
  "D:/proj/changelog.md",
  "",
  null,
  42
];
for (const p of PATH_SAMPLES) {
  assert.equal(isVersionedFile(p), isVersionedFileLegacy(p), `isVersionedFile 等价：${JSON.stringify(p)}`);
}

// ── ④ lineAnchor 路径（rule_bracket）：同号放行、不同号拦截 ＋ 与旧实现等价 ──
const EDIT_CASES = [
  ["### [规则 12A] 审批", "### [规则 12A] 审批（修订）", false],
  ["### [规则 12A] 审批", "### [规则 12B] 审批", false],
  ["- **检查**：旧内容", "- **检查**：新内容", false],
  ["## 二、沟通与汇报", "## 三、执行与安全", false],
  ["`[规则 12A]` 反引号内", "`[规则 12A]` 反引号内（改）", false],
  ["### [规则 12A] 审批", "### [规则 12A] 审批", true],
  ["### [规则 12A] 审批", "### [规则 12A] 审批", false]
];
for (const [oldS, newS, unique] of EDIT_CASES) {
  const now = validateEditAppend(oldS, newS, unique);
  const legacy = validateEditAppendLegacy(oldS, newS, unique);
  assert.deepEqual(now, legacy, `validateEditAppend 等价：${JSON.stringify(oldS)} → ${JSON.stringify(newS)}（unique=${unique}）`);
}
// 同号放行／不同号拦截的显式断言（不依赖 legacy 镜像）
assert.equal(validateEditAppend("### [规则 12A] 审批", "### [规则 12A] 审批（修订）").ok, true, "同号放行");
assert.equal(validateEditAppend("### [规则 12A] 审批", "### [规则 12B] 审批").ok, false, "不同号拦截");
assert.deepEqual(validateEditAppend("### [规则 12A] 审批", "### [规则 12B] 审批").errors, ["new_string 未包含 old_string，疑似覆盖上一行"], "报错字符串不动");

// ── ⑤ 缓存活性自证：换配置后立即生效（缓存锁死时必红）──
{
  const before = isVersionedFile("D:/x/notes.txt");
  setPatterns({ version_guard_checks: { path_mark: "notes" } });
  assert.equal(isVersionedFile("D:/x/notes.txt"), true, "setPatterns 后立即生效（缓存已清）");
  assert.equal(before, false, "旧配置下该路径不命中");
  resetPatterns();
  assert.equal(isVersionedFile("D:/x/notes.txt"), false, "resetPatterns 后回退内置默认（缓存已清）");
  useChinesePatterns(); // 还原夹具
  assert.equal(isVersionedFile("D:/x/版本记录.md"), true, "还原夹具后中文路径恢复命中");
}

console.log("version-guard-checks-config.test.mjs PASS");
