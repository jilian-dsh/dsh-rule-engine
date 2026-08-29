// classify-ask.test.mjs - 0.5.10 建议1①：ask 答复结构化操作类型（纯函数）
import test from "node:test";
import assert from "node:assert";
const { classifyAskScopeType } = await import("../lib/core/authorization.js");

test("明确写类答复 → write", () => {
  assert.equal(classifyAskScopeType("是否允许写入该文件（允许写入文件）"), "write");
  assert.equal(classifyAskScopeType("允许修改配置文件"), "write");
});
test("命令/脚本类答复 → command", () => {
  assert.equal(classifyAskScopeType("允许用 pwsh 执行网络诊断"), "command");
  assert.equal(classifyAskScopeType("允许运行诊断脚本"), "command");
});
test("含糊/纯查看 → any（保守 TTL 短兜底）", () => {
  assert.equal(classifyAskScopeType("允许查看"), "any");
  assert.equal(classifyAskScopeType("可以"), "any");
});
