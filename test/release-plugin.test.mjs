// release-plugin.test.js — 第二批 §1.2 三改进验收（dry-run 断言；2026-09-08）
// 例①：plugins.json 条目命中（清单名参数不再回退目录路径）
// 例②：README 四点同步（徽章/正文当前版本/历史表新行/固定源占位注释）
// 例③：dist-tags 轮询可配（默认 180s；RELEASE_DIST_TAG_POLL_SEC 覆盖，下限 30）
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "release-plugin.mjs");

function dryRun(extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, "dsh-rule-engine", "--dry-run"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv }
  });
}

// 例①：plugins.json 条目命中
{
  const r = dryRun();
  assert.equal(r.status, 0, `dry-run 应成功：${r.stderr}`);
  assert.ok(r.stdout.includes("dsh-rule-engine (dir=.)"), "plugins.json 条目命中（dir=.）");
}

// 例②：README 四点同步声明（徽章/正文/历史表/固定源占位）
{
  const r = dryRun();
  assert.ok(r.stdout.includes("README 四点同步"), "README 四点同步声明");
  assert.ok(r.stdout.includes("固定源占位注释"), "固定源占位注释在列");
}

// 例③：轮询可配
{
  const r1 = dryRun();
  assert.ok(r1.stdout.includes("轮询: 180s"), "默认轮询 180s");
  const r2 = dryRun({ RELEASE_DIST_TAG_POLL_SEC: "30" });
  assert.ok(r2.stdout.includes("轮询: 30s"), "env 覆盖 30s");
  const r3 = dryRun({ RELEASE_DIST_TAG_POLL_SEC: "5" });
  assert.ok(r3.stdout.includes("轮询: 30s"), "低于下限钳制到 30s");
}

console.log("release-plugin.test.js PASS");
