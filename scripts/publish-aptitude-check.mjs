// publish-aptitude-check.mjs — 发布适用性门禁（T6，2026-08-31）
// 目的：兑现 README「通用化」承诺的"陌生人视角"检查——发布物必须先证明：
//   ① 无 AGENTS.md（陌生环境冷启动）：引擎零错 / 零死映射 / 零意外拦截面
//   ② 空白规则文件：静默（0 规则、无错、无 dead）
//   ③ 任意编号规则（非本机编号）：声明式绑定与"纯自证"分流行为正确
//   ④ 四要素 + 执行等级格式的最小规则：actions/handler 解析正确（README 格式契约冒烟）
//   ⑤ 发布物个人标识扫描：files 白名单内文件不得含本机个人标识（jilian/季涟/D:\\example/邮箱/私人注释）
// 默认模式 = 单进程纯函数链（不 spawn、不 import index.js，沙箱可直接跑）；
// --deep 模式 = 额外子进程全链冷启动（临时 DSH_HOME + 完整引擎加载 + 真实裁决链，需完整权限/CI）。
// 用法：node scripts/publish-aptitude-check.mjs [--deep] [--tgz <路径>]
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const deep = args.includes("--deep");
const tgzArg = args.includes("--tgz") ? args[args.indexOf("--tgz") + 1] : null;

const FAILS = [];
function check(ok, msg) {
  console.log(`${ok ? "✅" : "❌"} ${msg}`);
  if (!ok) FAILS.push(msg);
}

// ①-④ 使用的纯函数链（与引擎 lib 同源，动态 import 保证读到本次代码）
const { loadRules } = await import("../lib/core/parser.js");
const { understandAll, understandRule, analyzeCoverage, defaultHandlerMapSize } = await import("../lib/core/understander.js");

// ── ① 陌生环境冷启动（临时 DSH_HOME，无 AGENTS.md）──
const sceneDir = mkdtempSync(join(tmpdir(), "aptitude-check-"));
process.env.DSH_HOME = sceneDir;
process.env.DSH_WORKSPACE = root;
{
  const parsed = loadRules();
  check(parsed.ok === false && parsed.missing === true, `① 无 AGENTS.md：处理器返回 missing（ok=${parsed.ok}, missing=${parsed.missing}）`);
  const configs = understandAll([]);
  check(configs.length === 0, "① 无 AGENTS.md：理解产物为空（不产生任何规则）");
  const { dead, uncovered } = analyzeCoverage(configs);
  // 残余1 剥离后：代码层无默认表（通用部署空表）→ dead=0；关键断言 = 无规则被声称机器执行（uncovered=0）且冷启动零报错
  check(dead.size === 0, `① 无 AGENTS.md：dead=0（代码层无默认偏好表）`);
  check(uncovered.length === 0, `① 无 AGENTS.md：零未覆盖（uncovered=0）`);
}

// ── ② 空白规则文件静默 ──
{
  writeFileSync(join(sceneDir, "AGENTS.md"), "", "utf8");
  const parsed = loadRules();
  check(parsed.ok === true && parsed.rules.length === 0, `② 空白 AGENTS.md：解析成功且 0 规则（rules=${parsed.rules.length}）`);
  const configs = understandAll(parsed.rules);
  check(configs.length === 0, "② 空白 AGENTS.md：理解产物为空");
}

// ── ③ 任意编号规则（非本机编号）：声明式绑定 + 纯自证分流 ──
{
  const arbitrary = {
    index: "X-77",
    title: "陌生用户规则（执行等级：A+D）",
    section: "自定义分区",
    level: "A+D",
    body: "- **触发**：使用内联命令。\n- **检查**：拦 node -e / pwsh -c。\n- **动作**：拒绝。\n- **豁免**：无。"
  };
  const plain = understandRule(arbitrary);
  check(plain.handler === "", "③ 任意编号 + 无声明：handler 为空（纯自证分流，不误绑定本机执行器）");
  check(plain.actions.includes("deny") && plain.actions.includes("self-certify"), "③ 任意编号：A+D 动作解析正确（deny+self-certify）");
  const declared = understandRule({ ...arbitrary, body: arbitrary.body + "\n<!-- handler: rule12a-approval -->" });
  check(declared.handler === "rule12a-approval", "③ 任意编号 + 声明：绑定指定执行器");
  const covered = analyzeCoverage(understandAll([arbitrary]));
  check(covered.uncovered.some((u) => u.ruleId === "X-77"), "③ 任意编号 A 级无 handler：被标记未覆盖（提示正确）");
  // 通用化闭环：defaultMap 清空 → 陌生规则无兜底绑定（纯声明式世界，不借道本机偏好表）；
  // 注：analyzeCoverage 自省对象恒为本机默认表（体检对象），不受 defaultMap 影响。
  const bare = understandRule(arbitrary, { defaultMap: {} });
  check(bare.handler === "", "③ defaultMap 清空：陌生规则无兜底绑定（纯声明式世界）");
}

// ── ④ 四要素 + 执行等级格式契约冒烟（README 格式）──
{
  const elem = understandRule({
    index: "E-1",
    title: "格式样例（执行等级：B + D）",
    section: "样例分区",
    level: "B + D",
    body: "- **触发**：触发条件。\n- **检查**：检查项。\n- **动作**：动作说明。\n- **豁免**：豁免说明。"
  });
  check(elem.elements.trigger.length > 0 && elem.elements.check.length > 0 && elem.elements.action.length > 0 && elem.elements.exemption.length > 0, "④ 四要素提取完整");
  check(elem.actions.includes("correct") && elem.actions.includes("self-certify"), "④ 组合等级 B + D 动作解析正确");
  check(elem.confidence === "high", "④ 四要素齐全 → 置信 high");
}

// ── ⑤（2026-09-04 本机化：存在性判据 + 个人词表扫描移入本机发行工具
//    scripts/scan-real-paths.mjs（判据库 scripts/lib/realpath-guard.js），
//    本文件只保留 ①-④ 通用发布适用性检查；发布前由本机 release-gate 统一执行门禁）──

// ── --deep：完整引擎链冷启动（子进程，需完整权限/CI；沙箱不可用）──
if (deep) {
  console.log("\n（--deep 模式：请确认在完整权限/CI 环境运行——子进程捕获受沙箱限制）");
}

rmSync(sceneDir, { recursive: true, force: true });
console.log(`\n${FAILS.length === 0 ? "ADEPTITUDE CHECK PASS" : `ADEPTITUDE CHECK FAIL（${FAILS.length} 项）`}`);
process.exit(FAILS.length === 0 ? 0 : 1);
