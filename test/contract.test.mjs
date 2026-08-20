import assert from "node:assert/strict";
import {
  applyContract,
  contractSummary,
  decideContractAction,
  defaultContract,
  isArmed,
  isObserving,
  naturalMode,
  parseBudgetCommand,
  parseModeCommand
} from "../lib/core/contract.js";

// 默认契约
const d = defaultContract();
assert.equal(d.mode, "unconfirmed");
assert.equal(d.level, "watch");
assert.equal(d.agentBudget, 0);

// /guard mode 解析
assert.deepEqual(parseModeCommand("mode review"), { mode: "review", level: "guard" });
assert.deepEqual(parseModeCommand("mode watch"), { mode: "watch", level: "watch" });
assert.deepEqual(parseModeCommand("mode change lock"), { mode: "change", level: "lock" });
assert.equal(parseModeCommand("mode foo"), null);

// /guard budget 解析
const budget = parseBudgetCommand("budget agents=2 files=src/a|test/b deps=allow hash=ask");
assert.equal(budget.agentBudget, 2);
assert.deepEqual(budget.allowedPaths, ["src/a", "test/b"]);
assert.equal(budget.dependencyPolicy, "allow");
assert.equal(budget.hashPolicy, "ask");

// 自然语言
assert.equal(naturalMode("只审查，不要修改任何代码").mode, "review");
assert.equal(naturalMode("只回答").mode, "answer");
assert.equal(naturalMode("帮我修复这个问题"), null); // 默认不是 change，除非前序非修改模式
const prevReview = { ...defaultContract(), mode: "review" };
assert.equal(naturalMode("请修改配置", prevReview).mode, "change");

// applyContract
const res = applyContract(defaultContract(), { mode: "review", level: "guard", source: "test" });
assert.equal(res.changed, true);
assert.equal(res.contract.mode, "review");
assert.equal(res.contract.level, "guard");

// armed/observe 判断
const cfgOn = { taskContractEnabled: true, taskContractMode: "armed", askEnabled: false };
const cfgObserve = { taskContractEnabled: true, taskContractMode: "observe", askEnabled: false };
assert.equal(isArmed(res.contract, cfgOn), true);
assert.equal(isObserving(res.contract, cfgOn), false);
assert.equal(isObserving(res.contract, cfgObserve), true);

// 裁决：review 写文件 deny
const reviewContract = { ...defaultContract(), mode: "review", level: "guard" };
const writeAction = { mutability: "write", hashIntent: false, dependencyIntent: false, affectedPaths: ["a.txt"], delegationCount: 0, unboundedDelegation: false };
assert.equal(decideContractAction({ contract: reviewContract, action: writeAction, config: cfgOn }).outcome, "deny");

// 裁决：change 且 hash=deny
const changeContract = { ...defaultContract(), mode: "change", level: "guard", hashPolicy: "deny" };
const hashAction = { ...writeAction, hashIntent: true };
assert.equal(decideContractAction({ contract: changeContract, action: hashAction, config: cfgOn }).outcome, "deny");

// 裁决：hash=ask 且 askEnabled=true -> ask
const askContract = { ...defaultContract(), mode: "change", level: "guard", hashPolicy: "ask" };
assert.equal(decideContractAction({ contract: askContract, action: hashAction, config: { ...cfgOn, askEnabled: true } }).outcome, "ask");

// 裁决：路径越界
const pathContract = { ...defaultContract(), mode: "change", level: "guard", allowedPaths: ["src/a"] };
const outsideAction = { ...writeAction, affectedPaths: ["src/b"] };
assert.equal(decideContractAction({ contract: pathContract, action: outsideAction, config: cfgOn }).outcome, "deny");

// 裁决：子代理预算超限
const agentContract = { ...defaultContract(), mode: "change", level: "guard", agentBudget: 1, agentsUsed: 1 };
const delegateAction = { mutability: "delegate", hashIntent: false, dependencyIntent: false, affectedPaths: [], delegationCount: 1, unboundedDelegation: false };
assert.equal(decideContractAction({ contract: agentContract, action: delegateAction, config: cfgOn }).outcome, "deny");

// contractSummary
assert.ok(contractSummary(changeContract).includes("mode=change"));
console.log("contract.test.mjs PASS");
