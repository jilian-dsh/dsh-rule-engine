// inject-config.test.mjs — 域 3 第二枪（2026-09-22）：index.js L366 INJECT_COMMAND_RE 迁 injectCommand
//   ① LEGACY ＝json 逐字快照；② 夹具与 LEGACY 逐字一致；
//   ③ 行为锁：请直接执行／请立即／不要再→true；现盘四条陈述式→false；历史坏文案→true；
//   ④ 还原内置后中文「请直接执行」不命中、英文 please execute directly 命中；自重置。
// 注：本文件**不 import** index.js（其启动注入会清 override），**不 import** realcase-regression.test.mjs。
import assert from "node:assert/strict";
import { isInjectCommandText, setInjectCommand } from "../lib/core/text-detect.js";
import { TEST_INJECT_COMMAND_ZH, useChineseInjectCommand } from "./helpers.mjs";

// ── ① 迁移前基线（现盘逐字快照）──
const LEGACY = "请直接执行|请立即|不要再|勿再|请马上|现在就做|立刻执行|直接执行";

// ── ② 夹具与基线逐字一致 ──
assert.equal(TEST_INJECT_COMMAND_ZH, LEGACY, "夹具 injectCommand 应与现盘基线逐字一致");

// ── ③ 配置层生效（自注入）＋ 行为锁 ──
useChineseInjectCommand();
for (const t of ["请直接执行", "请立即", "不要再"]) {
  assert.equal(isInjectCommandText(t), true, `${t} → 命中（命令式）`);
}

// 现盘四条陈述式（与 realcase 场景④ 同源）——迁后仍须全部为 false
const statementTexts = [
  "规则 19/M8：手册/AGENTS 落盘后应在同一回合补 engram_store，否则记忆机制断链（已记审计）",
  "规则 27：全量审计未通过，先移除多余挂载再重跑审计",
  "规则 23④：完成/通过类声明需同会话近期验证记录（测试全绿或冷加载 PASS），缺失已记审计",
  "__ask-throttle（规则 __ask-throttle）：本会话已存在相近授权记录或被拒记录；再次弹窗询问可能无法送达用户。可用普通文本说明。"
];
for (const t of statementTexts) {
  assert.equal(isInjectCommandText(t), false, `陈述式不应命中："${t.slice(0, 30)}…"`);
}

const badHistorical = "已有授权或询问被拒时请直接执行、或用普通文本说明，不要再弹窗 ask。";
assert.equal(isInjectCommandText(badHistorical), true, "历史坏文案须被识别（回潮即红）");

// ── ④ 还原内置（空＝还原）后：中文不命中、英文命中 ──
setInjectCommand("");
assert.equal(isInjectCommandText("请直接执行"), false, "还原内置后中文「请直接执行」不命中");
assert.equal(isInjectCommandText("please execute directly"), true, "还原内置后英文 please execute directly 命中");

// 自重置（供后续测试／单独运行；run-all 循环亦会重申各夹具）
setInjectCommand("", { clear: true });

console.log("inject-config.test.mjs PASS");
