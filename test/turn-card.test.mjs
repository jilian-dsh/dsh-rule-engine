// turn-card.test.mjs - 回合末裁决摘要（0.5.15）
import assert from "node:assert/strict";
import { buildTurnCard, cardKey } from "../lib/core/turn-card.js";

// 空回合
{
  const card = buildTurnCard({ number: 3, userText: "你好", cardHits: [] });
  assert.equal(card.verdict, "clear", "无拦截 → clear");
  assert.equal(card.blocks.length, 0, "空 blocks");
  assert.equal(card.turn, 3);
  assert.ok(card.after.includes("无裁决"), "after 文案");
}
// 单 hit
{
  const card = buildTurnCard({
    number: 5,
    userText: "推送到 GitHub",
    cardHits: [{ tool: "pwsh", args: "git push ...", ruleId: "22", title: "沟通直接性", reason: "【硬拦截】用户消息是询问…（规则 22）", errId: "AB123" }]
  });
  assert.equal(card.verdict, "denied", "有拦截 → denied");
  assert.equal(card.blocks.length, 1);
  assert.equal(card.blocks[0].ruleId, "22");
  assert.equal(card.blocks[0].errId, "AB123");
  assert.ok(card.after.includes("1 次调用被拦"), "after 计数");
}
// 多 hit + 截断
{
  const card = buildTurnCard({
    number: 7,
    userText: "x",
    cardHits: [
      { tool: "write", args: "very long ".repeat(40), ruleId: "12A", title: "执行前确认", reason: "r1" },
      { tool: "edit", args: "a", ruleId: "13A", title: "备份", reason: "r2", errId: "CD456" }
    ]
  });
  assert.equal(card.blocks.length, 2, "两块");
  assert.equal(card.blocks[1].errId, "CD456");
  assert.ok(card.blocks[0].args.length <= 80, "args 截断");
  assert.ok(card.after.includes("12A、13A"), "规则列表");
}
// cardKey 稳定/区分
assert.equal(cardKey(buildTurnCard({ number: 1, userText: "a", cardHits: [] })), "t1@0@a", "key 稳定");
assert.notEqual(
  cardKey(buildTurnCard({ number: 1, userText: "aaaa", cardHits: [] })),
  cardKey(buildTurnCard({ number: 1, userText: "bbbb", cardHits: [] })),
  "不同用户文本 → 不同 key"
);

console.log("turn-card.test.js PASS");
