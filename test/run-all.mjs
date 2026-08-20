// run-all.mjs - 依次运行全部单测（.mjs 化：避免 .js 被 Windows 脚本主机误打开弹窗）
const tests = [
  "./parser.test.mjs",
  "./understander.test.mjs",
  "./authorization.test.mjs",
  "./guard.test.mjs",
  "./text-detect.test.mjs",
  "./version-guard.test.mjs",
  "./patterns.test.mjs",
  "./consistency.test.mjs",
  "./silent-error.test.mjs",
  "./llm-understander.test.mjs",
  "./state.test.mjs",
  "./runtime-smoke.mjs"
];

for (const t of tests) {
  console.log(`\n== ${t} ==`);
  await import(t);
}

console.log("\nALL TESTS PASSED");
