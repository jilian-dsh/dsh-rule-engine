// turn-card.js - 回合末裁决摘要（0.5.15 回合末裁决卡片的 host 半）。
// 输入回合状态（turn），输出给 client 卡片的摘要 JSON。
// 纯函数可独立测试；不 import 官方包。
// 数据源：turn.cardHits（index.js 在 guardDecision 命中时缓冲）——本文件只做聚合与格式化。
// 字段约定：
//   card.verdict = "denied" | "clear"（引擎裁决语义，只读）
//   card.label   = "correct" | "incorrect" | null（用户判例，rateTurnCardHost 写入；展示层据此显示 ✅/❌）

/** 摘要一个工具调用（命令/路径截断，替白空格） */
function summarizeArg(s) {
  return String(s || "").replace(/\s+/g, " ").slice(0, 80);
}

/** 卡片稳定键（client 判例登记定位用：回合号×块数×用户文本片段） */
export function cardKey(card) {
  if (!card) return "";
  return `t${card.turn}@${(card.blocks || []).length}@${String(card.userText || "").slice(0, 16)}`;
}

/**
 * 构建回合裁决摘要。
 * @param {object} turn 回合状态（freshTurn 产物；cardHits 由 index.js 写入）
 * @returns {{turn:number, userText:string, verdict:string, blocks:Array, after:string, key:string, label:null}}
 */
export function buildTurnCard(turn) {
  const hits = Array.isArray(turn?.cardHits) ? turn.cardHits : [];
  const blocks = hits.map((h, i) => ({
    i,
    tool: String(h?.tool || ""),
    args: summarizeArg(h?.args),
    ruleId: String(h?.ruleId || ""),
    title: String(h?.title || ""),
    reason: String(h?.reason || "").slice(0, 160),
    errId: String(h?.errId || "")
  }));
  const rules = [...new Set(blocks.map((b) => b.ruleId).filter(Boolean))];
  const card = {
    turn: Number(turn?.number || 0),
    userText: String(turn?.userText || "").slice(0, 200),
    verdict: blocks.length > 0 ? "denied" : "clear",
    blocks,
    after: blocks.length > 0
      ? `本回合 ${blocks.length} 次调用被拦（规则 ${rules.join("、")}）——已改为请示/修正而非继续执行`
      : "本回合无裁决事件",
    label: null
  };
  card.key = cardKey(card);
  return card;
}
