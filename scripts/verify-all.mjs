// verify-all.mjs - 交付前体检报告（2026-08-26，对齐官方 docs/testing.zh.md 分层验证；0.5.9 增第⑤层；0.5.11 增第⑥层）。
// 六层：① 语法（lib 全部 .js node --check）
//       ② 单元（test/run-all.mjs——单元+机制层，不含 e2e）
//       ③ 组合冒烟（test/loader-smoke.e2e.mjs——真实接线 + 外部世界断言）
//       ④ 真实判例（外部世界：近 24h 台账中 judge-pass/judge-false 记录数；
//          0 条 = WARN 提示需实弹，≥1 条 = 有真实裁决证据——读文件，不是自我报告）
//       ⑤ 工具箱覆盖（scripts/check-tool-coverage.mjs——官方 tool-catalog 全集 vs 分类表，
//          任何 unknown = 未知工具首调处置会拦用户 → 红色（run_code 事故同类，K-01/K-06 门禁））
//       ⑥ 变更工具守卫链覆盖（test/guardchain-coverage.test.mjs——规则 24④ 机器执行，
//          跨工具一致性测试：每个写/删/移工具在问句回合+无授权场景跑真实 guardDecision，
//          断言被拦或属豁免面——静默逃逸 = 红；工具名非安全边界，裁决链才是（K-04））
// 任一 ❌ → exit 1；⚠️（WARN）不阻塞但必须明示。
// 注意：子进程输出捕获需完整权限运行（受限模式 EPERM）。
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lines = [];

function step(name, cmd, args) {
  try {
    const out = execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    lines.push(`✅ ${name}`);
    return out;
  } catch (e) {
    lines.push(`❌ ${name}`);
    lines.push(String(e.stdout || e.stderr || e.message).slice(-500));
    return null;
  }
}

// ── ① 语法 ──
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.js$/.test(f)) files.push(p);
  }
})(join(root, "lib"));
let sOk = true;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { cwd: root, stdio: "pipe", encoding: "utf8" });
  } catch (e) {
    sOk = false;
    lines.push(`❌ 语法 ${f}`);
    lines.push(String(e.stderr || e.message).slice(-300));
  }
}
if (sOk) lines.push(`✅ 语法（${files.length} 个 lib 文件）`);

// ── ② 单元 ──
step("单元（test/run-all.mjs）", process.execPath, [join(root, "test", "run-all.mjs")]);

// ── ③ 组合冒烟 ──
step("组合冒烟（loader-smoke，真实接线+外部世界断言）", process.execPath, [join(root, "test", "loader-smoke.e2e.mjs")]);

// ── ⑤ 工具箱覆盖（0.5.9 门禁；0.6.0 B2′：素材经 CHECK_TOOL_CATALOG/--catalog 提供，缺素材=FAIL 含获取方式——
//    本机运行请设 CHECK_TOOL_CATALOG=D:\...\docs\docs-site-text\...；发布物内不硬编码任何本机路径） ──
step("工具箱覆盖（官方 tool-catalog vs 分类表，缺失即红）", process.execPath, [join(root, "scripts", "check-tool-coverage.mjs")]);

// ── ⑥ 变更工具守卫链覆盖（0.5.11 规则 24④ 跨工具一致性门禁） ──
step("变更工具守卫链覆盖（写/删/移工具问句回合不静默逃逸）", process.execPath, [join(root, "test", "guardchain-coverage.test.mjs")]);

// ── ⑦ 关联一致性门禁（0.5.11，用户定稿：验收 = 改动关联产物全做一遍，机器强制） ──
// ① test/*.test.mjs 全部被 run-all.mjs 收录（新增测试漏收录 = 红——guardchain 曾漏收）
// ② README 徽章版本 = package.json 版本（版本成对）
// ③ 文档：README/手册提及的"引擎已做"核心行为在 lib 中有落点（关键词级抽样，防"只写文档没实现"）
let assocFail = [];
{
  try {
    const runAllText = readFileSync(join(root, "test", "run-all.mjs"), "utf8");
    const testFiles = readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.mjs"));
    for (const f of testFiles) {
      if (!runAllText.includes(f)) assocFail.push(`测试未收录 run-all.mjs：${f}`);
    }
  } catch (e) { assocFail.push(`run-all 收录检查失败：${e.message}`); }
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const readme = readFileSync(join(root, "README.md"), "utf8");
    // 版本成对支持 -pre/-rc 后缀（工作区未发布代号如 0.5.11-pre；badge URL 编码 --pre）
    const badge = readme.match(/version-([0-9.]+)(--pre|-pre)?-blue/);
    const badgeVer = badge ? badge[1] + (badge[2] ? "-pre" : "") : null;
    if (!badgeVer || badgeVer !== pkg.version) assocFail.push(`版本成对失败：package.json=${pkg.version} vs README badge=${badgeVer || "?"}`);
  } catch (e) { assocFail.push(`版本成对检查失败：${e.message}`); }
  // ③ 关键词落点：引擎宣称的六大能力，lib 中各有引用（防"文档说了、代码没做"）
  try {
    const libText = readdirSync(join(root, "lib/core")).join(",");
    const mustHave = ["tool-catalog", "lexicon", "guard-core", "intent", "authorization"];
    for (const m of mustHave) {
      if (!libText.includes(m + ".js")) assocFail.push(`核心落点缺失：lib/core/${m}.js`);
    }
  } catch (e) { assocFail.push(`核心落点检查失败：${e.message}`); }
}
if (assocFail.length > 0) {
  for (const a of assocFail) lines.push(`❌ 关联一致性：${a}`);
} else {
  lines.push("✅ 关联一致性（测试全部收录 / 版本成对 / 核心能力有落点）");
}

// ── ④ 真实判例（外部世界） ──
let judgeReal = 0;
const auditPath = join(process.env.DSH_HOME || join(process.env.USERPROFILE || "", ".dsh"), "rule-engine.log.jsonl");
const since = Date.now() - 24 * 3600 * 1000;
try {
  for (const line of readFileSync(auditPath, "utf8").split("\n")) {
    if (!line.includes("judge-pass") && !line.includes("judge-false")) continue;
    const m = line.match(/"ts":"([^"]+)"/);
    if (m && new Date(m[1]).getTime() >= since) judgeReal++;
  }
} catch {
  // 无日志：提示即可
}
if (judgeReal > 0) {
  lines.push(`✅ 真实判例（近 24h judge-pass/judge-false = ${judgeReal} 条——裁决器真实工作证据）`);
} else {
  lines.push("⚠️ 真实判例：近 24h 无 judge-pass/judge-false 记录——裁决器需要一次实弹（非阻塞 WARN，但说明运行证据尚未产生）");
}

// ── ⑧ 发布适用性门禁（T6，2026-08-31：通用化"陌生人视角"硬闸）──
// 无 AGENTS.md 冷启动 / 空白规则静默 / 任意编号规则声明式绑定 / 格式契约冒烟 / 个人标识扫描
step("发布适用性门禁（无 AGENTS.md 冷启动 / 空白规则 / 任意编号 / 个人标识扫描）", process.execPath, [join(root, "scripts", "publish-aptitude-check.mjs")]);

// ── ⑨ 发布门禁 B1（阶段 B，2026-09-04：README 版本四性一致性）──
step("发布门禁 B1（README 版本四性一致性：package.json/徽章/正文/历史表/固定源）", process.execPath, [join(root, "scripts", "readme-version-check.mjs")]);

// ── ⑩ 发布门禁 B2（阶段 B，2026-09-04：lib/ 本机痕迹扫描，词表唯一源）──
step("发布门禁 B2（lib/ 本机痕迹扫描——词表唯一源，命中即红）", process.execPath, [join(root, "scripts", "local-residue-scan.mjs")]);

// ── ⑪ 存在性扫描（泄露预防，2026-09-05：真实路径判据——REAL_PATHS_SCAN 指向扫描器，0 命中才算过；
//    未设置=WARN（本机增强门禁，通用环境无此工具）──
{
  const scanReal = process.env.REAL_PATHS_SCAN;
  if (scanReal) {
    step("存在性扫描（真实路径判据，0 命中红线）", process.execPath, [scanReal, "--root", root]);
  } else {
    lines.push("⚠️ 存在性扫描：未设置 REAL_PATHS_SCAN（本机增强门禁；发布流水线建议设置）");
  }
}

console.log(lines.join("\n"));
const failed = lines.filter((l) => l.startsWith("❌"));
if (failed.length) {
  console.log(`\nVERIFY FAIL：${failed.length} 项问题，见上`);
  process.exit(1);
}
console.log("\nVERIFY ALL OK");
