// dualtrack-init-guard.test.mjs - dualtrack --init 覆盖保护（第三批第 1 波收尾，2026-09-09）
//
// 背景：第三方意见「基线不进包 → README 加一句首次用 --init」在落地时发现——
//   ① 基线其实已进 git（clone 用户不需要 --init）；
//   ② --init 原本无覆盖保护（只有 --update 有「基线不存在则拒」），照原话写进 README 会让
//      clone 用户把当前计数覆盖为基线、**棘轮当场失效**。
// 故补对称保护，并以本测试锁定：有基线时 --init 必须拒绝且零改写。
//
// 与机器配置解耦：临时 DSH_HOME（不读本机 rule-engine.json）+ 临时词表文件（DUALTRACK_MARKERS）。
// 子进程 CLI 断言，不 import index.js（ESM 缓存无关）——固定放 run-all 末尾。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "dualtrack-check.mjs");
const BASELINE = join(ROOT, "scripts", "dualtrack-baseline.json");

// 隔离环境：临时 home + 临时词表（内容为不存在的探针串，保证残留计数恒为 0）
const home = mkdtempSync(join(tmpdir(), "dsh-re-dt-init-"));
const markerFile = join(home, "markers.txt");
writeFileSync(markerFile, "# dualtrack-init-guard 探针词表\n__dualtrack_probe_marker_never_matches__\n", "utf8");
const env = { ...process.env, DSH_HOME: home, DUALTRACK_MARKERS: markerFile };

if (!existsSync(BASELINE)) {
  // 首次场景（基线缺失时 --init 生成）不在单测范围：脚本 BASELINE_FILE 固定在仓库根，无法重定向。
  console.log("SKIP: 基线不存在——--init 生成路径属首次场景，本测试只锁「有基线时拒绝」");
} else {
  const before = readFileSync(BASELINE, "utf8");
  const r = spawnSync(process.execPath, [SCRIPT, "--init"], { cwd: ROOT, encoding: "utf8", env });

  assert.equal(r.status, 1, "--init 遇已有基线必须拒绝（exit 1）");
  assert.match(r.stderr, /REFUSED/, "stderr 必须含 REFUSED");
  assert.match(r.stderr, /基线已存在/, "stderr 必须说明拒绝原因（基线已存在）");
  assert.match(r.stderr, /--update/, "stderr 必须指向替代通道 --update");
  assert.doesNotMatch(r.stdout, /INITIALIZED/, "拒绝路径不得输出 INITIALIZED");

  const after = readFileSync(BASELINE, "utf8");
  assert.equal(after, before, "--init 被拒后基线必须零改写（否则棘轮失效）");

  // 对照组：无参数默认比对仍应正常执行（不因新增保护而误伤正常路径）
  const ok = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8", env });
  assert.equal(ok.status, 0, `默认比对应 exit 0（实际 ${ok.status}：${ok.stderr || ok.stdout}）`);
  assert.match(ok.stdout, /DUALTRACK OK/, "默认比对应输出 DUALTRACK OK");

  console.log("dualtrack --init 覆盖保护：6 断言通过（拒绝 + 零改写 + 默认路径不误伤）");
}
