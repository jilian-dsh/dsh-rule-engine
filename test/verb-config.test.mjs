// verb-config.test.mjs — 域 2 第三枪（2026-09-22）：动作词表（VERB_TYPE_RE／VERB_RE）迁配置层
//   ① LEGACY ＝迁移前现盘六条 ＋ verbRe 逐字快照（硬编码，独立于当前实现，作对照物）；
//   ② 夹具与 LEGACY 逐字一致（防夹具漂移）；
//   ③ 等价锁：R6④ 精确配对（不得笛卡尔积）、执行吧→any、清理→delete；
//   ④ 自注入／自重置。
import assert from "node:assert/strict";
import { pairActionScopes, setVerbTypes, setVerbRe, setTypeHints } from "../lib/core/authorization.js";
import { TEST_VERB_TYPES_ZH, TEST_VERB_RE_ZH, useChineseVerbHints } from "./helpers.mjs";

// ── ① 迁移前基线（现盘逐字快照）──
const LEGACY_TYPES = [
  ["删除|移除|清理|清空|丢弃", "delete"],
  ["备份", "backup"],
  ["提交|推送", "git"],
  ["下载", "network"],
  ["执行|运行", "any"],
  [
    "写|保存|另存为|创建|复制|移动|修改|编辑|替换|改|补|修|做|安装|卸载|修复|重建|启动|停止|调整|改进|优化|升级|迁移|整理|添加|增加",
    "write"
  ]
];
const LEGACY_RE =
  "删除|移除|修改|编辑|替换|写入|写|保存|另存为|创建|复制|移动|备份|提交|推送|下载|执行|运行|安装|卸载|清理|修复|重建|启动|停止|调整|改进|优化|升级|迁移|整理|添加|增加|改|补|修|做|实施|推进|继续|处理|解决|转化|转换|读取|读(?:完|出|一下|一遍|出来)?|展示|打开|提取|还原|导入|导出|落盘|落地";

// ── ② 夹具与基线逐字一致 ──
assert.deepEqual(TEST_VERB_TYPES_ZH.map((h) => [h.re, h.type]), LEGACY_TYPES, "夹具 verbTypes 应与现盘基线逐字一致");
assert.equal(TEST_VERB_RE_ZH, LEGACY_RE, "夹具 verbRe 应与现盘基线逐字一致");
assert.equal(new Set(TEST_VERB_TYPES_ZH.map((h) => h.type)).size, 6, "六 type 不重复（每 type 一条）");

// ── ③ 配置层生效（自注入）──
useChineseVerbHints();

// R6④：动作-路径就近精确配对——"修改 A 并删除 B" 只产生 {write,A} 与 {delete,B}
const scopes = pairActionScopes("修改 D:/tmp/a.txt 并删除 D:/tmp/b.txt", "1", false);
const pairs = scopes.map((s) => `${s.type}|${s.pathPrefix}`);
assert.ok(pairs.includes("write|d:/tmp/a.txt"), "write 绑 A");
assert.ok(pairs.includes("delete|d:/tmp/b.txt"), "delete 绑 B");
assert.ok(!pairs.includes("write|d:/tmp/b.txt"), "不得笛卡尔积：write 不绑 B");
assert.ok(!pairs.includes("delete|d:/tmp/a.txt"), "不得笛卡尔积：delete 不绑 A");

// 宽泛指令保持 any（不误限为 command）；具体动词给出类型
assert.ok(pairActionScopes("执行吧", "1", false).every((s) => s.type === "any"), "执行吧 → any");
assert.ok(pairActionScopes("清理 D:/tmp/c", "1", false).some((s) => s.type === "delete"), "清理 → delete");

// ── ④ 两域同时还原（verb 层 ＋ typeHints 层）后，中文动词不再命中：证明中文源确由配置层承接 ──
// 注：只清 verb 层不足以断言不命中——无动词子句会回退 inferTypesFromText（typeHints 路径），
//     而 run-all 环境下 typeHints 中文夹具仍在（域 2 第二枪），故此处显式隔离两域。
setVerbTypes([]);
setVerbRe("");
setTypeHints([], { clear: true });
assert.ok(!pairActionScopes("删除 D:/tmp/d", "1", false).some((s) => s.type === "delete"), "两域还原后中文动词不命中");

// 自重置（供后续测试／单独运行；run-all 循环亦会重申各夹具）
setVerbTypes([], { clear: true });
setVerbRe("", { clear: true });

console.log("verb-config.test.mjs PASS");
