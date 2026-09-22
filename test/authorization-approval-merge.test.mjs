// 域 2 第一枪（2026-09-21）：第二份许可词 APPROVAL_RE 并入 lexicon.approval——
//   ① 独有词（是/去吧/开始/执行）迁后仍真；
//   ② 「行」有意分叉（迁移前 APPROVAL_RE 与 action_words 均不含 → 假；并入 approval 后 → 真）；
//   ③ approval_exec 本枪不改：单独许可词 ≠ 执行许可（isAuthMessage 仍假）。
import assert from "node:assert/strict";
import { isApprovalText, isAuthMessage } from "../lib/core/authorization.js";
import { resetLexicons } from "../lib/core/lexicon.js";
import { useChineseLexicons } from "./helpers.mjs";

useChineseLexicons(); // 夹具含并词后的 approval（与 test/helpers.mjs 同值）

// ① 原第二份的独有词：迁后仍真
for (const w of ["是", "去吧", "开始", "执行"]) {
  assert.equal(isApprovalText(w), true, `迁后：${w} 仍真`);
}
// ② 行：有意分叉——旧实现为假（APPROVAL_RE 不含、action_words 不含），并入 approval 后为真
assert.equal(isApprovalText("行"), true, "迁后：行 = 真（有意分叉）");
// ③ 单独许可词不构成执行许可（夹具已显式钉死本机旧 approval_exec：第一段不含「是/去吧」→ 仍需执行语）
assert.equal(isAuthMessage("是"), false, "迁后：是（单独句）isAuthMessage 仍假");
assert.equal(isAuthMessage("去吧"), false, "迁后：去吧（单独句）isAuthMessage 仍假");

resetLexicons();
console.log("authorization-approval-merge.test.mjs PASS");
