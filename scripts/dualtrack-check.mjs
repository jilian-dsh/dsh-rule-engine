// dualtrack-check.mjs - 分层残留扫描闸（dualtrack-check）
//
// 依据：本机使用手册 SKILL.md:113「修改双轨制（2026-08-31 用户定稿）——
//   铁律=代码层零本机内容（发布门禁扫描红）；机器校验（dualtrack-check）为验收兜底」。
// 本脚本是那句承诺的落地实现。
//
// 扫描三层（lib/**/*.js）：
//   ① 运行时字符串：字符串字面量内的 CJK 字符（注释剔除，JSDoc 跳过；正则字面量不计——另有 P8 扫描器）
//   ② 映射表键：对象字面量键名匹配 ^\d+[A-Z]?$ 或含 CJK
//   ③ 本机标识：复用 B2 词表 scripts/local-residue-markers.txt（路径/脚本名/端口/代理变量）
//
// 棘轮（ratchet）：基线记录各文件计数，只许降不许升。
//   node scripts/dualtrack-check.mjs            # 比对基线（CI/发布门禁用）
//   node scripts/dualtrack-check.mjs --init     # 首次生成基线
//   node scripts/dualtrack-check.mjs --update   # 手动更新基线（须在提交说明里写清改了什么）
//   node scripts/dualtrack-check.mjs --report   # 只打印各文件计数
//
// 白名单（scripts/dualtrack-whitelist.json）：
//   files   —— 整文件豁免（如 lib/lang/**，第 3 批语言包）
//   strings —— 通用功能词精确豁免（第三方 §一：中文≠个人化，许可词/时间词是产品能力）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(ROOT, "lib");
const BASELINE_FILE = path.join(ROOT, "scripts", "dualtrack-baseline.json");
const WHITELIST_FILE = path.join(ROOT, "scripts", "dualtrack-whitelist.json");
const RESIDUE_FILE = path.join(ROOT, "scripts", "local-residue-markers.txt");

const CJK = /[\u4e00-\u9fff]/;
const MAP_KEY_RE = /^\d+[A-Z]?$/;

// ── 白名单 ──
function loadWhitelist() {
  if (!fs.existsSync(WHITELIST_FILE)) return { files: [], strings: new Set() };
  try {
    const w = JSON.parse(fs.readFileSync(WHITELIST_FILE, "utf8"));
    return { files: w.files || [], strings: new Set(w.strings || []) };
  } catch (e) {
    throw new Error(`白名单解析失败：${WHITELIST_FILE} — ${e.message}`);
  }
}

/** 整文件豁免匹配（支持 ** 与 * 通配，路径用 / 分隔，相对仓库根） */
function fileExempt(relPath, patterns) {
  for (const p of patterns) {
    const re = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
    if (re.test(relPath)) return true;
  }
  return false;
}

// ── 词法扫描：剔除注释，收集字符串字面量与对象键 ──
/**
 * @returns {{strings: string[], mapKeys: string[]}}
 *    strings = 字符串字面量的**内容**（模板串按整段处理）
 *    mapKeys = 形如 "14": / '12E': / 14: 的对象键
 */
function tokenize(src) {
  const strings = [];
  const mapKeys = [];
  let i = 0;
  const n = src.length;
  // 上一个有意义的 token 类型：用于判断 `/` 是正则还是除号（简化：只看是否可能在正则位置）
  let prevSig = "";
  while (i < n) {
    const c = src[i];
    // 行注释
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // 块注释（含 JSDoc）
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // 字符串 / 模板串
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      let buf = "";
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") { buf += src[i] + (src[i + 1] || ""); i += 2; continue; }
        buf += src[i];
        i++;
      }
      i++; // 收尾引号
      strings.push(buf);
      // 对象键判定：字符串后（跳过空白）紧跟冒号
      let j = i;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === ":") {
        const plain = buf.replace(/\\(.)/g, "$1");
        if (MAP_KEY_RE.test(plain) || CJK.test(plain)) mapKeys.push(plain);
      }
      prevSig = "str";
      continue;
    }
    // 正则字面量（跳过，不计入）
    if (c === "/" && prevSig !== "ident" && prevSig !== ")" && prevSig !== "]") {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = src[j];
        if (ch === "\\") { j += 2; continue; }
        if (ch === "\n") break;
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        i = j + 1;
        while (i < n && /[a-z]/i.test(src[i])) i++;
        prevSig = "regex";
        continue;
      }
      i++;
      prevSig = "op";
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      i = j;
      prevSig = "ident";
      continue;
    }
    if (c === ")") { prevSig = ")"; i++; continue; }
    if (c === "]") { prevSig = "]"; i++; continue; }
    if (!/\s/.test(c)) prevSig = "op";
    i++;
  }
  return { strings, mapKeys };
}

// ── 单文件扫描 ──
function scanFile(absPath, relPath, whitelist, residueMarks) {
  const src = fs.readFileSync(absPath, "utf8");
  const { strings, mapKeys } = tokenize(src);
  let runtime = 0;
  const runtimeHits = [];
  for (const s of strings) {
    if (!CJK.test(s)) continue;
    const plain = s.replace(/\\(.)/g, "$1").trim();
    if (whitelist.strings.has(plain)) continue; // 通用功能词豁免
    runtime++;
    if (runtimeHits.length < 3) runtimeHits.push(plain.slice(0, 40));
  }
  const mapHits = mapKeys.filter((k) => MAP_KEY_RE.test(k) || CJK.test(k));
  let local = 0;
  const localHits = [];
  for (const s of strings) {
    for (const mark of residueMarks) {
      if (mark && s.includes(mark)) {
        local++;
        if (localHits.length < 3) localHits.push(`${mark} ← ${s.slice(0, 40)}`);
      }
    }
  }
  return {
    relPath,
    runtime,
    mapKeys: mapHits.length,
    local,
    total: runtime + mapHits.length + local,
    runtimeHits,
    mapHits: mapHits.slice(0, 5),
    localHits
  };
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, base, out);
    else if (/\.js$/.test(e)) out.push(path.relative(base, p).replace(/\\/g, "/"));
  }
  return out;
}

// ── 主流程 ──
const args = new Set(process.argv.slice(2));
const whitelist = loadWhitelist();
const residueMarks = fs.existsSync(RESIDUE_FILE)
  ? fs.readFileSync(RESIDUE_FILE, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"))
  : [];

const files = walk(LIB).filter((rel) => !fileExempt(rel, whitelist.files));
const results = files.map((rel) => scanFile(path.join(LIB, rel), rel, whitelist, residueMarks));
const counts = {};
for (const r of results) counts[`lib/${r.relPath}`] = r.total;
const grandTotal = results.reduce((a, r) => a + r.total, 0);

if (args.has("--report")) {
  for (const r of results.sort((a, b) => b.total - a.total)) {
    if (r.total === 0) continue;
    console.log(`  ${String(r.total).padStart(4)}  lib/${r.relPath}  [字符串 ${r.runtime} / 映射键 ${r.mapKeys} / 本机标识 ${r.local}]`);
  }
  console.log(`\nDUALTRACK REPORT：${results.length} 文件，合计 ${grandTotal}`);
  process.exit(0);
}

if (args.has("--init") || args.has("--update")) {
  const isUpdate = args.has("--update");
  if (isUpdate && !fs.existsSync(BASELINE_FILE)) {
    console.error("REFUSED: --update 需要已存在的基线；首次请用 --init");
    process.exit(1);
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    note: "dualtrack 棘轮基线：各文件「分层残留」计数，只许降不许升。--init 首次生成，--update 手动更新（须在提交说明里写清改了什么）。",
    total: grandTotal,
    files: counts
  };
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`${isUpdate ? "UPDATED" : "INITIALIZED"} ${BASELINE_FILE}`);
  console.log(`基线合计：${grandTotal}（${Object.keys(counts).length} 个文件）`);
  process.exit(0);
}

// 默认：比对基线
if (!fs.existsSync(BASELINE_FILE)) {
  console.error(`FAIL  基线不存在：${BASELINE_FILE}\n      首次请运行：node scripts/dualtrack-check.mjs --init`);
  process.exit(1);
}
const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
const base = baseline.files || {};
const regressions = [];
const improvements = [];
for (const [file, count] of Object.entries(counts)) {
  const b = base[file];
  if (b === undefined) {
    if (count > 0) regressions.push(`${file}: 新增文件含残留 ${count} 处（基线无此文件）`);
    continue;
  }
  if (count > b) {
    const r = results.find((x) => `lib/${x.relPath}` === file);
    const detail = r ? [...r.runtimeHits, ...r.localHits].slice(0, 2).join("；") : "";
    regressions.push(`${file}: ${count} > 基线 ${b}${detail ? `（如：${detail}）` : ""}`);
  } else if (count < b) {
    improvements.push(`${file}: ${count} < 基线 ${b}`);
  }
}
for (const [file, b] of Object.entries(base)) {
  if (counts[file] === undefined && b > 0) improvements.push(`${file}: 文件已删除（基线 ${b}）`);
}

if (regressions.length > 0) {
  console.error(`DUALTRACK FAIL：${regressions.length} 项超出基线（只许降不许升）`);
  for (const r of regressions) console.error(`  ✗ ${r}`);
  console.error("\n  处置：把新增内容迁个人层/配置层，或（确属通用功能词）登记 scripts/dualtrack-whitelist.json");
  process.exit(1);
}
console.log(`DUALTRACK OK：合计 ${grandTotal}（基线 ${baseline.total ?? "?"}）${improvements.length ? `，${improvements.length} 个文件下降可 --update` : ""}`);
for (const im of improvements.slice(0, 5)) console.log(`  ↓ ${im}`);
process.exit(0);
