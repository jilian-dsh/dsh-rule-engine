// turn-card-verdict.test.mjs - 回合末卡片判例登记链路（0.5.15）
// 覆盖：buildTurnCard 字段约定 / cardKey / rateTurnCardHost 的 correct/incorrect/
// 冲突拒绝/指纹放行/审计留痕（自设临时 DSH_HOME，隔离审计与指纹台账写入）。
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

// 测试隔离（踩坑 103 惯例）：先设 DSH_HOME 再 import 所有读它的模块
process.env.DSH_HOME = join(mkdtempSync(join(tmpdir(), "dsh-rule-engine-turncard-")));
process.env.DSH_WORKSPACE = process.cwd();

const { buildTurnCard, cardKey } = await import("../lib/core/turn-card.js");
const { rateTurnCardHost } = await import("../lib/service.js");
const { state: runtimeState } = await import("../lib/core/runtime.js");

// ── buildTurnCard 最小构建（不含 service 依赖；先测纯函数契约）──
const turn = {
  number: 8,
  userText: "解析规则文件",
  cardHits: [
    { tool: "pwsh", args: '{"command":"Get-Content AGENTS.md"}', ruleId: "22", title: "沟通直接性", reason: "【硬拦截】用户消息是询问…", errId: "X112" },
    { tool: "write", args: "D:\\tmp\\a.json", ruleId: "12A", title: "执行前确认", reason: "未授权", errId: "X113" }
  ]
};
{
  const card = buildTurnCard(turn);
  assert.equal(card.verdict, "denied");
  assert.equal(card.blocks.length, 2);
  assert.equal(card.label, null, "初始无判例");
  assert.ok(card.key, "key 存在");
  assert.equal(card.key, cardKey(card), "key 与 cardKey 一致");
  assert.equal(card.key, "t8@2@解析规则文件", "key 稳定：回合×块数×文本片段");
}
// clear 回合
{
  const card = buildTurnCard({ number: 9, userText: "你好", cardHits: [] });
  assert.equal(card.verdict, "clear");
  assert.equal(card.key, "t9@0@你好");
}
// 无 cardHits 容错
{
  const card = buildTurnCard({ number: 1 });
  assert.equal(card.verdict, "clear");
  assert.equal(card.blocks.length, 0);
}

// ── rateTurnCardHost（真实 runtime state：cardByMessage/labelRows 均为运行时态字段）──
runtimeState.cardByMessage = new Map([
  ["msg-1", { ...buildTurnCard(turn), messageId: "msg-1", sessionId: "sess-1" }],
  ["msg-clear", { ...buildTurnCard({ number: 10, userText: "x", cardHits: [] }), messageId: "msg-clear", sessionId: "sess-1" }]
]);
runtimeState.labelRows = [];

// 未找到卡片
{
  const r = rateTurnCardHost("nope", "incorrect", "none", 0);
  assert.equal(r.ok, false, "无卡片 → 拒绝");
}
// blockIndex 越界
{
  const r = rateTurnCardHost("msg-1", "incorrect", "none", 99);
  assert.equal(r.ok, false, "裁决块 #99 不存在 → 拒绝");
}
// 合法登记 block #0（非破坏类命令 → 指纹放行 + 审计；只影响该 block）
{
  const r = rateTurnCardHost("msg-1", "incorrect", "none", 0);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, "incorrect");
  assert.equal(r.blockIndex, 0, "返回登记索引");
  const blocks = runtimeState.cardByMessage.get("msg-1").blocks;
  assert.equal(blocks[0].label, "incorrect", "block#0 登记 incorrect");
  assert.ok(runtimeState.labelRows.length >= 1, "incorrect 应写指纹台账");
}
// block 独立性：block #1 未登记，仍可打标（多次裁决各自判定）
{
  const r2 = rateTurnCardHost("msg-1", "correct", "none", 1);
  assert.equal(r2.ok, true, "block#1 独立可登记");
  const blocks = runtimeState.cardByMessage.get("msg-1").blocks;
  assert.equal(blocks[0].label, "incorrect", "block#0 保持 incorrect");
  assert.equal(blocks[1].label, "correct", "block#1 登记 correct");
}
// 一次性语义（per-block）：block#0 已登记后改判 → 拒绝；block#1 亦然
{
  const r = rateTurnCardHost("msg-1", "correct", "incorrect", 0);
  assert.equal(r.ok, false, "block#0 已登记后改判 → 拒绝（一次性）");
  assert.ok(String(r.error || "").includes("已登记"), "拒绝原因含'已登记'");
  const blocks = runtimeState.cardByMessage.get("msg-1").blocks;
  assert.equal(blocks[0].label, "incorrect", "block#0 label 保持");
  assert.equal(blocks[1].label, "correct", "block#1 label 保持");
}
// 幂等（同一块同状态重复 → already）
{
  const r = rateTurnCardHost("msg-1", "incorrect", "incorrect", 0);
  assert.equal(r.ok, true);
  assert.equal(r.already, true, "同状态重复提交 → already");
}
// 破坏类命令永不写指纹（安全规格：git push 不在放行面）
{
  const dangerousTurn = {
    number: 11,
    userText: "推送",
    cardHits: [{ tool: "pwsh", args: '{"command":"git push origin main"}', ruleId: "22", title: "x", reason: "r", errId: "D111" }]
  };
  const dCard = { ...buildTurnCard(dangerousTurn), messageId: "msg-d", sessionId: "sess-1" };
  runtimeState.cardByMessage.set("msg-d", dCard);
  const before = runtimeState.labelRows.length;
  const r2 = rateTurnCardHost("msg-d", "incorrect", "none", 0);
  assert.equal(r2.ok, true);
  assert.equal(runtimeState.labelRows.length, before, "破坏类命令（git push）不计指纹");
}
// legacy 兼容：blockIndex 缺省（-1）= 卡片级打标（不回退，旧调用仍可用）
{
  const legacyTurn = {
    number: 12,
    userText: "旧调用",
    cardHits: [{ tool: "write", args: "x", ruleId: "22", title: "x", reason: "r", errId: "L001" }]
  };
  const lCard = { ...buildTurnCard(legacyTurn), messageId: "msg-l", sessionId: "sess-1" };
  runtimeState.cardByMessage.set("msg-l", lCard);
  const r = rateTurnCardHost("msg-l", "incorrect", "none");
  assert.equal(r.ok, true, "legacy（无 blockIndex）仍可用");
  assert.equal(runtimeState.cardByMessage.get("msg-l").label, "incorrect", "legacy 写卡片级 label");
}
// clear 卡片（无 blocks）不可打标
{
  const r = rateTurnCardHost("msg-clear", "incorrect", "none", 0);
  assert.equal(r.ok, false, "clear 卡片（无裁决块）→ 拒绝");
}
// 非法 verdict
{
  const r = rateTurnCardHost("msg-1", "maybe", "none", 0);
  assert.equal(r.ok, false, "非法 verdict → 拒绝");
}

// ── 持久化（2026-09-02：判例=教学数据，重启不丢）──
import { loadTurnCardsFromDisk, saveTurnCardsToDisk, TURN_CARDS_MAX } from "../lib/core/state.js";
import { turnCardsFilePath } from "../lib/core/paths.js";
{
  // 保存 → 重新加载 → 卡片与判例恢复
  saveTurnCardsToDisk(runtimeState);
  const reloaded = loadTurnCardsFromDisk();
  assert.ok(reloaded.has("msg-1"), "恢复 msg-1 卡片");
  const card = reloaded.get("msg-1");
  assert.equal(card.blocks[0].label, "incorrect", "恢复 block#0 判例 incorrect");
  assert.equal(card.blocks[1].label, "correct", "恢复 block#1 判例 correct");
  // 磁盘文件存在
  const fs = await import("node:fs");
  assert.ok(fs.existsSync(turnCardsFilePath()), "卡片文件已落盘");
}
// 损坏文件容错：加载返回空 Map 不崩
{
  const fs = await import("node:fs");
  const p = turnCardsFilePath();
  const orig = fs.readFileSync(p, "utf8");
  fs.writeFileSync(p, "{not json", "utf8");
  const m = loadTurnCardsFromDisk();
  assert.equal(m.size, 0, "损坏文件 → 空 Map（不崩）");
  fs.writeFileSync(p, orig, "utf8");
}

console.log("turn-card-verdict.test.mjs PASS");
