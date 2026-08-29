// baseline.js - 需求基线覆盖核查（2026-08-24 最小第一步）
// 用途：交付/方案完成类声明时，核对需求基线（rule-engine-baseline.json）中是否仍有
// planned 未落地需求；缺失/损坏按 fail-closed 处理（审计提示，绝不静默）。
import { readFileSync } from "node:fs";
import { baselineFilePath } from "./paths.js";

/** 完成类声明的触发词（独立于规则 23④ 的通用完成正则，避免日常“完成”二字误报） */
export const BASELINE_COMPLETE_RE =
  /方案完成|重构完成|全部完成|整体完成|任务全部完成|彻底完成|收尾完成|全部落地|机制完成/;

/**
 * 纯函数判定：完成声明 ∧ 存在 planned 需求 → gap；否则 null。
 * @param {string} text 声明文本
 * @param {Array<{id: string, title?: string, status: string}>} items 基线需求
 * @returns {{count: number, pending: string[]} | null}
 */
export function computeBaselineGap(text, items) {
  if (!text || !BASELINE_COMPLETE_RE.test(text)) return null;
  if (!Array.isArray(items) || items.length === 0) return null;
  const pending = items
    .filter((i) => i && i.status === "planned")
    .map((i) => `${i.id}:${i.title || ""}`);
  if (pending.length === 0) return null;
  return { count: pending.length, pending };
}

/**
 * 加载需求基线文件。缺失/损坏 → { ok:false }（调用方据此审计，不做静默判定）。
 */
export function loadBaselineFile(filePath = baselineFilePath()) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    const items = Array.isArray(data && data.requirements) ? data.requirements : [];
    return { ok: true, items, raw: data };
  } catch (error) {
    return {
      ok: false,
      items: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}