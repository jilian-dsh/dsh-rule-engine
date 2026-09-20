// semantic.js - 投递资格语义层（v0.5.7，用户拍板 2026-08-26）。
// 原则：只有"错误的行为"才值得被提醒（D 级无法硬拦，提醒是唯一执行手段）。
// 本文件只放纯函数，不做 LLM——"是否错误"的裁决在 judge.js；
// 这里的职责是：① 注入轮不检测判定（乒乓根治）；② 投递资格闸（提醒一次并记住 + 会话每小时预算）。

/** 会话弹窗预算：每小时最多 3 条注入（跨全部规则，含聚合）。 */
export const INJECT_BUDGET_PER_HOUR = 3;

/**
 * 第 0 站（检测前传）：只有"真实用户在场"的回合才做违规检测与投递。
 * 真实用户在场 = 本回合 user/message 来源为 user，或 ask_user_question 获得用户答复。
 * 引擎注入触发的回合（source=plugin / 依赖注入出的无用户消息轮）不检测——
 * 那些回合的"回复-检测-再注入"正是乒乓循环的燃料（实测 2026-08-26 12:37 六圈）。
 */
export function shouldDetectTurn({ realUserSeen }) {
  return realUserSeen === true;
}

/**
 * 投递资格闸：决定这条注入该不该"进对话"（无论结果如何都会写审计）。
 * 规则：① 同规则同会话仅投递一次（__self-cert 聚合除外）；
 *      ② 会话每小时至多 INJECT_BUDGET_PER_HOUR 条（超出只审计不投递）。
 * 两者同时满足才投递；被拦的违规全部留在 /guard log 审计（inject-skip）。
 * @param {object} p
 * @param {number} p.now           当前时间戳
 * @param {string} p.ruleId        规则 id（__self-cert 不做每规则去重）
 * @param {number|null} p.firstAt  该规则在本会话首次投递时间（null=从未投递）
 * @param {number[]} p.budgetTimes 本会话投递时间戳列表（用于预算窗口统计）
 * @returns {{ok:true}|{ok:false, reason:"dedup"|"budget"}}
 */
export function shouldDeliver({ now, ruleId, firstAt, budgetTimes }) {
  // 机制类注入（`__` 前缀：__engram-gap / __version-guard / __self-cert 聚合等）是事件驱动、
  // 低频且重要，不做"每规则一次"去重（总量由下面的每小时预算约束）；只有真实规则 id 才"提醒一次并记住"。
  const isMechanism = String(ruleId || "").startsWith("__");
  if (!isMechanism && firstAt != null) {
    return { ok: false, reason: "dedup" };
  }
  const recent = (budgetTimes || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= INJECT_BUDGET_PER_HOUR) {
    return { ok: false, reason: "budget" };
  }
  return { ok: true };
}
