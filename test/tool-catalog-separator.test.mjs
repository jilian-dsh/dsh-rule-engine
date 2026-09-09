// tool-catalog-separator.test.mjs - 工具目录分隔符兼容（第三批第 1 波收尾，2026-09-09）
//
// 背景：check-tool-coverage.mjs 解析官方 tool-catalog.txt 的「模型可见名称」列时，
// 曾只按英文逗号 `,` 分割；而中文版文档用顿号「、」分隔多工具名，整串因此被
// /^[A-Za-z_][A-Za-z0-9_:.-]*$/ 判为非法而丢弃 → 59 个工具名只剩 11 个，
// 且 missing 为空仍打印 COVERAGE-OK（**静默弱化**，门禁形同虚设）。
// 本测试用内联临时 catalog 锁定两种分隔符都解析到位（不依赖本机文档产物）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "check-tool-coverage.mjs");

const dir = mkdtempSync(join(tmpdir(), "dsh-re-catalog-"));
const catalog = join(dir, "tool-catalog.txt");
writeFileSync(catalog, [
  // 中文文档形态：顿号分隔多工具名
  "| | @deepseek-ai/dsh-tool-cordis | cordis_define 、 cordis_run 、 cordis_stop | ctx.tools | tool/call | - | 顿号样例 |",
  // 中文文档形态：顿号分隔两个名字
  "| | @deepseek-ai/dsh-tool-fs | read 、 write | ctx.fs | tool/call | - | 顿号样例 |",
  // 英文文档形态：单名（对照组）
  "| | @deepseek-ai/dsh-tool-ask-user | ask_user_question | ctx.tools | tool/call | - | 单名样例 |",
  // 非工具行（应被忽略）
  "| | @deepseek-ai/dsh-tool-bash | - | ctx.shell | tool/call | - | 名称列为空 |"
].join("\n") + "\n", "utf8");

const r = spawnSync(process.execPath, [SCRIPT, "--catalog", catalog], { cwd: ROOT, encoding: "utf8" });

assert.equal(r.status, 0, `覆盖门禁应通过（实际 exit=${r.status}）：${r.stderr}`);
// 修复前：顿号整串被丢弃 → 只解析出 ask_user_question（1 个）
assert.match(
  r.stdout,
  /COVERAGE-OK：官方 tool-catalog 工具全覆盖（6 个工具名/,
  "顿号分隔的工具名必须全部计入（cordis_define/cordis_run/cordis_stop/read/write/ask_user_question = 6）"
);

console.log("tool-catalog 分隔符兼容：顿号/逗号双形态解析通过（6 个工具名）");
