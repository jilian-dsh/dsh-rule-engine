// dualtrack-markers.js - 本机标识词表的**唯一加载器**（B2 扫描器与 dualtrack-check 共用）
//
// 设计（第三批第 1 批 · 词表配置化，用户拍板 2026-09-09）：
//   词表是**发布者私有数据**——「我这台机器长什么样」对别人毫无意义，因此：
//     ① 优先读本机 rule-engine.json 的 `dualtrack.markers`（字符串数组）；
//     ② 其次读环境变量 DUALTRACK_MARKERS 指向的文件（每行一个，`#` 注释）；
//     ③ 最后回退包内 scripts/local-residue-markers.txt（**示例**，发布者应换成本机配置）。
//   包内那份在公开仓库里只保留示例行，避免把发布者的用户名/路径公开出去。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 解析 DSH_HOME（与 dsh-home-paths 口径一致） */
export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function readMarkerFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  return lines.length > 0 ? lines : null;
}

/**
 * 加载本机标识词表。
 * @param {object} opts
 * @param {string} opts.root 仓库根（回退示例文件所在）
 * @param {object} [opts.config] 已加载的 rule-engine.json 内容（可选；缺省自行读取）
 * @returns {{markers: string[], source: string}}
 */
export function loadMarkers(opts = {}) {
  const root = opts.root || process.cwd();

  // ① 本机配置：rule-engine.json 的 dualtrack.markers
  let cfg = opts.config;
  if (cfg === undefined) {
    try {
      const p = path.join(resolveDshHome(), "rule-engine.json");
      cfg = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
    } catch {
      cfg = null;
    }
  }
  const fromCfg = cfg?.dualtrack?.markers;
  if (Array.isArray(fromCfg)) {
    const markers = fromCfg.filter((x) => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
    if (markers.length > 0) return { markers, source: "rule-engine.json:dualtrack.markers" };
  }

  // ② 环境变量指向的本机文件
  const fromEnv = readMarkerFile(process.env.DUALTRACK_MARKERS);
  if (fromEnv) return { markers: fromEnv, source: `env DUALTRACK_MARKERS=${process.env.DUALTRACK_MARKERS}` };

  // ③ 包内示例文件（发布者应换成本机配置；此处可能只有注释示例）
  const fallback = readMarkerFile(path.join(root, "scripts", "local-residue-markers.txt"));
  if (fallback) return { markers: fallback, source: "scripts/local-residue-markers.txt (in-package example)" };

  return { markers: [], source: "empty" };
}
