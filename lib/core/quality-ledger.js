// quality-ledger.js - 质量账本（机制进发布面，数据留本机，签名不外泄）
//
// 设计原则（第三批方案 §一）：
//   · 机制层（本文件，随包发布）：taskSignature / recordQuality / qualityTrend —— 每个安装者可用；
//   · 数据层（~/.dsh/quality-ledger.jsonl，**永不发布**）：每单一条记录；
//   · 配置层（rule-engine.json 的 qualityLedger 键，默认 enabled:false）：不开不产生任何文件；
//   · 隐私：落盘的是 sha256 归一化指纹（12 位），**单向不可逆**——看到 jsonl 也只知道
//     "有个指纹的任务做过"，不知道任务内容。
//
// 不做的事：不拦截、不评分、不上传（纯旁路统计）。
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 默认配置（可被 rule-engine.json 的 qualityLedger 覆盖） */
export const DEFAULT_LEDGER_CONFIG = {
  enabled: false,   // 默认关——不开不产生任何文件
  window: 5,        // 趋势窗口（最近 N 单 vs 之前 N 单）
  z: 1.96          // 预留：二期 Wilson 区间用
};

/** 账本文件路径（本机数据，永不发布） */
export function ledgerPath(home) {
  const base = home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(base, "quality-ledger.jsonl");
}

/**
 * 任务签名：对 purpose + 验收断言做**归一化**后取 sha256 前 12 位。
 * 归一化规则（公开可审计）：去引号 → 绝对路径替换为 <path> → 数字替换为 <n> → 折叠空白 → 小写。
 * 目的：同一类任务（措辞/数字/路径不同）得到同一签名，从而能统计"同类任务返工率"。
 */
export function taskSignature(purpose, assertions = []) {
  const parts = [String(purpose || ""), ...(Array.isArray(assertions) ? assertions : [assertions])];
  const norm = parts
    .join("\n")
    .replace(/["'`「」『』]/g, "")
    .replace(/[A-Za-z]:[\\/][^\s,;)]*/g, "<path>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 12);
}

/**
 * 记录一单的质量指标（旁路统计；失败静默——账本不能影响主流程）。
 * @param {object} entry - { purpose, assertions, rework, interventions, frictions, tokens, ts }
 * @param {object} opts  - { config, home, now }
 * @returns {{ok: boolean, skipped?: string, path?: string}}
 */
export function recordQuality(entry = {}, opts = {}) {
  try {
    const cfg = { ...DEFAULT_LEDGER_CONFIG, ...(opts.config || {}) };
    if (!cfg.enabled) return { ok: false, skipped: "disabled" }; // 默认关：不落盘
    const purpose = entry.purpose ?? entry.task ?? "";
    if (!purpose) return { ok: false, skipped: "no-purpose" };
    const rec = {
      sig: taskSignature(purpose, entry.assertions || []),
      ts: typeof entry.ts === "number" ? entry.ts : (opts.now ?? Date.now()),
      rework: Number(entry.rework) || 0,
      interventions: Number(entry.interventions) || 0,
      frictions: Number(entry.frictions) || 0,
      tokens: Number(entry.tokens) || 0
    };
    const file = ledgerPath(opts.home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, skipped: `error:${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 读取账本（坏行跳过；返回按时间升序的记录数组） */
export function loadLedger(opts = {}) {
  const file = ledgerPath(opts.home);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec.sig === "string") out.push(rec);
    } catch {
      // 坏行跳过（账本是旁路数据，不能因一行损坏而失效）
    }
  }
  return out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

/** 指标方向：后窗 vs 前窗的均值比较（值越小越好） */
function direction(before, after) {
  if (before === after) return "持平";
  return after < before ? "改善" : "恶化";
}

/**
 * 质量趋势：按签名取最近 window 单 vs 之前 window 单，输出各指标方向 + 明细。
 * @returns {{sig, count, window, recent, previous, metrics, summary}}
 */
export function qualityTrend(signature, opts = {}) {
  const cfg = { ...DEFAULT_LEDGER_CONFIG, ...(opts.config || {}) };
  const w = Math.max(1, Number(opts.window ?? cfg.window) || 5);
  const rows = loadLedger(opts).filter((r) => r.sig === signature);
  const recent = rows.slice(-w);
  const previous = rows.slice(-2 * w, -w);
  const avg = (list, key) => (list.length === 0 ? 0 : list.reduce((a, r) => a + (Number(r[key]) || 0), 0) / list.length);
  const metrics = {};
  for (const key of ["rework", "interventions", "frictions", "tokens"]) {
    const b = avg(previous, key);
    const a = avg(recent, key);
    metrics[key] = { before: Number(b.toFixed(2)), after: Number(a.toFixed(2)), direction: direction(b, a) };
  }
  const worst = Object.entries(metrics).filter(([, m]) => m.direction === "恶化").map(([k]) => k);
  const summary = rows.length < 2
    ? `样本不足（${rows.length} 单）——至少 2 单才能比较`
    : worst.length === 0
      ? `方向：持平或改善（近 ${recent.length} 单 vs 前 ${previous.length} 单）`
      : `方向：${worst.join("、")} 恶化（近 ${recent.length} 单 vs 前 ${previous.length} 单）`;
  return { sig: signature, count: rows.length, window: w, recent, previous, metrics, summary };
}
