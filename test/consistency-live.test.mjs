// consistency-live.test.mjs — 真实 AGENTS.md ↔ 引擎映射一致性守门测试（预防漂移）
// 若本机不存在 AGENTS.md（开发/CI 环境）则跳过；存在则强制：
//   1. 默认偏好表（本机配置 handlerDefaultMap）无死键（映射的规则 ID 必须存在于 AGENTS.md）
//   2. 所有 A/C/M 级规则（deny/ask/meta）必须有 handler（规则声明强制 ⇒ 引擎必须执行）
//   3. "B + D"/"B 弱 + D" 类空格组合等级必须解析出 correct+self-certify（防 level 解析回归）
// 运行：node test/consistency-live.test.mjs（被 run-all.mjs 一并执行）
// 2026-08-31：SKIP 不得 process.exit(0)——会杀掉 run-all 进程（此后测试静默不跑，"全绿"假象）。
// 主体移入 main()，SKIP 打印后正常返回。
import assert from "node:assert/strict";
import { loadRules } from "../lib/core/parser.js";
import { understandAll, analyzeCoverage } from "../lib/core/understander.js";
import { loadDisabledRuleEntries } from "../lib/core/state.js";
import { loadPluginConfig } from "../lib/core/config.js";

function main() {
  const parsed = loadRules();
  if (!parsed.ok || parsed.missing) {
    console.log("consistency-live.test.js SKIP (no AGENTS.md on this machine)");
    return;
  }

  // 禁用存档（dsh-rules-manager 的 disabled-rules.json）参与理解层：正文已移走的禁用规则以
  // disabled 占位重建——占位在场 → 死映射不再误报（禁用≠删除是引擎语义的基本盘）
  // 残余1 剥离后（2026-08-31）：默认偏好表来自本机配置 handlerDefaultMap——
  // 真实环境守门必须与引擎口径一致（通用部署=空表，本测试跳过该维度）
  const pcfg = loadPluginConfig();
  const configs = understandAll(parsed.rules, {
    disabledEntries: loadDisabledRuleEntries(),
    handlerOverrides: pcfg.handlerOverrides || {},
    defaultMap: pcfg.handlerDefaultMap || {}
  });
  const { dead, uncovered } = analyzeCoverage(configs, pcfg.handlerDefaultMap || {});

  assert.equal(
    dead.size,
    0,
    `死映射（默认偏好表映射但 AGENTS.md 无此规则）：${[...dead.entries()].map(([id, h]) => `${id}->${h}`).join("、")}。请清理配置或恢复规则。`
  );
  assert.equal(
    uncovered.length,
    0,
    `未覆盖硬规则（A/C/M 级但无 handler，声明强制但引擎不执行）：${uncovered.map((u) => `${u.ruleId}(${u.actions.join("+")})`).join("、")}。请补 handler 或降为 D 级。`
  );

  // level 解析一致性：B + D / B 弱 + D 类规则必须同时有 correct 与 self-certify
  const byId = new Map(configs.map((c) => [String(c.ruleId), c]));
  for (const id of ["2", "11", "12C"]) {
    const cfg = byId.get(id);
    if (!cfg) continue;
    const acts = cfg.actions || [];
    assert.ok(
      acts.includes("correct") && acts.includes("self-certify"),
      `规则 ${id} 等级 "${cfg.level}" 应解析出 correct+self-certify，实际 ${acts.join("+")}`
    );
  }

  console.log(`consistency-live.test.js PASS (${configs.length} rules, 0 dead, 0 uncovered)`);
}

main();
