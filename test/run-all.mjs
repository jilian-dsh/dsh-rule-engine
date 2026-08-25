// run-all.mjs - 依次运行全部单测（.mjs 化：避免 .js 被 Windows 脚本主机误打开弹窗）
const tests = [
  "./parser.test.mjs",
  "./understander.test.mjs",
  "./authorization.test.mjs",
  "./intent.test.mjs",
  "./guard.test.mjs",
  "./text-detect.test.mjs",
  "./version-guard.test.mjs",
  "./patterns.test.mjs",
  "./consistency.test.mjs",
  "./silent-error.test.mjs",
  "./requirements-baseline.test.mjs",
  "./observability.test.mjs",
  "./phase1-granular.test.mjs",
  "./llm-understander.test.mjs",
  "./llm-intent.test.mjs",
  "./session-event.test.mjs",
  "./state.test.mjs",
  "./contract.test.mjs",
  "./overengineering.test.mjs",
  "./task-contract-guard.test.mjs",
  "./consistency-live.test.mjs",
  "./runtime-smoke.mjs",
  // 官方事件结构集成测试置末尾：runtime-smoke 依赖"第一个动态 import index.js"
  //（自设 DSH_HOME 后加载）；本文件自包含规则集，放最后不受 ESM 模块缓存影响。
  "./session-events.integration.test.mjs",
  // phase1b 机制测试：自设 DSH_HOME + 自包含规则集 + import index.js——固定放最后（同缓存前提）
  "./phase1b-mechanism.test.mjs",
  // phase1c 批次 3 ask 链安全精化：同 phase1b 前提（自设 DSH_HOME + import index.js）——保持末尾
  "./phase1c-safechannel.test.mjs",
  // phase1d 批次 4 默认武装：纯函数测试（不 import index.js，安全位置）
  "./phase1d-armed.test.mjs",
  // phase1e 批次 5 文本健康：纯函数测试（不 import index.js）
  "./phase1e-texthealth.test.mjs",
  // phase1f O1 注入通道修复（批次 6）：同 session-events/phase1b/1c 前提（自设 DSH_HOME + import index.js）——保持末尾
  "./phase1f-inject.test.mjs"
];

for (const t of tests) {
  console.log(`\n== ${t} ==`);
  await import(t);
}

console.log("\nALL TESTS PASSED");
