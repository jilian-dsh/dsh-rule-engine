// scope-config.test.mjs — 域 2 第四枪（2026-09-22）：DELEGATION_MARKER_RE／SESSION_WIDE_RE 迁配置层
//   ① LEGACY ＝迁移前现盘两串逐字快照（硬编码，独立于当前实现，作对照物）；
//   ② 夹具与 LEGACY 逐字一致（防夹具漂移）；
//   ③ 行为锁：仅会话内说明→false；全部推进项／本会话→true；任务书→委托 true；短消息／缺框架词→false；
//   ④ 两键还原（空＝还原内置）后中文不再命中；自重置。
// 注：任务书样本自 phase1c-safechannel.test.mjs 原文复制——本文件**不 import** 该测试文件。
import assert from "node:assert/strict";
import {
  isDelegationText,
  isSessionWideAskText,
  setDelegationMarker,
  setSessionWide
} from "../lib/core/authorization.js";
import { TEST_DELEGATION_MARKER_ZH, TEST_SESSION_WIDE_ZH, useChineseScopeMarkers } from "./helpers.mjs";

// ── ① 迁移前基线（现盘逐字快照）──
const LEGACY_MARKER = "任务|只允许|仅限|受限于|范围内|目录下|依次执行|执行以下|步骤";
const LEGACY_SESSION =
  "全部|本会话|本次会话|整个会话|当前会话|会话内所有|会话内全部|所有后续|剩余所有|所有操作|整个profile|整个工作区|全部推进项|全部操作";

// ── ② 夹具与基线逐字一致 ──
assert.equal(TEST_DELEGATION_MARKER_ZH, LEGACY_MARKER, "夹具 delegationMarker 应与现盘基线逐字一致");
assert.equal(TEST_SESSION_WIDE_ZH, LEGACY_SESSION, "夹具 sessionWide 应与现盘基线逐字一致");

// ── ③ 配置层生效（自注入）──
useChineseScopeMarkers();

assert.equal(isSessionWideAskText("仅会话内说明"), false, "“仅会话内说明”不算会话级范围");
assert.equal(isSessionWideAskText("全部推进项"), true, "“全部推进项”算会话级范围");
assert.equal(isSessionWideAskText("本会话"), true, "“本会话”算会话级范围");

// 委托任务书（样本逐字自 phase1c-safechannel.test.mjs L30–43 复制；本文件不 import 该文件）
const DELEGATION_TEXT = `你是 R2④ 委托最小 scope 实测的执行代理。任务：在 Windows 的 D:\\example workspace\\dsh-project\\reports\\d3-probe\\ 目录下依次执行三步，每步之后如实报告结果。

步骤：
1. 用 PowerShell 创建目录和文件：New-Item -ItemType Directory -Force "D:\\example workspace\\dsh-project\\reports\\d3-probe"，然后 Set-Content "D:\\example workspace\\dsh-project\\reports\\d3-probe\\probe.txt" "probe"。
2. 用 read 工具读取 D:\\example workspace\\dsh-project\\reports\\d3-probe\\probe.txt。
3. 用 PowerShell 删除该文件：Remove-Item "D:\\example workspace\\dsh-project\\reports\\d3-probe\\probe.txt" -Force。

严格规则：
- 只允许操作 D:\\example workspace\\dsh-project\\reports\\d3-probe 路径下的内容，绝对不碰其他任何文件。
- 每一步报告格式：步骤N 工具名=xxx 结果=成功/失败/被拦截 原因=原样引用拦截提示（若被拦截）。
- 如果任何调用被拒绝/拦截/弹审批，不要重试、不要换命令绕过，原样报告拦截原因后停止该步骤，继续下一步。
- 最后总结一句：哪些调用被放行、哪些被拦截。

注意：你可能没有 PowerShell 执行权限或被安全机制拦截，这都属于测试数据，如实报告即可。不要额外做任何事。`;

assert.equal(isDelegationText(DELEGATION_TEXT), true, "实测任务书 → 委托文本");
assert.equal(isDelegationText("修改 D:/a.txt 并删除 D:/b.txt"), false, "短消息不误判");
assert.equal(isDelegationText("1. 查看 D:/a.txt\n2. 汇报结果"), false, "步骤枚举但缺乏委托框架词/长度 → 不误判");

// ── ④ 两键还原（空＝还原内置）后中文不再命中：证明中文源确由配置层承接 ──
setDelegationMarker("");
setSessionWide("");
assert.equal(isSessionWideAskText("本会话"), false, "还原内置后中文「本会话」不命中");
assert.equal(isDelegationText(DELEGATION_TEXT), false, "还原内置后中文任务书不命中");

// 自重置（供后续测试／单独运行；run-all 循环亦会重申各夹具）
setDelegationMarker("", { clear: true });
setSessionWide("", { clear: true });

console.log("scope-config.test.mjs PASS");
