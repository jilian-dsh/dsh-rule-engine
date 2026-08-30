// contract-categories.test.mjs - F5 契约类别白名单 + 完成降级单测（0.5.12 批次 3）
import assert from "node:assert/strict";
import {
  defaultContract,
  decideContractAction,
  categoryOfCommand,
  isDestructiveCategory,
  NON_DESTRUCTIVE_CATEGORIES,
  DESTRUCTIVE_CATEGORIES,
  applyContract
} from "../lib/core/contract.js";

const base = { ...defaultContract(), mode: "change", level: "guard" };

// ── ① 类别分类（categoryOfCommand）──
assert.equal(categoryOfCommand("pnpm install --frozen-lockfile"), "install", "install 类");
assert.equal(categoryOfCommand("node tsc -p tsconfig.build.json"), "build", "build 类");
assert.equal(categoryOfCommand("npm test"), "test", "test 类");
assert.equal(categoryOfCommand("Remove-Item -Recurse D:/x"), "delete", "Remove-Item 破坏类");
assert.equal(categoryOfCommand("rm -rf D:/x"), "delete", "rm 破坏类");
assert.equal(categoryOfCommand("mv a b"), "delete", "mv 破坏类");
assert.equal(isDestructiveCategory("delete"), true, "delete 是破坏类");
assert.equal(NON_DESTRUCTIVE_CATEGORIES.has("install"), true, "非破坏类含 install");
assert.equal(DESTRUCTIVE_CATEGORIES.has("delete"), true, "破坏类含 delete");

// ── ② 类别白名单裁决（decideContractAction）──
const withCats = { ...base, categories: ["install", "build"] };
// 白名单内 → allow
assert.equal(
  decideContractAction({ contract: withCats, action: { mutability: "write", commandText: "pnpm install x" } }).outcome,
  "allow", "白名单内 install 放行"
);
// 白名单外 → deny
const denyTest = decideContractAction({ contract: withCats, action: { mutability: "write", commandText: "npm test" } });
assert.equal(denyTest.outcome, "deny", "白名单外 test 拒绝");
assert.equal(denyTest.reasonCode, "CATEGORY_NOT_IN_CONTRACT", "reasonCode 正确");
// 破坏类结构性拒绝（即使白名单未列）
const denyDel = decideContractAction({ contract: withCats, action: { mutability: "write", commandText: "Remove-Item D:/x -Recurse" } });
assert.equal(denyDel.outcome, "deny", "破坏类结构性拒绝");
assert.equal(denyDel.reasonCode, "DESTRUCTIVE_NOT_ALLOWED", "destructive reasonCode");
// 未知类别 → 普通判定（不放大，返回 allow 因为无其他限制）
assert.equal(
  decideContractAction({ contract: withCats, action: { mutability: "write", commandText: "echo hi" } }).outcome,
  "allow", "未知类别（echo）不放大契约（非破坏且无白名单命中 → 走普通判定）"
);
// categories=null → 不启用类别检查（既有行为）
assert.equal(
  decideContractAction({ contract: base, action: { mutability: "write", commandText: "Remove-Item x" } }).outcome,
  "allow", "categories=null 时破坏类也不拦（由 22/13A 守卫）——契约只管模式/预算"
);

// ── ③ 完成降级信号（applyContract + mode 语义）──
// 契约 install 成功后降级 watch：mode 变化可观测
const afterComplete = applyContract(base, { mode: "watch", level: "guard", source: "auto-complete" }).contract;
assert.equal(afterComplete.mode, "watch", "完成后 mode→watch");
assert.equal(
  decideContractAction({ contract: afterComplete, action: { mutability: "write", commandText: "pnpm install x" } }).outcome,
  "allow", "watch 级别不拦截（降级后普通判定）"
);

console.log("contract-categories.test.mjs ALL PASS");
