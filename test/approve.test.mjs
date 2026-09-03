// C4（2026-09-03）：物理确认（/guard approve）+ 授权类型配置化（TYPE_HINTS/archive）测试
import assert from "node:assert";
import {
  APPROVE_TYPES,
  inferTypeFromText,
  inferTypesFromText,
  setTypeHints
} from "../lib/core/authorization.js";

// ── archive 独立类型（解压高频用例）──
assert.equal(inferTypeFromText("解压历史会话到临时目录"), "archive", "解压 → archive");
assert.equal(inferTypeFromText("用 Expand-Archive 展开发行包"), "archive", "Expand-Archive → archive");
assert.equal(inferTypeFromText("unzip releases 到工作区"), "archive", "unzip → archive");
assert.ok(inferTypesFromText("解压并修改配置").includes("archive"), "多操作含 archive");
assert.ok(inferTypesFromText("解压并修改配置").includes("write"), "多操作含 write");

// ── APPROVE_TYPES 派生：包含内置 9 类、不含 any ──
const approveTypes = APPROVE_TYPES();
for (const t of ["write", "delete", "command", "network", "git", "skill", "backup", "analysis", "archive"]) {
  assert.ok(approveTypes.includes(t), `APPROVE_TYPES 含 ${t}`);
}
assert.ok(!approveTypes.includes("any"), "APPROVE_TYPES 不含 any（全局通配禁止）");

// ── 配置层扩展（typeHints）──
setTypeHints([{ type: "xyz", re: "虚拟(?:前缀|操作)" }], { clear: true });
assert.equal(inferTypeFromText("执行虚拟前缀操作"), "xyz", "配置扩展类型生效");
const before = APPROVE_TYPES().length;
setTypeHints([{ type: "xyz", re: "再来一个" }], { clear: true }); // 重复 type 不追加
assert.equal(APPROVE_TYPES().length, before, "重复 type 不追加");
setTypeHints([{ type: "bad", re: "(((" }], { clear: true }); // 非法正则 fail-safe
assert.ok(!APPROVE_TYPES().includes("bad"), "非法正则跳过");
setTypeHints([], { clear: true }); // 还原默认
assert.equal(inferTypeFromText("解压历史会话"), "archive", "reset 后默认 archive 恢复");

console.log("approve.test.js PASS");
