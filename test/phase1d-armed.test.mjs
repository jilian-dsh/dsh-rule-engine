// phase1d-armed.test.mjs - 批次 4 阶段 3 默认武装测试（2026-08-24）
// ① 会话契约初始化：默认武装（armed+无显式 → change/guard/预算2）/ defaults 显式优先 / global 模板继承
// ② 契约 deny/ask → pre-execute 决策（物理拦截修复）
// ③ 截断噪声修复（引号路径+截断前缀去冗余）
// 先红后绿：改码前本文件应失败；改码后转绿。
import assert from "node:assert/strict";

const { defaultContract, initSessionContract, contractOutcomeToPreDecision } = await import("../lib/core/contract.js");
const { inferPathPrefixesFromText } = await import("../lib/core/authorization.js");

// ═══════════════ ① 会话契约初始化 ═══════════════
// 回归：无武装无配置 → 系统默认
{
  const c = initSessionContract({}, null);
  assert.equal(c.mode, "unconfirmed");
  assert.equal(c.level, "watch");
}
// 默认武装（用户选 A）：armed + defaults 无显式 mode/level → change/guard，agentBudget 0→2
{
  const c = initSessionContract(
    { taskContractMode: "armed", defaults: { agentBudget: 0, hashPolicy: "deny", dependencyPolicy: "ask", allowedPaths: null } },
    null
  );
  assert.equal(c.mode, "change", "armed 默认 mode=change");
  assert.equal(c.level, "guard", "armed 默认 level=guard");
  assert.equal(c.agentBudget, 2, "armed 默认预算=2（选 A：日常可用，非 0 禁用）");
  assert.equal(c.hashPolicy, "deny", "defaults 其余字段保留");
}
// defaults 显式 mode/level 优先
{
  const c = initSessionContract({ taskContractMode: "armed", defaults: { mode: "answer", level: "watch" } }, null);
  assert.equal(c.mode, "answer", "显式 defaults mode 优先");
  assert.equal(c.level, "watch", "显式 defaults level 优先");
}
// global 模板继承（用户 /guard mode 设置过 → 新会话继承）
{
  const globalC = { ...defaultContract(), mode: "answer", level: "guard", source: "guard-command" };
  const c = initSessionContract({ taskContractMode: "armed", defaults: {} }, globalC);
  assert.equal(c.mode, "answer", "global 模板（用户命令）> armed 推导");
  assert.equal(c.level, "guard");
  assert.equal(c.agentBudget, 2, "global 默认 0 不覆盖 armed 预算（armed 推导仍给 2）");
}
// global 未被命令改过（source=default）→ 不继承（避免默认值污染）
{
  const globalC = defaultContract(); // source=default
  const c = initSessionContract({ taskContractMode: "armed", defaults: { agentBudget: 0 } }, globalC);
  assert.equal(c.mode, "change", "global source=default 不继承");
  assert.equal(c.agentBudget, 2);
}

// ═══════════════ ② 契约决策 → pre-execute 决策 ═══════════════
{
  const deny = contractOutcomeToPreDecision({ outcome: "deny", family: "S", reasonCode: "AGENT_BUDGET_EXHAUSTED", reason: "子代理预算不足", nextStep: "继续本地完成" });
  assert.deepEqual(deny, { kind: "deny", reason: "子代理预算不足（任务契约｜继续本地完成）" }, "deny → 物理拦截");
  const ask = contractOutcomeToPreDecision({ outcome: "ask", family: "H", reasonCode: "HASH_NOT_AUTHORIZED", reason: "检测到哈希操作", nextStep: "获得 hash=allow" });
  assert.deepEqual(ask, { kind: "ask", reason: "检测到哈希操作（任务契约｜获得 hash=allow）" }, "ask → 问询");
  assert.equal(contractOutcomeToPreDecision({ outcome: "allow", family: null, reasonCode: "WITHIN_CONTRACT", reason: "在任务契约内", nextStep: "" }), null, "allow → 放行");
}

// ═══════════════ ②b 委托预算扣减（批次 5.5：启动即计，2026-08-24） ═══════════════
{
  const { consumeDelegateBudget } = await import("../lib/core/contract.js");
  const base = defaultContract();
  assert.equal(consumeDelegateBudget(base, 1).agentsUsed, 1, "0 → 1");
  assert.equal(consumeDelegateBudget({ ...base, agentsUsed: 1 }, 2).agentsUsed, 3, "1 + 2 → 3");
  assert.equal(consumeDelegateBudget(base, 1).agentsUsed, 1, "原对象不被污染（纯函数）");
  assert.equal(base.agentsUsed, 0, "原对象不变");
}

// ═══════════════ ③ 截断噪声修复 ═══════════════
{
  const paths = inferPathPrefixesFromText('"D:\\example workspace\\dsh-project\\reports\\d3-probe\\x.txt" 和 "D:\\example workspace\\x.txt"');
  assert.ok(paths.includes("d:/example workspace/dsh-project/reports/d3-probe/x.txt"), "完整路径保留");
  assert.ok(paths.includes("d:/example workspace/x.txt"), "完整路径保留 2");
  assert.ok(!paths.some((p) => p === "d:/example"), `截断前缀 d:/example 必须去除（实际 ${JSON.stringify(paths)}）`);
}
// ③b 主链路回归（2026-08-24 实测发现：截断条目真正来源 = pairActionScopes 的路径提取，
// 非 inferPathPrefixesFromText——上次修错层；授权集全链路断言）
{
  const { scopesFromIntents } = await import("../lib/core/authorization.js");
  const { parseUserIntents } = await import("../lib/core/intent.js");
  const TASK = `任务：在 Windows 的 D:\\example workspace\\dsh-project\\reports\\d3-probe\\ 目录下依次执行三步。
步骤：
1. 创建目录和文件：New-Item -ItemType Directory -Force "D:\\example workspace\\dsh-project\\reports\\d3-probe"，然后 Set-Content "D:\\example workspace\\dsh-project\\reports\\d3-probe\\probe.txt" "probe"。
2. 读取 D:\\example workspace\\dsh-project\\reports\\d3-probe\\probe.txt。
3. 删除该文件：Remove-Item "D:\\example workspace\\dsh-project\\reports\\d3-probe\\probe.txt" -Force。
只允许操作 D:\\example workspace\\dsh-project\\reports\\d3-probe 路径下的内容，绝对不碰其他任何文件。`;
  const scopes = scopesFromIntents(parseUserIntents(TASK));
  assert.ok(
    scopes.every((s) => s.pathPrefix !== "d:/example"),
    `授权集不得含截断条目 d:/example（实际 ${JSON.stringify(scopes.map((s) => `${s.type}|${s.pathPrefix}`))}）`
  );
  assert.ok(scopes.some((s) => s.pathPrefix && s.pathPrefix.startsWith("d:/example workspace/dsh-project/reports/d3-probe")), "完整 d3-probe 路径授权保留");
}

console.log("phase1d-armed.test.mjs PASS");
