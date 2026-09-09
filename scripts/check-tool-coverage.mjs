// check-tool-coverage.mjs — 0.5.9 工具覆盖门禁（K-01/K-06 依据，仿官方 verify-tool-catalog）：
// 官方 tool-catalog（生成器产物=权威全集）中的每个工具名都必须在分类表/前缀规则内被识别，
// 任何一个 unknown = 该工具调用会被未知工具首调处置（ask/deny）→ 工程失败。
// 0.6.0（02 B2′ 裁决 v1.4，2026-09-04 第三方裁示+用户确认）：
//   - 素材来源优先级：--catalog <path> → CHECK_TOOL_CATALOG 环境变量 → 均缺 = FAIL（诊断含获取方式，禁 ENOENT 死路径）；
//   - --skip-catalog 显式出口：输出 WARNING 并计入汇总（发布流水线永远不传该参数）；
//   - 素材版本须与本机 DSH 版本对齐（不一致 WARNING 不 FAIL）；
//   - 校验逻辑与判据不变（官方全集 ⊆ 分类表，任一 unknown 即红）。
// 用法：node scripts/check-tool-coverage.mjs [--catalog <path>] [--skip-catalog]
import { readFileSync } from "node:fs";
import { toolClass } from "../lib/core/tool-catalog.js";

function argVal(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const SKIP_CATALOG = process.argv.includes("--skip-catalog");
const CATALOG = argVal("--catalog") || process.env.CHECK_TOOL_CATALOG || null;

if (!CATALOG) {
  if (SKIP_CATALOG) {
    console.warn("WARNING：--skip-catalog 已传——工具箱覆盖层跳过（素材缺失；发布流水线禁止此参数）");
    process.exit(0);
  }
  console.error("TOOL-CATALOG-MISSING：未指定官方 tool-catalog.txt——请用 --catalog <path> 或环境变量 CHECK_TOOL_CATALOG 指定（官方文档产物可从 DSH 官方文档仓库 docs-site-text 获取）；FAIL，禁止静默跳过");
  if (process.env.LOCAL_CATALOG_HINT) {
    console.error(`（本机提示：${process.env.LOCAL_CATALOG_HINT}）`);
  }
  process.exit(1);
}

function parseNames() {
  const names = new Set();
  for (const line of readFileSync(CATALOG, "utf8").split("\n")) {
    if (!line.includes("@deepseek-ai/dsh-")) continue;
    const cols = line.split("|").map((c) => c.trim());
    // 表列格式：| | <package> | <model-visible names> | <requires> | <writes> | <shipped aliases> | <note> |
    if (!cols[2] || !cols[2].startsWith("@deepseek-ai")) continue;
    const add = (s) => {
      if (!s || s === "-") return;
      // 分隔符：英文文档用逗号「,」，中文文档用顿号「、」（0.6.3 修复：曾只按逗号分割，
      // 致中文素材的多工具名整串被丢弃——59 个工具名只剩 11 个，且仍打印 COVERAGE-OK 的静默弱化）
      for (const x of s.split(/[,、，]/)) {
        const n = x.trim();
        if (/^[A-Za-z_][A-Za-z0-9_:.-]*$/.test(n)) names.add(n);
      }
    };
    add(cols[3]);
    add(cols[6]);
  }
  return names;
}

const official = parseNames();
const missing = [];
for (const n of official) {
  if (toolClass(n, {}) === "unknown") missing.push(n);
}

if (missing.length) {
  console.error(`COVERAGE-FAIL：官方 tool-catalog 有 ${missing.length} 个工具未分类（会被未知工具首调处置）：`);
  for (const n of missing) console.error("  - " + n);
  process.exit(1);
}
console.log(`COVERAGE-OK：官方 tool-catalog 工具全覆盖（${official.size} 个工具名均被分类表/前缀规则识别）`);
