// run-all.js - 依次运行全部单测
const tests = [
  "./parser.test.js",
  "./understander.test.js",
  "./authorization.test.js",
  "./guard.test.js",
  "./text-detect.test.js",
  "./version-guard.test.js",
  "./patterns.test.js",
  "./consistency.test.js",
  "./silent-error.test.js",
  "./llm-understander.test.js",
  "./state.test.js",
  "./runtime-smoke.js"
];

for (const t of tests) {
  console.log(`\n== ${t} ==`);
  await import(t);
}

console.log("\nALL TESTS PASSED");
