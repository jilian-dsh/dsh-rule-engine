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
  // B1 热词学习（2026-08-29）：自设 DSH_HOME + 动态 import（hotwords/intent 均运行时读 env）——守住 patterns 后、guard 前
  "./hotwords.test.mjs",
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
  "./phase1f-inject.test.mjs",
  // v0.5.7 投递资格语义层：纯函数测试（不 import index.js，安全位置）——固定末尾（踩坑 83 ESM 缓存约定）
  "./semantic-gate.test.mjs",
  // v0.5.9 白名单 v2 存储格式：纯函数（不 import index.js）——紧随 semantic-gate 之后
  "./whitelist.test.mjs",
  // v0.5.10 分析通道/写类判定/已知坑召回：纯函数（不 import index.js）——固定末尾
  "./analysis-channel.test.mjs",
  // v0.5.10 建议1① ask 答复结构化：纯函数（authorization 依赖）——固定末尾
  "./classify-ask.test.mjs",
  // v0.5.11 规则 24 守卫链覆盖（跨工具一致性）：纯函数（自设 DSH_HOME，不 import index.js）——固定末尾
  "./guardchain-coverage.test.mjs",
  // v0.5.12 阶段一（2026-08-28）：A1 词表/A3 @引用/B1 只读/C1 授权统一/E1 打标——纯函数 + guardDecision 集成
  "./phase1-fix.test.mjs",
  // v0.5.13 阶段二+三：B2 委派/C2 中文路径/C3 ask 节流/D1-D3 注入/F1 规则2/F2 verify-gap 回归
  "./realcase-regression.test.mjs"
];

for (const t of tests) {
  console.log(`\n== ${t} ==`);
  await import(t);
}

console.log("\nALL TESTS PASSED");
