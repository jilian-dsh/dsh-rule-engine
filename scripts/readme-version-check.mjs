#!/usr/bin/env node
// readme-version-check.mjs — README 版本四性一致性门禁
// 检查：package.json version == README 徽章 == README 正文"当前版本 X" == 版本历史表含当前版本 == 发行固定源锚定当前版本
// 用法：node scripts/readme-version-check.mjs   （在包根目录运行；exit 0 = 一致，exit 1 = 不一致）

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");
const ver = pkg.version;

let failures = [];
const ok = (cond, label, detail) => {
  if (cond) console.log(`PASS  ${label}`);
  else { failures.push(label); console.log(`FAIL  ${label} — ${detail}`); }
};

// 1. 徽章：badge/version-X.Y.Z
const badge = readme.match(/badge\/version-(\d+\.\d+\.\d+)/);
ok(badge?.[1] === ver, "徽章=package.json", `徽章=${badge?.[1] ?? "未找到"} vs package=${ver}`);

// 2. 正文"当前版本 X"（允许"当前版本 **X**"）
const cur = readme.match(/当前版本[^\d]{0,10}(\d+\.\d+\.\d+)/);
ok(cur?.[1] === ver, "正文当前版本=package.json", `正文=${cur?.[1] ?? "未找到"} vs package=${ver}`);

// 3. 版本历史表包含当前版本行：| **X.Y.Z** | 或 | X.Y.Z |
const tableHit = new RegExp(`^\\|\\s*\\*{0,2}${ver.replace(/\./g, "\\.")}\\*{0,2}\\s*\\|`, "m").test(readme);
ok(tableHit, "版本历史表含当前版本行", `未找到 | ${ver} | 行`);

// 4. 发行固定源锚定当前版本："**X（当前）**" 或 "X.Y.Z（当前）"
const pin = readme.match(/\*\*(\d+\.\d+\.\d+)（当前）\*\*/);
ok(pin?.[1] === ver, "发行固定源=package.json", `固定源=${pin?.[1] ?? "未找到"} vs package=${ver}`);

if (failures.length) {
  console.error(`\nVERSION CHECK FAILED（${failures.length} 项不一致）`);
  process.exit(1);
}
console.log(`\nVERSION CHECK OK（${ver} 四处一致）`);
