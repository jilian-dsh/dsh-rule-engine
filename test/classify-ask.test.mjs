// classify-ask.test.mjs - 0.5.10 建议1①：ask 答复结构化操作类型（纯函数）
// 2026-09-07（E3/簇 A）：classifyAskScopeType 接入 TYPE_HINTS（配置化）——用例扩展 git/network/配置层
import test from "node:test";
import assert from "node:assert";
const { classifyAskScopeType, setTypeHints } = await import("../lib/core/authorization.js");

test("明确写类答复 → write", () => {
  assert.equal(classifyAskScopeType("是否允许写入该文件（允许写入文件）"), "write");
  assert.equal(classifyAskScopeType("允许修改配置文件"), "write");
});
test("命令/脚本类答复 → command", () => {
  assert.equal(classifyAskScopeType("允许用 pwsh 执行网络诊断"), "command");
  assert.equal(classifyAskScopeType("允许运行诊断脚本"), "command");
});
test("含糊/纯只读 → any（无命中保守兜底）/ analysis（只读提示命中）", () => {
  assert.equal(classifyAskScopeType("可以"), "any");
  assert.equal(classifyAskScopeType("允许查看该报告"), "analysis");
});
// 2026-09-07（E3）：git 类（内置 TYPE_HINTS L39 git push|commit/提交/推送）——不再 write/any 误映射；"git commit" 连写命中
test("git 类答复 → git（非 write/any）", () => {
  assert.equal(classifyAskScopeType("允许 git commit"), "git");
  assert.equal(classifyAskScopeType("允许 git commit 吗（允许 git commit）"), "git");
  assert.equal(classifyAskScopeType("允许提交"), "git");
  assert.equal(classifyAskScopeType("允许推送"), "git");
});
// 2026-09-07（E3/簇 A）：配置层 typeHints 生效（v4.107 正解——补词进配置不进通用码）
test("配置层 typeHints 扩展生效（覆盖→write）", () => {
  setTypeHints([{ re: "覆盖|覆写|overwrite", type: "write" }]);
  assert.equal(classifyAskScopeType("允许覆盖该文件"), "write");
  setTypeHints([]); // 还原内置
  assert.equal(classifyAskScopeType("允许覆盖该文件"), "any"); // 还原后内置表无"覆盖"——any（配置词才给 write）
});
