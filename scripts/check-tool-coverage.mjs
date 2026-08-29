// check-tool-coverage.mjs — 0.5.9 工具覆盖门禁（K-01/K-06 依据，仿官方 verify-tool-catalog）：
// 官方 tool-catalog（生成器产物=权威全集）中的每个工具名都必须在分类表/前缀规则内被识别，
// 任何一个 unknown = 该工具调用会被未知工具首调处置（ask/deny）→ 工程失败。
// 用法：node scripts/check-tool-coverage.mjs
import { readFileSync } from "node:fs";
import { toolClass } from "../lib/core/tool-catalog.js";

const CATALOG = "D:\\example workspace\\dsh-project\\docs-site-text\\en\\reference\\tool-catalog.txt";

function parseNames() {
  const names = new Set();
  for (const line of readFileSync(CATALOG, "utf8").split("\n")) {
    if (!line.includes("@deepseek-ai/dsh-")) continue;
    const cols = line.split("|").map((c) => c.trim());
    // 表列格式：| | <package> | <model-visible names> | <requires> | <writes> | <shipped aliases> | <note> |
    if (!cols[2] || !cols[2].startsWith("@deepseek-ai")) continue;
    const add = (s) => {
      if (!s || s === "-") return;
      for (const x of s.split(",")) {
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
