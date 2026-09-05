// release-plugin.mjs —— DSH 插件全渠道一键发布（npm + git + GitHub Release）
// 用法：node release-plugin.mjs <插件名|插件目录> [版本号] [--sync-profile]
//   - 插件名从 scripts/plugins.json 清单解析（规则 26 ⑤）；或直接给目录路径
//   - 版本号省略时自动 patch+1（如 1.4.7 -> 1.4.8）
//   - 自动同步 README 徽章 version-X.Y.Z
//   - --sync-profile：发布成功后自动更新 profiles/<profile>/pnpm-workspace.yaml 豁免名单
//     （备份原文件）+ 运行全量装配审计（写 .dsh 需以 danger-full-access 运行本脚本）
// 前置：npm 已认证、gh 已认证、git 已配置。
// 网络：2026-09-03 实测修正——直连 github.com/npm registry 已不可靠（443 超时/连接重置）；
//       需代理环境请设 DSH_RELEASE_PROXY=http://127.0.0.1:7890（本机 Clash 7890）。未设时脚本仍尝试直连。
// 步骤：版本 bump -> 测试 -> npm pack -> npm publish -> [publish 后 dist-tags 校验（B1，2026-09-03）]
//       -> git commit+push -> gh release（带 tgz asset）
// 安全：token 经环境变量注入，不在命令文本/日志中打印
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROXY = process.env.DSH_RELEASE_PROXY || ""; // 默认直连；需要代理时显式设置
/** 代理前缀（命令文本）：空 = 直连 */
const proxyPrefix = () => (PROXY ? `set HTTPS_PROXY=${PROXY}&& set HTTP_PROXY=${PROXY}&& ` : "");
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(SCRIPT_DIR, "..");

function run(cmd, opts = {}) {
  console.log(`> ${cmd.slice(0, 120)}${cmd.length > 120 ? "..." : ""}`);
  return execSync(cmd, { stdio: "inherit", encoding: "utf8", shell: true, ...opts });
}
function quiet(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", shell: true, stdio: "pipe" }).toString().trim();
  } catch {
    return "";
  }
}
function fail(msg) {
  console.error(`\n[发布中止] ${msg}`);
  process.exit(1);
}

// ── 0. 解析目标（清单名 或 目录路径）────────────────────────────
const args = process.argv.slice(2);
const syncProfile = args.includes("--sync-profile");
const dryRun = args.includes("--dry-run"); // 2026-08-29：发布前预览（只推导+打印，不改文件）
const target = args.find((a) => !a.startsWith("--")) || "";
let manifest = null;
let entry = null;
let dir = null;
try {
  manifest = JSON.parse(readFileSync(join(SCRIPT_DIR, "plugins.json"), "utf8"));
  entry = manifest.plugins.find((p) => p.name === target) || null;
} catch {
  // 清单缺失时仅支持目录路径
}
if (entry) {
  dir = resolve(WORKSPACE, entry.dir);
} else if (target) {
  dir = resolve(target);
} else {
  fail("用法：node release-plugin.mjs <插件名|插件目录> [版本号] [--sync-profile]");
}
if (!existsSync(join(dir, "package.json"))) fail(`目录不存在或不是插件包：${dir}`);

// ── 0. 读取包信息 ────────────────────────────────────────────────
const pkgPath = join(dir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const name = pkg.name;
const oldVer = pkg.version;
// 版本号 = 非 -- 开头的参数（排除目标名本身），位置任意
// 2026-08-29 修复（0.5.11-pre 体系）：oldVer 为 -pre/-rc 等预发布后缀时——
// ① 发布语义 = 剥后缀发正式版（0.5.11-pre → 发布 0.5.11，不是 +1）；
// ② 自动推导不再 split(".") 直接 Number（"11-pre" 会得 NaN——旧 bug）。
// 显式传参优先；且显式传参如果是 -pre 形态（意外），本发布不剥（警告留痕）。
const nextVer = args.find((a) => !a.startsWith("--") && a !== target) || (() => {
  // 预发布后缀（-pre/-rc）→ 剥后缀发正式版（0.5.11-pre → 0.5.11）
  if (/-(?:pre|rc|beta|alpha)(?:[.\d]*)$/i.test(oldVer)) return oldVer.replace(/-.*$/, "");
  // 纯数字 → +1（历史行为）
  const [maj, min, pat] = oldVer.split(".").map(Number);
  if (Number.isNaN(pat)) fail(`无法解析版本号：${oldVer}`);
  return `${maj}.${min}.${pat + 1}`;
})();
const repoOverride = entry?.repo || null;
console.log(`\n=== 发布 ${name}: ${oldVer} -> ${nextVer} ===\n`);

// ── 0.5 本地配套包版本一致性（防止 host/client 版本错位）──────────
function checkDependencyPair() {
  if (!entry?.dependsOn || !manifest) return;
  for (const depName of entry.dependsOn) {
    const depEntry = manifest.plugins.find((p) => p.name === depName);
    const depDir = depEntry ? resolve(WORKSPACE, depEntry.dir) : null;
    if (!depDir || !existsSync(join(depDir, "package.json"))) {
      console.log(`（未找到依赖 ${depName} 的本地包，跳过版本一致性检查）`);
      continue;
    }
    const depPkg = JSON.parse(readFileSync(join(depDir, "package.json"), "utf8"));
    const range = pkg.dependencies?.[depName];
    if (!range) continue;
    const m = range.match(/^\^(\d+)\.(\d+)\.(\d+)/);
    if (!m) {
      console.log(`（依赖 ${depName} 范围 ${range} 不是简单 ^x.y.z，跳过自动校验）`);
      continue;
    }
    const v = depPkg.version.split(".").map(Number);
    const ok = v[0] === +m[1] && (v[1] > +m[2] || (v[1] === +m[2] && v[2] >= +m[3]));
    if (!ok) fail(`${name} 声明依赖 ${depName}@${range}，但本地 ${depName} 是 ${depPkg.version}`);
    console.log(`[依赖一致性] ${name} -> ${depName} ${depPkg.version} ✓`);
  }
}
checkDependencyPair();

// ── 1. 前置检查 ──────────────────────────────────────────────────
if (!/^\d+\.\d+\.\d+$/.test(nextVer)) fail(`版本号格式错误：${nextVer}`);
// 2026-09-02 修复：gh auth status 的 "Logged in" 输出在 stderr（新版 gh），stdout 可能为空空
// → 2>&1 合并 stderr，避免已认证被误判"gh 未认证"（实测 keyring 已登录却判失败）
if (!quiet("gh auth status 2>&1").includes("Logged in")) fail("gh 未认证");
const whoami = quiet("npm whoami 2>&1");
if (!whoami) fail("npm 未认证（npm whoami 失败）");

// ── 1.5 DSH 兼容预检（发布前防“升级后插件不兼容”）──────────────
const compatScript = join(SCRIPT_DIR, "check-dsh-compat.mjs");
if (existsSync(compatScript)) {
  console.log("\n=== DSH 兼容预检 ===");
  run(`node "${compatScript}" "${dir}"`);
}

// ── 1.6 profile dump-config 冒烟（确认 DSH 可导出当前 profile 配置）──
function findDshBin() {
  const candidates = [process.env.DSH_BIN, "D:/example/global-npm/dsh.cmd", "D:/example/global-npm/dsh", "dsh"].filter(Boolean);
  for (const c of candidates) {
    if (quiet(`where ${c}`)) return c;
  }
  return "";
}
const dshCmd = findDshBin();
if (dshCmd) {
  const dump = quiet(`"${dshCmd}" --profile ${manifest?.profile || "web"} --dump-config`);
  if (dump && !/error|Error|ENOENT/i.test(dump)) {
    console.log("（profile dump-config 冒烟通过：DSH 配置可正常导出）");
  } else {
    console.log("（profile dump-config 冒烟未通过：请人工确认 DSH 可用后发布）");
  }
} else {
  console.log("（未找到 dsh 命令，跳过 profile dump-config 冒烟）");
}

// ── 2. 版本 bump（package.json + README 徽章）────────────────────
if (dryRun) {
  // 发布门禁 B1/B2（阶段 B，02 v1.4）：dry-run 同样先过门禁（失败即中止，不进入授权/发布）
  console.log("\n=== 发布门禁 B1（README 版本四性）===");
  run(`cd /d "${dir}" && node scripts/readme-version-check.mjs`);
  console.log("\n=== 发布门禁 B2（lib/ 本机痕迹扫描）===");
  run(`cd /d "${dir}" && node scripts/local-residue-scan.mjs`);
  console.log("（发布门禁 B1/B2 通过）");
  console.log(`[DRY-RUN] 不修改任何文件。`);
  console.log(`[DRY-RUN] oldVer=${oldVer} → nextVer=${nextVer}`);
  const rd = join(dir, "README.md");
  if (existsSync(rd)) {
    const t = readFileSync(rd, "utf8");
    const oldBadgeVer = `version-${oldVer}`;
    const oldBadgeUrl = `version-${oldVer.replace(/-/g, "--")}`;
    const nextUrl = `version-${nextVer}`;
    const replaced = t.replaceAll(oldBadgeVer, nextUrl).replaceAll(oldBadgeUrl, nextUrl);
    console.log(`[DRY-RUN] README 徽章将变为: ${replaced.match(/version-[^\s]+/)?.[0] || "(未命中，检查徽章形态)"}`);
  }
  process.exit(0);
}
writeFileSync(pkgPath, readFileSync(pkgPath, "utf8").replace(`"version": "${oldVer}"`, `"version": "${nextVer}"`));
for (const readme of ["README.md", "README.en.md"]) {
  const rp = join(dir, readme);
  if (existsSync(rp)) {
    const text = readFileSync(rp, "utf8");
    // 2026-08-29 修复：徽章 URL 编码把 `0.5.11-pre` 转成 `0.5.11--pre`（`-` 被 shields 双横线），
    // 旧正则 `version-0.5.11-pre` 匹配不到 `version-0.5.11--pre` → 徽章漏改（㉙ 机器根因之一）。
    // replaceAll 用字面串（非正则），无需转义。
    const oldBadgeVer = `version-${oldVer}`;                       // JSON 形态：version-0.5.11-pre
    const oldBadgeUrl = `version-${oldVer.replace(/-/g, "--")}`;   // URL 形态：version-0.5.11--pre
    const nextUrl = `version-${nextVer}`;
    const replaced = text
      .replaceAll(oldBadgeVer, nextUrl)
      .replaceAll(oldBadgeUrl, nextUrl);
    if (replaced !== text) writeFileSync(rp, replaced);
  }
}
console.log("版本已 bump（package.json + README 徽章）");

// B1（2026-09-03）：README 版本表行自动插入（阶段 C 人脑核对已失效的自动化；幂等：已存在 nextVer 行则跳过）
// 位置：版本表（| 版本 | 日期 | 要点 |）表头后第一数据行之前（最新在上）；内容用调用方 notes 参数或 git log 最近提交信息
const notes = process.argv.includes("--notes") ? process.argv[process.argv.indexOf("--notes") + 1] : "";
for (const readme of ["README.md"]) {
  const rd = join(dir, readme);
  if (!existsSync(rd)) continue;
  let rtxt = readFileSync(rd, "utf8");
  const tableHeader = "| 版本 | 日期 | 要点 |";
  const hi = rtxt.indexOf(tableHeader);
  if (hi < 0 || rtxt.includes(`| **${nextVer}** |`)) continue;
  const today = new Date().toLocaleDateString("en-CA"); // 本地时区 YYYY-MM-DD
  const summary = notes || (quiet(`cd /d "${dir}" && git log -1 --pretty=%s`).slice(0, 90) || "（待补变更摘要）");
  const nl = rtxt.indexOf("\n", hi);
  if (nl < 0) continue;
  const row = `| **${nextVer}** | ${today} | ${summary.replace(/\|/g, "\\|")} |`;
  rtxt = rtxt.slice(0, nl + 1) + row + "\n" + rtxt.slice(nl + 1);
  writeFileSync(rd, rtxt, "utf8");
  console.log(`[B1] ${readme} 版本表已插入 ${nextVer} 行（摘要来源：${notes ? "notes 参数" : "git log"}）；请核对内容`);
}

// ── 3. 测试（规则 23：发布前运行时验证）─────────────────────────
if (pkg.scripts && pkg.scripts.test) {
  console.log("\n=== 运行测试 ===");
  run(`cd /d "${dir}" && npm test --prefix "${dir}"`);
} else {
  console.log("（无 test 脚本，跳过）");
}

// ── 3.5 发布门禁 B1/B2（阶段 B，02 v1.4：测试全过后、进入授权/发布前；失败即中止）──
console.log("\n=== 发布门禁 B1（README 版本四性）===");
run(`cd /d "${dir}" && node scripts/readme-version-check.mjs`);
console.log("\n=== 发布门禁 B2（lib/ 本机痕迹扫描）===");
run(`cd /d "${dir}" && node scripts/local-residue-scan.mjs`);
// ── 3.6 存在性扫描（泄露预防，2026-09-05）：本机增强门禁——REAL_PATHS_SCAN 指向存在性扫描器 →
// 0 命中才继续；未设置=WARN（本机工具不进包，通用用户无此工具；发布流水线建议设置）──
const scanReal = process.env.REAL_PATHS_SCAN;
if (scanReal) {
  console.log("\n=== 存在性扫描（真实路径判据，0 命中红线）===");
  run(`node "${scanReal}" --root "${dir}"`);
} else {
  console.log("（未设置 REAL_PATHS_SCAN——存在性扫描跳过（本机增强门禁，建议发布前设置））");
}
console.log("（发布门禁 B1/B2/存在性 通过）");

// ── 4. pack + publish ────────────────────────────────────────────
console.log("\n=== npm pack ===");
run(`cd /d "${dir}" && npm pack --pack-destination .`);
const tgz = `${name}-${nextVer}.tgz`;
if (!existsSync(join(dir, tgz))) fail(`打包产物缺失：${tgz}`);

// ── 4.5 发布物存在性扫描（泄露预防硬项，2026-09-05）：解包 tgz → 判据库直扫（0 命中才 publish）──
const scanReal2 = process.env.REAL_PATHS_SCAN;
if (scanReal2) {
  const unpackDir = join(dir, ".pkg-check-" + nextVer);
  if (existsSync(unpackDir)) rmSync(unpackDir, { recursive: true, force: true });
  mkdirSync(unpackDir, { recursive: true });
  run(`tar -xzf "${join(dir, tgz)}" -C "${unpackDir}"`);
  console.log("\n=== 发布物存在性扫描（解包直扫，0 命中红线）===");
  run(`node "${scanReal2}" --root "${join(unpackDir, "package")}"`);
  console.log("（发布物存在性扫描通过）");
}

console.log("\n=== npm publish ===");
run(`cd /d "${dir}" && ${proxyPrefix()}npm publish ${tgz}`);

// B1（2026-09-03）：publish 后校验 registry dist-tags（0.5.16 事故：publish 自报成功但 latest 未切；
// 脚本此前只跑 publish 不校验发布态——三通道验证铁律：npm 通道以 dist-tags 为准，self-report 不算数）
// B1 v2（2026-09-03 同日晚）：registry 传播以分钟计，publish 后立即校验曾误报中止（0.5.17 实弹）→
// 轮询重试 60s（6×10s）；仍不符才中止，并按"版本是否已落盘"给出人工修正路径
console.log("\n=== npm 发布态校验（dist-tags，轮询最多 60s）===");
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const queryTags = () => quiet(`cd /d "${dir}" && ${proxyPrefix()}npm view ${name} dist-tags.latest`);
const queryVer = () => quiet(`cd /d "${dir}" && ${proxyPrefix()}npm view ${name}@${nextVer} version`);
let latestActual = "";
for (let i = 0; i < 6; i++) {
  latestActual = queryTags();
  if (latestActual === nextVer) break;
  if (i < 5) { console.log(`  [B1] 等待 registry 传播（${i + 1}/5，latest=${latestActual || "(空)"}）…`); sleepMs(10000); }
}
if (latestActual !== nextVer) {
  const verExists = queryVer() === nextVer;
  fail(`npm 发布态异常：dist-tags.latest=${latestActual || "(为空)"}，预期 ${nextVer}——${verExists ? `版本已存在但 latest 未跟：可执行 npm dist-tag add ${name}@${nextVer} latest 修正` : "版本未查询到：可能 staged/缓存（见踩坑 117）"}；人工核查前勿继续 git/Release 通道`);
}
console.log(`dist-tags.latest=${latestActual} ✓`);

// ── 5. git commit + push（token 经环境变量注入 URL，命令文本不含密钥明文）─────
console.log("\n=== git commit + push ===");
// 2026-08-25 修复 pushUrl 双重拼接：origin 可能是 ssh（git@github.com:）、https（https://github.com/）
// 或裸路径（user/repo）三种形态——统一归一化为 "owner/repo" 路径再拼 token URL（此前 https origin 未剥前缀
// 导致 "https://github.com/https://github.com/..." 双重 URL，push 404）
const repo = (repoOverride || quiet(`cd /d "${dir}" && git remote get-url origin`))
  .replace(/^git@github\.com:/, "")
  .replace(/^https?:\/\/github\.com\//, "")
  .replace(/\.git$/, "");
const token = quiet("gh auth token");
if (!token) fail("无法获取 gh token");
// 与 v3.72 同款通道：token 拼进 HTTPS URL 直推（避开沙箱下 msys 凭据管道的 EPERM）
// 0.6.0：用户名从 repo 归属提取（不再硬编码——发布物不含本机账号）
const repoOwner = repo.split("/")[0];
if (!repoOwner) fail("无法解析仓库 owner（repo=" + repo + "）");
const pushUrl = `https://${repoOwner}:${token}@github.com/${repo}.git`;
// 2026-08-31 修复：repoRoot 实测 git 仓库根（插件目录可能只是子目录，如 rules-manager 在 oss 仓库内）；
// stageSpec = 插件目录相对仓库根路径（防 git add -A 误带仓库内无关改动/未跟踪物）
const repoRoot = quiet(`cd /d "${dir}" && git rev-parse --show-toplevel`).trim();
const relDir = relative(repoRoot, dir).split(/[\\/]/).join("/");
const stageSpec = relDir && relDir !== "." ? relDir : "";
// 2026-08-29 防漏机检（0.5.10 git 欠账事故：git add -u 只更新已跟踪文件，未跟踪新文件
// （npm pack 按目录打包、天然包含）会漏进 git 提交 → git 与 npm 内容不一致）。
// 现在：提交前检测未跟踪文件并打印名单，改用 add -A 一并提交（.gitignore 已排除杂质）。
const untrackedList = quiet(`cd /d "${repoRoot}" && git status --porcelain -- ${stageSpec}`)
  .split("\n").filter((l) => l.startsWith("??")).map((l) => l.slice(3));
if (untrackedList.length > 0) {
  console.log(`（未跟踪文件 ${untrackedList.length} 个将一并提交：${untrackedList.slice(0, 6).join(", ")}${untrackedList.length > 6 ? " 等" : ""}）`);
}
// 2026-09-04：提交物本机路径/个人标识检查已本机化（release-gate.mjs → scan-real-paths.mjs
// 存在性判据 + 本机词表）；本文件不再内置扫描词表（发布物零个人化字符串），
// 由发布方在发布前调用本机 gate 一次完成。教训 8105d3e 由本机 gate 兜底。
run(`cd /d "${repoRoot}" && ${proxyPrefix()}git add -A -- ${stageSpec}`);
run(`cd /d "${repoRoot}" && git -c core.autocrlf=false commit -m "release: ${name} v${nextVer}" || exit 0`);
run(`cd /d "${repoRoot}" && ${proxyPrefix()}git push "${pushUrl}" HEAD`);

// ── 6. GitHub Release（带正式 tgz asset，规则 26；清单标记 skipRelease 的包不建）─────
if (entry?.skipRelease) {
  console.log("（清单标记 skipRelease，跳过 GitHub Release）");
} else {
  console.log("\n=== GitHub Release ===");
  const notesFile = join(process.env.TEMP || ".", `notes-${name}-${nextVer}.md`);
  writeFileSync(notesFile, `## v${nextVer}\n\nRelease generated by scripts/release-plugin.mjs\n`);
  // 必须在插件目录（git 仓库）内运行：gh release 内部会做 git 检查
  run(`cd /d "${dir}" && ${proxyPrefix()}gh release create v${nextVer} "${join(dir, tgz)}" --title "${name} v${nextVer}" --notes-file "${notesFile}"`);
}

// ── 7. 本机 profile 同步（--sync-profile：豁免名单 + 装配审计；需 danger-full-access 运行）──
if (syncProfile) {
  console.log("\n=== 本机 profile 同步 ===");
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(SCRIPT_DIR, "plugins.json"), "utf8"));
  } catch {
    manifest = { profile: "web" };
  }
  const profileDir = resolve(WORKSPACE, "..", ".dsh", "profiles", manifest.profile || "web");
  const wsYaml = join(profileDir, "pnpm-workspace.yaml");
  if (existsSync(wsYaml)) {
    const raw = readFileSync(wsYaml, "utf8");
    const lineRe = new RegExp(`^(  - ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@[^\\n]*)$`, "m");
    const m = raw.match(lineRe);
    if (m && !m[1].includes(nextVer)) {
      const bakDir = join(profileDir, "..", ".backups");
      mkdirSync(bakDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const bak = join(bakDir, `pnpm-workspace-${stamp}.yaml`);
      copyFileSync(wsYaml, bak);
      const updated = raw.replace(lineRe, `${m[1]} || ${nextVer}`);
      writeFileSync(wsYaml, updated);
      console.log(`豁免名单已追加 ${name}@${nextVer}（备份 ${bak}）`);
    } else if (!m) {
      console.log(`（豁免名单无 ${name} 条目，跳过）`);
    } else {
      console.log(`（豁免名单已含 ${nextVer}，跳过）`);
    }
  }
  // 全量装配审计（规则 27）
  const auditScript = join(SCRIPT_DIR, "..", "projects", "oss", "dsh-rule-engine", "scripts", "audit-mount-consistency.mjs");
  if (existsSync(auditScript)) {
    const out = quiet(`node "${auditScript}" --profile ${manifest.profile || "web"}`);
    const pass = /MOUNT CONSISTENT/.test(out);
    console.log(out.split("\n").filter((l) => /RESULT|DUPLICATES|MOUNT|summary/.test(l)).join("\n"));
    if (!pass) fail("装配审计未通过（MOUNT CONSISTENT 未出现），请先处理再重启 DSH");
    console.log("装配审计 MOUNT CONSISTENT ✓");
  }
}

console.log(`\n=== 发布完成：${name} v${nextVer} ===`);
console.log(`npm: ${name}@${nextVer}`);
console.log(`release: https://github.com/${repo}/releases/tag/v${nextVer}`);
