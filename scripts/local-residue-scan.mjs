#!/usr/bin/env node
// local-residue-scan.mjs — 发布物本机痕迹扫描（仅扫 lib/；无 --pack 模式）
// 用法：node scripts/local-residue-scan.mjs   （在包根目录运行；exit 0 = 干净，exit 1 = 有命中）

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 词表唯一源（2026-09-09 起配置化）：本机 rule-engine.json 的 dualtrack.markers 优先，
// 其次 DUALTRACK_MARKERS 环境变量，最后回退包内示例文件——见 lib/core/dualtrack-markers.js。
// 理由：词表是**发布者私有数据**，不应随公开仓库/包分发。
import { loadMarkers } from "../lib/core/dualtrack-markers.js";
const { markers: MARKERS, source: MARKERS_SOURCE } = loadMarkers({ root });
if (MARKERS.length === 0) {
  console.error("REFUSED: 本机标识词表为空——请在 rule-engine.json 配置 dualtrack.markers，或设置 DUALTRACK_MARKERS 环境变量");
  process.exit(1);
}
// 注意：不扫 package.json（作者署名/仓库地址为合法项，A6 口径见其节）；tool-catalog.js 的
// dev_/esr_/engram_ 前缀规则按阶段 A「关键裁决 3」保留，静态枚举列 0.6.x 跟进。

const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml"]);
function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) { if (e !== "node_modules" && e !== ".git") yield* walk(p); }
    else if (TEXT_EXT.has(extname(e))) yield p;
  }
}

let hits = 0;
for (const file of walk(join(root, "lib"))) {
  const text = readFileSync(file, "utf8");
  for (const m of MARKERS) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (line.includes(m)) { console.log(`HIT  ${file}:${i + 1}  [${m}]  ${line.trim()}`); hits++; }
    });
  }
}

if (hits) { console.error(`\nRESIDUE SCAN FAILED（${hits} 处本机痕迹）`); process.exit(1); }
console.log("RESIDUE SCAN OK（发布面零本机痕迹）");
