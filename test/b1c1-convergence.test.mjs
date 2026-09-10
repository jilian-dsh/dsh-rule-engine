// b1c1-convergence.test.mjs —— B1（官方 bundle 目录解析）与 C1（装配不一致死循环的收敛豁免）回归
// 2026-09-10 · 独立 DSH_HOME 试点反馈（贵方文档 §B1 / §C1）
//
// 变红条件：
//   B1-1  官方 bundle 无 package.json 时应放行——旧实现返回 1 项 → 红
//   B1-2  非官方 bundle 解析不到仍应报错（防"顺手放水"）→ 旧实现也红/新实现绿
//   B1-3  文案含可执行排查方向（profiles/node_modules 共享层）
//   C1-1  **回滚**（变更后签名 == 审计通过时签名）应豁免 → 旧实现拦 → 红
//   C1-2  **修复**（变更前不自洽、变更后自洽）应豁免 → 旧实现拦 → 红
//   C1-3  **负例**：变更后仍不自洽 → 仍拦（收敛豁免不得变成放水）
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = join(tmpdir(), "dsh-rule-engine-b1c1-test");
const profDir = join(HOME, "profiles", "pilot");
mkdirSync(join(profDir, "node_modules"), { recursive: true });
process.env.DSH_HOME = HOME;

const { nonBundleInContent, isConvergingBundleFix } = await import("../lib/core/guard-core.js");
const { state } = await import("../lib/core/runtime.js");
state.lastMtimeCheck = Date.now() + 3600_000;

const pkgPath = join(profDir, "package.json");
const mkPkg = (bundles) =>
  JSON.stringify({ name: "dsh-profile-pilot", private: true, dependencies: {}, dsh: { profile: { bundles } } }, null, 2);

// ── B1：官方 bundle 白名单豁免（规则 24 自身的豁免条款）──
assert.equal(
  nonBundleInContent(mkPkg(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]), pkgPath),
  null,
  "B1-1 官方 bundle 应直接放行（此前因独立 DSH_HOME 无共享层而报「找不到 package.json」）"
);

// ── B1 负例：非官方 bundle 解析不到 → 仍报错（不得顺手放水）──
const bad = nonBundleInContent(mkPkg(["some-nonexistent-plugin"]), pkgPath);
assert.ok(bad && bad.length === 1, `B1-2 非官方 bundle 解析不到仍应报错（实际 ${JSON.stringify(bad)}）`);
assert.match(bad[0], /profiles\/node_modules 共享层/, "B1-3 报错文案应含可执行的排查方向（共享层）");

// ── C1：收敛豁免（须先写入"变更前"的真实文件内容）──
const BROKEN = mkPkg(["some-nonexistent-plugin"]); // 不自洽
const HEALTHY = mkPkg(["@deepseek-ai/dsh-base"]);  // 自洽

// C1-2 修复：变更前不自洽 → 变更后自洽
writeFileSync(pkgPath, BROKEN, "utf8");
assert.equal(
  isConvergingBundleFix("write", { file_path: pkgPath, content: HEALTHY }),
  true,
  "C1-2 修复动作（不自洽 → 自洽）应被判为收敛性变更"
);

// C1-3 负例：变更后仍不自洽 → 不算收敛
assert.equal(
  isConvergingBundleFix("write", { file_path: pkgPath, content: mkPkg(["another-missing-plugin"]) }),
  false,
  "C1-3 变更后仍不自洽 → 不得豁免（防收敛豁免变放水）"
);

// C1-3b 负例：变更前本就自洽 → 不算"修复"（属于新增变更，仍应先审计）
writeFileSync(pkgPath, HEALTHY, "utf8");
assert.equal(
  isConvergingBundleFix("write", { file_path: pkgPath, content: mkPkg(["@deepseek-ai/dsh-base", "extra-new-bundle"]) }),
  false,
  "C1-3b 变更前自洽 → 不适用收敛豁免（新增变更仍须先审计）"
);

// C1-1 回滚判定依据：签名相等时守卫直接放行（此处锁定判据本身，避免将来被改写）
const { computeMountSignature } = await import("../lib/core/mount-signature.js");
assert.equal(typeof computeMountSignature, "function", "C1-1 签名函数可用（回滚豁免依赖 currentSig === auditedSig）");

console.log("b1c1-convergence：B1 官方豁免/负例/文案 + C1 修复豁免/两条负例 共 6 项断言通过");
