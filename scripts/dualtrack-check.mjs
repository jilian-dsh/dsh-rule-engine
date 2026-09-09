// dualtrack-check.mjs - 分层残留扫描闸（dualtrack-check）
//
// 依据：本机使用手册 SKILL.md:113「修改双轨制（2026-08-31 用户定稿）——
//   铁律=代码层零本机内容（发布门禁扫描红）；机器校验（dualtrack-check）为验收兜底」。
// 本脚本是那句承诺的落地实现。
//
// 扫描范围（lib/**/*.js）——判据 A（2026-09-09 用户拍板，与方案 §一 一致）：
//   闸只扫「**会随发布者/规则集/环境变化**」的内容，不扫通用中文文案。
//   ① 本机标识：发布者私有词表（rule-engine.json 的 dualtrack.markers）命中的字符串
//   ② 映射表键：对象字面量键名匹配 ^\d+[A-Z]?$ 或含 CJK（规则号索引=某人的规则体系）
//   —— 通用中文文案（字符串字面量内的 CJK）**不计入**：第三方判据明示「中文≠个人化，
//      通用功能词/提示语是产品能力」。runtime 计数仍在 --report 里显示，供参考。
//
// 扫描判据 D（2026-09-10 分层架构 v3 · P0 追加）：规则号字面量
//   依据：reports/2026-09-10-引擎分层架构-通用层零规则内容-v1.md §七。
//   模式：rule\d+[A-Za-z]?-  /  byId\.get\("\d+"\)  /  \[guardian:rule\d+\]  /  rule-hint\.\d+
//         /  ruleId\s*[=!]==?\s*"<N>"（2026-09-10 用户拍板纳入；§七 原列四条，此条据 §二 现状证据补入）
//   为何单列一判据：「机制以规则号为骨架」比「文案含编号」更根本，且与判据 A 不同维度
//   （A 抓本机私有词/映射键；D 抓通用层住着规则体系），故各自独立棘轮。
//   口径：去注释后扫描（注释属开发溯源，非机制骨架）；不设白名单——代码层零规则号。
//
// 棘轮（ratchet）：基线记录各文件计数，只许降不许升。
//   node scripts/dualtrack-check.mjs            # 比对基线（CI/发布门禁用）
//   node scripts/dualtrack-check.mjs --init     # 首次生成基线
//   node scripts/dualtrack-check.mjs --update   # 手动更新基线（须在提交说明里写清改了什么）
//   node scripts/dualtrack-check.mjs --report   # 只打印各文件计数
//   node scripts/dualtrack-check.mjs --root <dir>  # 改扫描根（仅测试隔离用；非默认根会显著提示）
//
// 白名单（scripts/dualtrack-whitelist.json）：
//   files   —— 整文件豁免（如 lib/lang/**，第 3 批语言包）
//   strings —— 通用功能词精确豁免（第三方 §一：中文≠个人化，许可词/时间词是产品能力）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMarkers } from "../lib/core/dualtrack-markers.js";

// ── 命令行参数（提前解析：--root 必须在下面的路径常量之前生效）──
const ARGV = process.argv.slice(2);
const args = new Set(ARGV);
const rootIdx = ARGV.indexOf("--root");
const IS_CUSTOM_ROOT = rootIdx >= 0;
const ROOT = IS_CUSTOM_ROOT && ARGV[rootIdx + 1]
  ? path.resolve(ARGV[rootIdx + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(ROOT, "lib");
const BASELINE_FILE = path.join(ROOT, "scripts", "dualtrack-baseline.json");
const WHITELIST_FILE = path.join(ROOT, "scripts", "dualtrack-whitelist.json");
const RESIDUE_FILE = path.join(ROOT, "scripts", "local-residue-markers.txt");

const CJK = /[\u4e00-\u9fff]/;
const MAP_KEY_RE = /^\d+[A-Z]?$/;

// ── 判据 D：规则号字面量（§七；口径=去注释后扫描，无白名单）──
const RULE_LITERAL_PATTERNS = [
  ["executor-name", /rule\d+[A-Za-z]?-/g, "内部执行器名 rule<N>[x]-"],
  ["byid-get", /byId\.get\(\s*["'`]\d+["'`]\s*\)/g, '按规则号取规则 byId.get("<N>")'],
  ["guardian-tag", /\[guardian:rule\d+\]/g, "对外文案 [guardian:rule<N>]"],
  ["rule-hint", /rule-hint\.\d+/g, "rule-hint.<N>"],
  ["ruleid-eq", /ruleId\s*[=!]==?\s*["'`]\d+[A-Za-z]?["'`]/g, '硬编码规则号比较 ruleId === "<N>"']
];

// ── 白名单 ──
/** 白名单两层（2026-09-09）：包内通用白名单 + 本机 rule-engine.json 的 dualtrack.whitelist 合并。
 *  包内那份随包发布（如 lib/lang/**）；本机那份记录「我豁免我自己的某条」，不进包。 */
function loadWhitelist() {
  const files = [];
  const strings = new Set();
  // ① 包内通用白名单
  if (fs.existsSync(WHITELIST_FILE)) {
    try {
      const w = JSON.parse(fs.readFileSync(WHITELIST_FILE, "utf8"));
      for (const f of w.files || []) files.push(f);
      for (const s of w.strings || []) strings.add(s);
    } catch (e) {
      throw new Error(`白名单解析失败：${WHITELIST_FILE} — ${e.message}`);
    }
  }
  // ② 本机白名单（rule-engine.json 的 dualtrack.whitelist）
  try {
    const p = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "rule-engine.json");
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      const w = cfg?.dualtrack?.whitelist;
      if (w && typeof w === "object") {
        for (const f of w.files || []) files.push(f);
        for (const s of w.strings || []) strings.add(s);
      }
    }
  } catch {
    // 本机配置不可读 → 只用包内白名单（不阻断）
  }
  return { files, strings };
}

/** 整文件豁免匹配（支持 ** 与 * 通配，路径用 / 分隔，相对仓库根） */
function fileExempt(relPath, patterns) {
  for (const p of patterns) {
    const re = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
    if (re.test(relPath)) return true;
  }
  return false;
}

// ── 去注释（判据 D 用）：保留字符串/模板/正则原文，注释替换为空白（保持行结构） ──
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let prevSig = "";
  const push = (s) => { out += s; };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") { push(" "); i++; }
      continue;
    }
    if (c === "/" && c2 === "*") {
      push("  "); i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) { push("  "); i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      push(c); i++;
      while (i < n) {
        if (src[i] === "\\") { push(src[i] + (src[i + 1] || "")); i += 2; continue; }
        push(src[i]);
        if (src[i] === q) { i++; break; }
        i++;
      }
      prevSig = "str";
      continue;
    }
    // 正则字面量：仅在可能的正则位置整体复制（否则 / 是除号）
    if (c === "/" && prevSig !== "ident" && prevSig !== ")" && prevSig !== "]" && prevSig !== "str") {
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
        push(src.slice(i, j + 1));
        i = j + 1;
        while (i < n && /[a-z]/i.test(src[i])) { push(src[i]); i++; }
        prevSig = "regex";
        continue;
      }
    }
    push(c);
    if (/[A-Za-z0-9_$]/.test(c)) prevSig = "ident";
    else if (c === ")") prevSig = ")";
    else if (c === "]") prevSig = "]";
    else if (!/\s/.test(c)) prevSig = "other";
    i++;
  }
  return out;
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
      const start = i;
      i++;
      let buf = "";
      if (q === "`") {
        // 模板串：整段作为一个字符串，但 `${...}` 内的表达式跳过（不计入内容，也不当键）
        while (i < n) {
          const ch = src[i];
          if (ch === "\\") { buf += ch + (src[i + 1] || ""); i += 2; continue; }
          if (ch === "$" && src[i + 1] === "{") {
            let depth = 1;
            i += 2;
            while (i < n && depth > 0) {
              const d = src[i];
              if (d === "\\") { i += 2; continue; }
              if (d === "{") depth++;
              else if (d === "}") depth--;
              else if (d === '"' || d === "'" || d === "`") {
                const qq = d; i++;
                while (i < n && src[i] !== qq) { if (src[i] === "\\") i++; i++; }
              }
              i++;
            }
            buf += "\u0000"; // 表达式占位（不含 CJK）
            continue;
          }
          if (ch === "`") break;
          buf += ch;
          i++;
        }
      } else {
        while (i < n && src[i] !== q) {
          if (src[i] === "\\") { buf += src[i] + (src[i + 1] || ""); i += 2; continue; }
          buf += src[i];
          i++;
        }
      }
      i++; // 收尾引号
      strings.push(buf);
      // 对象键判定（2026-09-09 修正）：必须「前面是 { 或 ,」且「后面（跳空白）是 :」
      // —— 否则模板串分段与三元表达式会被误判成键（20 处误报的根因）。
      let j = i;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === ":") {
        let p = start - 1;
        while (p >= 0 && /\s/.test(src[p])) p--;
        if (src[p] === "{" || src[p] === ",") {
          const plain = buf.replace(/\\(.)/g, "$1");
          if (MAP_KEY_RE.test(plain) || CJK.test(plain)) mapKeys.push(plain);
        }
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
  // 判据 D：去注释后扫规则号字面量
  const code = stripComments(src);
  let ruleLiterals = 0;
  const ruleLiteralHits = [];
  for (const [id, re, desc] of RULE_LITERAL_PATTERNS) {
    const m = code.match(re);
    if (!m) continue;
    ruleLiterals += m.length;
    if (ruleLiteralHits.length < 3) ruleLiteralHits.push(`${id}×${m.length}（${desc}）如 ${m[0]}`);
  }
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
    ruleLiterals,
    // 判据 A：total 只计「本机性」两类；通用中文文案（runtime）不计入闸
    total: mapHits.length + local,
    runtimeHits,
    mapHits: mapHits.slice(0, 5),
    localHits,
    ruleLiteralHits
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
if (IS_CUSTOM_ROOT) console.log(`SCAN ROOT（非默认，仅测试隔离用）：${ROOT}\n`);
const whitelist = loadWhitelist();
// 本机标识词表：与 B2 扫描器共用唯一加载器（本机配置优先 → 环境变量 → 包内示例）
const { markers: residueMarks, source: markersSource } = loadMarkers({ root: ROOT });
if (residueMarks.length === 0) {
  console.error("REFUSED: 本机标识词表为空——请在 rule-engine.json 配置 dualtrack.markers，或设置 DUALTRACK_MARKERS 环境变量");
  process.exit(1);
}

const files = walk(LIB).filter((rel) => !fileExempt(rel, whitelist.files));
const results = files.map((rel) => scanFile(path.join(LIB, rel), rel, whitelist, residueMarks));
const counts = {};
const ruleCounts = {};
for (const r of results) {
  counts[`lib/${r.relPath}`] = r.total;
  ruleCounts[`lib/${r.relPath}`] = r.ruleLiterals;
}
const grandTotal = results.reduce((a, r) => a + r.total, 0);
const ruleGrandTotal = results.reduce((a, r) => a + r.ruleLiterals, 0);

if (args.has("--report")) {
  for (const r of results.sort((a, b) => (b.total + b.ruleLiterals) - (a.total + a.ruleLiterals))) {
    if (r.total === 0 && r.ruleLiterals === 0) continue;
    console.log(`  ${String(r.total).padStart(4)}  lib/${r.relPath}  [映射键 ${r.mapKeys} / 本机标识 ${r.local} / 通用中文文案 ${r.runtime}（不计入闸）] [规则号字面量 ${r.ruleLiterals}]`);
    if (r.mapHits.length) console.log(`        命中键：${r.mapHits.join(" / ")}`);
    if (r.ruleLiteralHits.length) console.log(`        规则号字面量：${r.ruleLiteralHits.join("；")}`);
  }
  console.log(`\nDUALTRACK REPORT：${results.length} 文件，判据 A（分层残留）合计 ${grandTotal}，判据 D（规则号字面量）合计 ${ruleGrandTotal}`);
  process.exit(0);
}

if (args.has("--init") || args.has("--update")) {
  const isUpdate = args.has("--update");
  if (isUpdate && !fs.existsSync(BASELINE_FILE)) {
    console.error("REFUSED: --update 需要已存在的基线；首次请用 --init");
    process.exit(1);
  }
  if (!isUpdate && fs.existsSync(BASELINE_FILE)) {
    console.error(
      `REFUSED: 基线已存在（${BASELINE_FILE}）——--init 仅用于首次生成。\n` +
      "      --init 会把当前计数覆盖为基线（棘轮失效）；确需更新请用 --update（须在提交说明里写清改了什么）"
    );
    process.exit(1);
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    note: "dualtrack 棘轮基线：各文件计数，只许降不许升。files/total=判据 A（分层残留）；ruleLiteralFiles/ruleLiteralsTotal=判据 D（规则号字面量）。--init 首次生成，--update 手动更新（须在提交说明里写清改了什么）。",
    total: grandTotal,
    files: counts,
    ruleLiteralsTotal: ruleGrandTotal,
    ruleLiteralFiles: ruleCounts
  };
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`${isUpdate ? "UPDATED" : "INITIALIZED"} ${BASELINE_FILE}`);
  console.log(`基线：判据 A 合计 ${grandTotal}（${Object.keys(counts).length} 文件）／判据 D 合计 ${ruleGrandTotal}`);
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

// 判据 D 比对（独立棘轮；基线缺该维度 → fail-closed，提示 --update）
const ruleBase = baseline.ruleLiteralFiles;
const ruleRegressions = [];
const ruleImprovements = [];
if (!ruleBase || typeof ruleBase !== "object") {
  ruleRegressions.push("基线缺「规则号字面量」维度（ruleLiteralFiles）——判据 D 于 2026-09-10 新增，请运行 --update 记录基线");
} else {
  for (const [file, count] of Object.entries(ruleCounts)) {
    const b = ruleBase[file];
    if (b === undefined) {
      if (count > 0) ruleRegressions.push(`${file}: 新增文件含规则号字面量 ${count} 处（基线无此文件）`);
      continue;
    }
    if (count > b) {
      const r = results.find((x) => `lib/${x.relPath}` === file);
      const detail = r ? r.ruleLiteralHits.slice(0, 2).join("；") : "";
      ruleRegressions.push(`${file}: ${count} > 基线 ${b}${detail ? `（如：${detail}）` : ""}`);
    } else if (count < b) {
      ruleImprovements.push(`${file}: ${count} < 基线 ${b}`);
    }
  }
  for (const [file, b] of Object.entries(ruleBase)) {
    if (ruleCounts[file] === undefined && b > 0) ruleImprovements.push(`${file}: 文件已删除（基线 ${b}）`);
  }
}

if (regressions.length > 0 || ruleRegressions.length > 0) {
  if (regressions.length > 0) {
    console.error(`DUALTRACK FAIL（判据 A 分层残留）：${regressions.length} 项超出基线（只许降不许升）`);
    for (const r of regressions) console.error(`  ✗ ${r}`);
  }
  if (ruleRegressions.length > 0) {
    console.error(`DUALTRACK FAIL（判据 D 规则号字面量）：${ruleRegressions.length} 项超出基线（只许降不许升）`);
    for (const r of ruleRegressions) console.error(`  ✗ ${r}`);
  }
  console.error("\n  处置：分层残留 → 迁个人层/配置层，或（确属通用功能词）登记 scripts/dualtrack-whitelist.json");
  console.error("        规则号字面量 → 改为通用 kind 名（架构 v3 §三 L1）；判据 D 不设白名单。");
  process.exit(1);
}
const downCount = improvements.length + ruleImprovements.length;
console.log(`DUALTRACK OK：判据 A 合计 ${grandTotal}（基线 ${baseline.total ?? "?"}）／判据 D 合计 ${ruleGrandTotal}（基线 ${baseline.ruleLiteralsTotal ?? "?"}）${downCount ? `，${downCount} 个文件下降可 --update` : ""}`);
for (const im of [...improvements, ...ruleImprovements].slice(0, 5)) console.log(`  ↓ ${im}`);
process.exit(0);
