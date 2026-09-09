// dualtrack-rule-literals.test.mjs - 判据 D（规则号字面量）门禁测试（分层架构 v3 · P0，2026-09-10）
//
// P0 验收口径（架构正本 §八）：「故意加一行 rule99-x → 门禁红；删除 → 绿」。
// 本测试把该验收自动化：用 --root 指向临时仓库夹具，**绝不触碰真实 lib/**。
//
// 覆盖：① rule99-x 红 ② 删除后绿 ③ 其余三条模式各自红 ④ 注释内命中豁免（口径=去注释后扫）
//       ⑤ 基线缺 ruleLiteralFiles 维度 → fail-closed
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "dualtrack-check.mjs");

// ── 隔离夹具：临时仓库（lib + scripts 基线）+ 临时词表（保证判据 A 恒 0）──
const home = mkdtempSync(join(tmpdir(), "dsh-re-dt-rl-"));
const repo = join(home, "repo");
mkdirSync(join(repo, "lib"), { recursive: true });
mkdirSync(join(repo, "scripts"), { recursive: true });
const PROBE = join(repo, "lib", "probe.js");
const BASELINE = join(repo, "scripts", "dualtrack-baseline.json");
const markerFile = join(home, "markers.txt");
writeFileSync(markerFile, "# dualtrack-rule-literals 探针词表\n__dt_rule_literal_probe_never_matches__\n", "utf8");
const env = { ...process.env, DSH_HOME: home, DUALTRACK_MARKERS: markerFile };

function writeBaseline() {
  const payload = {
    generatedAt: "2026-09-10T00:00:00.000Z",
    note: "test fixture",
    total: 0,
    files: { "lib/probe.js": 0 },
    ruleLiteralsTotal: 0,
    ruleLiteralFiles: { "lib/probe.js": 0 }
  };
  writeFileSync(BASELINE, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function run() {
  return spawnSync(process.execPath, [SCRIPT, "--root", repo], { cwd: ROOT, encoding: "utf8", env });
}

function expectFail(src, label) {
  writeFileSync(PROBE, src, "utf8");
  const r = run();
  assert.equal(r.status, 1, `${label}：必须 FAIL（exit 1），实际 ${r.status}\n${r.stderr || r.stdout}`);
  assert.match(r.stderr, /判据 D 规则号字面量/, `${label}：stderr 必须点名判据 D`);
  return r;
}

function expectOk(src, label) {
  writeFileSync(PROBE, src, "utf8");
  const r = run();
  assert.equal(r.status, 0, `${label}：必须 OK（exit 0），实际 ${r.status}\n${r.stderr || r.stdout}`);
  assert.match(r.stdout, /DUALTRACK OK/, `${label}：stdout 必须含 DUALTRACK OK`);
  return r;
}

// ① P0 验收原文：加一行 rule99-x → 红
writeBaseline();
const r1 = expectFail(`export const a = "rule99-x";\n`, "① rule99-x");
assert.match(r1.stderr, /rule99-/, "① stderr 必须回显命中串 rule99-");

// ② 删除 → 绿
expectOk(`export const a = 1;\n`, "② 删除后");

// ③ 其余三条模式各自触发红
expectFail(`const v = byId.get("31");\n`, "③a byId.get");
expectFail(`console.log("[guardian:rule22]");\n`, "③b guardian-tag");
expectFail(`const k = "rule-hint.7";\n`, "③c rule-hint");
expectFail(`if (v.ruleId === "2") { /* … */ }\n`, "③d ruleId 比较");

// ④ 注释内命中豁免（口径 = 去注释后扫描）
expectOk(`// rule99-x 只出现在注释里\nexport const a = 1;\n`, "④ 注释豁免");

// ⑤ 基线缺 ruleLiteralFiles 维度 → fail-closed
writeFileSync(
  BASELINE,
  JSON.stringify({ generatedAt: "2026-09-10T00:00:00.000Z", total: 0, files: { "lib/probe.js": 0 } }, null, 2) + "\n",
  "utf8"
);
writeFileSync(PROBE, `export const a = 1;\n`, "utf8");
const r5 = run();
assert.equal(r5.status, 1, "⑤ 基线缺 ruleLiteralFiles 必须 fail-closed（exit 1）");
assert.match(r5.stderr, /ruleLiteralFiles/, "⑤ stderr 必须点名缺失字段");
assert.match(r5.stderr, /--update/, "⑤ stderr 必须指向 --update");

console.log("dualtrack 判据 D（规则号字面量）：18 项断言通过（五模式红 / 删除绿 / 注释豁免 / 缺维度 fail-closed）");
