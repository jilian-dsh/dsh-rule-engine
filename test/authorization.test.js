import assert from "node:assert/strict";
import {
  askResultApproved,
  authMatches,
  describeOp,
  findMatchingAuth,
  inferPathPrefixFromText,
  inferTypeFromText,
  isAuthMessage,
  isDirectiveMessage,
  isQuestionMessage,
  operationOf
} from "../lib/core/authorization.js";

// 操作范围推导
const op = operationOf("edit", { file_path: "D:\\dsh-injector-pkg\\lib\\client.js" });
assert.equal(op.type, "write");
assert.equal(op.pathPrefix, "d:/dsh-injector-pkg/lib/client.js");

const cmdOp = operationOf("pwsh", { command: "Remove-Item -Path 'D:/tmp/a.txt' -Force" });
assert.equal(cmdOp.type, "delete");
assert.ok(cmdOp.pathPrefix.includes("d:/tmp/a.txt"), "command path extracted");

const backupOp = operationOf("pwsh", { command: "Copy-Item -LiteralPath 'D:/a.txt' -Destination 'D:/a.txt.bak' -Force" });
assert.equal(backupOp.type, "backup", "copy to .bak should be backup type");
const copyWriteOp = operationOf("pwsh", { command: "Copy-Item -LiteralPath 'D:/a.txt' -Destination 'D:/b.txt' -Force" });
assert.equal(copyWriteOp.type, "write", "copy to non-backup target should be write type");

// 文本推断
assert.equal(inferTypeFromText("授权修改 D:\\dsh-injector-pkg 下文件"), "write");
assert.equal(inferTypeFromText("允许删除 test/a.txt"), "delete");
assert.equal(inferTypeFromText("可以执行 git push"), "git");
assert.ok(inferPathPrefixFromText("允许修改 D:\\dsh-injector-pkg\\lib\\client.js").includes("d:/dsh-injector-pkg/lib/client.js"));
assert.ok(
  inferPathPrefixFromText("Copy-Item -LiteralPath 'D:\\DeepSeek harness\\a.jsonl.zstd' -Destination 'D:\\DeepSeek harness\\b.jsonl.zstd'")
    .includes("d:/deepseek harness/a.jsonl.zstd"),
  "quoted path with spaces extracted"
);

// 范围匹配
const auth = { type: "write", pathPrefix: "d:/dsh-injector-pkg", at: 1 };
assert.equal(authMatches(auth, { type: "write", pathPrefix: "d:/dsh-injector-pkg/lib/client.js" }), true);
assert.equal(authMatches(auth, { type: "write", pathPrefix: "d:/other/file.js" }), false);
assert.equal(authMatches(auth, { type: "delete", pathPrefix: "d:/dsh-injector-pkg/x" }), false);

const found = findMatchingAuth([auth], { type: "write", pathPrefix: "d:/dsh-injector-pkg/lib/a.js" });
assert.ok(found, "matching auth found");

// 授权 TTL：过期记录不匹配
const expiredAuth = { type: "write", pathPrefix: "d:/dsh-injector-pkg", at: 1, expiresAt: Date.now() - 1000 };
assert.equal(findMatchingAuth([expiredAuth], { type: "write", pathPrefix: "d:/dsh-injector-pkg/lib/a.js" }), null, "expired auth ignored");
const validAuth = { type: "write", pathPrefix: "d:/dsh-injector-pkg", at: 1, expiresAt: Date.now() + 10000 };
assert.ok(findMatchingAuth([validAuth], { type: "write", pathPrefix: "d:/dsh-injector-pkg/lib/a.js" }), "valid auth matched");

// 询问 vs 授权
assert.equal(isQuestionMessage("修复这个影响插件本身吗"), true);
assert.equal(isQuestionMessage("可以，开始执行吧"), false);
assert.equal(isAuthMessage("可以，开始执行吧"), true);
assert.equal(isAuthMessage("修复这个影响插件本身吗"), false);
assert.equal(isDirectiveMessage("删除这个文件"), true);
assert.equal(isDirectiveMessage("修复这个影响插件本身吗"), false);

// ask 结果解析
assert.equal(askResultApproved({ answers: [{ selected: ["允许（推荐）"] }] }), true);
assert.equal(askResultApproved({ answers: [{ selected: ["不允许"] }] }), false);
assert.equal(askResultApproved({ answers: [{ selected: ["允许"], custom: "否" }] }), false);

// describeOp
assert.ok(describeOp({ type: "write", pathPrefix: "d:/x" }).includes("write"));

console.log("authorization.test.js PASS");
