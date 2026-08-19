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

/** 判断是否为“同一行内仅版本号数字变更”（如徽章 version-1.4.3 → version-1.4.7）——
 *  前后缀完全一致、仅中间版本号不同 → 合法更新，不是覆盖上一行（文档审计发现：徽章行更新被误拦） */
function isInlineVersionChange(oldString, newString) {
  if (typeof oldString !== "string" || typeof newString !== "string") return false;
  if (!isSingleLine(oldString) || !isSingleLine(newString)) return false;
  if (isTableRow(oldString) || isTableRow(newString)) return false;
  const re = /^([\s\S]*?)(\d+\.\d+(?:\.\d+)?)([\s\S]*)$/;
  const m1 = oldString.match(re);
  const m2 = newString.match(re);
  if (!m1 || !m2) return false;
  return m1[1] === m2[1] && m1[3] === m2[3] && m1[2] !== m2[2];
}

/** 判断是否单行文本（不含换行） */
function isSingleLine(s) {
  return !s.includes("\n") && !s.includes("\r");
}

/** 判断是否 Markdown 表格行 */
function isTableRow(s) {
  return /^\s*\|/.test(s);
}

/** 提取单行文本的“行锚点”：规则编号 > 标题前缀+首词 > 列表符号+首段标签 > 首词 */
function lineAnchor(s) {
  const rule = s.match(/\[规则\s+([^\]]+)\]/);
  if (rule) return "rule:" + rule[1].trim();
  const h = s.match(/^(#{1,6})\s+(.+)$/);
  if (h) return "h" + h[1].length + ":" + h[2].trim().split(/\s+/)[0];
  const li = s.match(/^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/);
  if (li) {
    const token = li[2].trim().split(/[：:\s]/)[0];
    return "li:" + token;
  }
  const m = s.match(/^(\S+)/);
  return "txt:" + (m ? m[1] : "");
}

/** 非表格单行替换：行锚点一致即放行（同列表项/同标题/同规则编号的正文修正） */
function isSameLineReplacement(oldString, newString) {
  if (!isSingleLine(oldString) || !isSingleLine(newString)) return false;
  if (isTableRow(oldString) || isTableRow(newString)) return false;
  return lineAnchor(oldString) === lineAnchor(newString);
}

/** 表格行内单元格替换：同一行首列一致即放行（如插件快照表格 1.4.5→1.4.6） */
function isTableRowReplacement(oldString, newString) {
  if (!isSingleLine(oldString) || !isSingleLine(newString)) return false;
  if (!isTableRow(oldString) || !isTableRow(newString)) return false;
  const firstCell = (s) => {
    const cells = s.trim().split("|").filter((c) => c.trim().length > 0);
    return cells.length > 0 ? cells[0].trim() : "";
  };
  return firstCell(oldString) !== "" && firstCell(oldString) === firstCell(newString);
}

/** 中间插入多行段落：旧内容所有非空行按序出现在新内容中即放行 */
function isOrderedLineInsertion(oldString, newString) {
  const oldLines = String(oldString || "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  const newLines = String(newString || "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (oldLines.length === 0) return true;
  let i = 0;
  for (const line of newLines) {
    if (i < oldLines.length && line.trim() === oldLines[i].trim()) i++;
  }
  return i === oldLines.length;
}

/** 校验 append/删除式编辑：新增需包含 old_string；删除/缩短时 new_string 可为 old_string 的子串；版本行重编号放行；非表格单行修改放行 */
export function validateEditAppend(oldString, newString) {
  if (typeof oldString !== "string" || typeof newString !== "string") return { ok: true, errors: [] };
  if (oldString.length === 0) return { ok: true, errors: [] };
  if (isVersionRenumber(oldString, newString)) return { ok: true, errors: [] };
  if (isInlineVersionChange(oldString, newString)) return { ok: true, errors: [] };
  if (newString.includes(oldString)) return { ok: true, errors: [] };
  if (oldString.includes(newString)) return { ok: true, errors: [] };
  if (isSameLineReplacement(oldString, newString)) return { ok: true, errors: [] };
  if (isTableRowReplacement(oldString, newString)) return { ok: true, errors: [] };
  if (isOrderedLineInsertion(oldString, newString)) return { ok: true, errors: [] };
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
