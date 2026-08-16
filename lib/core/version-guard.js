// version-guard.js - 手册/版本记录类文件写后自检（P1）
// 纯函数，可独立测试。
import { basename } from "node:path";

const VERSIONED_NAMES = new Set(["skill.md", "agents.md", "changelog.md", "readme.md"]);

export function isVersionedFile(p) {
  if (typeof p !== "string") return false;
  const name = basename(p).toLowerCase();
  if (VERSIONED_NAMES.has(name)) return true;
  return /版本|version|changelog/i.test(p);
}

/** 从文本中提取版本号列表，只匹配版本记录表行（如 | v3.32 |），不扫全文 */
export function extractVersions(text) {
  if (typeof text !== "string") return [];
  const out = [];
  const lines = text.split("\n");
  const re = /^\s*\| v(\d+)\.(\d+) \|/;
  for (const line of lines) {
    const m = line.match(re);
    if (m) out.push({ major: Number(m[1]), minor: Number(m[2]) });
  }
  return out;
}

/** 校验版本号连续无重复：同一 major 下 minor 从 min 到 max 无缺失、无重复 */
export function validateVersionContinuity(text) {
  const versions = extractVersions(text);
  if (versions.length === 0) return { ok: true, errors: [] };
  const byMajor = new Map();
  for (const v of versions) {
    if (!byMajor.has(v.major)) byMajor.set(v.major, new Set());
    byMajor.get(v.major).add(v.minor);
  }
  const errors = [];
  for (const [major, minors] of byMajor) {
    const arr = [...minors].sort((a, b) => a - b);
    const min = arr[0];
    const max = arr[arr.length - 1];
    for (let i = min; i <= max; i++) {
      if (!minors.has(i)) {
        errors.push(`v${major}.${i} 缺失`);
      }
    }
    if (arr.length !== max - min + 1) {
      errors.push(`v${major} 版本号不连续`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 判断是否为“版本记录行内仅版本号变更”（如 v3.41 → v3.42，重编号场景） */
function isVersionRenumber(oldString, newString) {
  if (typeof oldString !== "string" || typeof newString !== "string") return false;
  const re = /^(\s*\| )v\d+\.\d+( \|[\s\S]*)$/;
  const m1 = oldString.match(re);
  const m2 = newString.match(re);
  if (!m1 || !m2) return false;
  return m1[1] === m2[1] && m1[2] === m2[2];
}

/** 判断是否单行文本（不含换行） */
function isSingleLine(s) {
  return !s.includes("\n") && !s.includes("\r");
}

/** 判断是否 Markdown 表格行 */
function isTableRow(s) {
  return /^\s*\|/.test(s);
}

/** 非表格单行替换：行首锚点足够长；若都含规则编号则编号必须一致 */
function isSameLineReplacement(oldString, newString) {
  if (!isSingleLine(oldString) || !isSingleLine(newString)) return false;
  if (isTableRow(oldString) || isTableRow(newString)) return false;
  const ra = oldString.match(/\[规则\s+([^\]]+)\]/);
  const rb = newString.match(/\[规则\s+([^\]]+)\]/);
  if (ra && rb && ra[1] !== rb[1]) return false;
  const min = Math.min(8, oldString.length, newString.length);
  let i = 0;
  while (i < oldString.length && i < newString.length && oldString[i] === newString[i]) i++;
  return i >= min;
}

/** 校验 append/删除式编辑：新增需包含 old_string；删除/缩短时 new_string 可为 old_string 的子串；版本行重编号放行；非表格单行修改放行 */
export function validateEditAppend(oldString, newString) {
  if (typeof oldString !== "string" || typeof newString !== "string") return { ok: true, errors: [] };
  if (oldString.length === 0) return { ok: true, errors: [] };
  if (isVersionRenumber(oldString, newString)) return { ok: true, errors: [] };
  if (newString.includes(oldString)) return { ok: true, errors: [] };
  if (oldString.includes(newString)) return { ok: true, errors: [] };
  if (isSameLineReplacement(oldString, newString)) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: ["new_string 未包含 old_string，疑似覆盖上一行"]
  };
}

/** 综合校验一次编辑后的文件 */
export function validateEditedFile(originalText, currentText, oldString, newString) {
  const errors = [];
  const continuity = validateVersionContinuity(currentText);
  if (!continuity.ok) errors.push(...continuity.errors);
  const append = validateEditAppend(oldString, newString);
  if (!append.ok) errors.push(...append.errors);
  return { ok: errors.length === 0, errors };
}
