// guardchain-coverage.test.mjs — 0.5.11 规则 24④ 机器执行（修正版，用户定稿口径）：
// 规则 24 目的 = 控制插件和工具装配，避免把插件/工具改坏——工具面正解 = "所有能产生文件
// 写入/删除/移动效果的工具必须**纳入同一套**敏感操作/授权/备份/版本守卫"（原文④），
// 不是"归类必须 mutating"（此前错误版枚举 35 个工具名断言 = mutating，只查分类名、不查守卫链）。
// 本测试 = 跨工具一致性测试（规则 24 动作行最后的交付要求）：
//   对每个已知会写/删/移文件的工具，构造"问句回合 + 无授权"的真实裁决场景，调用 guardDecision，
//   断言：命中守卫链（被拦）或属于豁免面（只读/展示/ask/产物类，规则 22 ③ 明列）——
//   任何工具静默放行（既不被拦也不在豁免面）= 逃逸 = 红。
// 新增工具未纳入测试清单 = 未来补录；本测试证明"已知清单不漏网"。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, getSessionState } from "../lib/core/state.js";
import { understandRule } from "../lib/core/understander.js";
import { guardDecision } from "../lib/core/guard-core.js";
import { parseUserIntents } from "../lib/core/intent.js";
import { toolClass } from "../lib/core/tool-catalog.js";

// 隔离真实 AGENTS.md
process.env.DSH_HOME = join(mkdtempSync(join(tmpdir(), "dsh-guardchain-")), "fake-dsh");
process.env.DSH_WORKSPACE = process.cwd();

function makeState() {
  const state = createState();
  const s = getSessionState(state, "global");
  // 真实规则（覆盖 22/12A/13A/24 链所需）
  const rules = [
    understandRule({ index: "22", title: "沟通直接性（执行等级：C+D）", level: "C+D",
      body: "- **触发**：所有交流场景。\n- **检查**：无执行分点→禁变更类。\n- **动作**：拒绝。\n- **豁免**：只读、展示、ask_user_question、todo_write。" }),
    understandRule({ index: "12A", title: "执行前确认（执行等级：C+D）", level: "C+D",
      body: "- **触发**：敏感操作。\n- **检查**：敏感操作需授权证据。\n- **动作**：无授权→拒绝。\n- **豁免**：只读、低风险新建。" }),
    understandRule({ index: "13A", title: "备份与验证闭环（执行等级：A+D）", level: "A+D",
      body: "- **触发**：删除/覆盖/迁移/修改受保护配置文件。\n- **检查**：删除/覆盖无备份→拒绝。\n- **动作**：拒绝。" }),
    understandRule({ index: "24", title: "插件变更统一守卫（执行等级：A）", level: "A",
      body: "- **触发**：插件装配变更。\n- **检查**：类型匹配。\n- **动作**：类型不匹配→拒绝。" }),
    understandRule({ index: "18", title: "先查手册再动手（执行等级：A弱）", level: "A弱",
      body: "- **触发**：任务涉及 DSH。\n- **检查**：首次工具调用前未读手册→拒绝。\n- **动作**：拒绝。" })
  ];
  state.rules = rules;
  state.configs = rules.map((r) => ({ ...r, handler: { "22": "rule22-7-direct", "12A": "rule12a-approval", "13A": "rule13a-backup", "24": "rule24-assembly-type", "18": "rule18-manual-first" }[String(r.index)] || "", actions: r.level.includes("A") ? ["deny"] : ["correct"], confidence: "high" }));
  return state;
}

// 已知会写/删/移文件的工具 + 最小参数（真实裁决场景）
const CASES = [
  { name: "edit", args: { file_path: "D:/p/a.txt", old_string: "a", new_string: "b" } },
  { name: "write", args: { file_path: "D:/p/a.txt", content: "x" } },
  { name: "str_replace_editor", args: { command: "str_replace", file_path: "D:/p/a.txt", old_str: "a", new_str: "b" } },
  { name: "pwsh", args: { command: "Set-Content -Path 'D:/p/a.txt' -Value 'x'" } },
  { name: "bash", args: { command: "echo x > /tmp/a.txt" } },
  { name: "upload_file", args: { paths: ["D:/p/a.txt"] } },
  { name: "run_code", args: { code: "writeFileSync('D:/p/a.txt','x')" } },
  { name: "dev_install_package", args: { dir: "D:/p" } },
  { name: "dev_inject_plugin", args: { dir: "D:/p" } },
  { name: "dev_uninject_plugin", args: { match: "x" } },
  { name: "dev_reload_package", args: { packageName: "x" } },
  { name: "dev_build_plugin", args: { dir: "D:/p" } },
  { name: "dev_release_plugin", args: { dir: "D:/p" } },
  { name: "dev_scaffold_plugin", args: { dir: "D:/p", name: "x" } },
  { name: "dev_fix_patch", args: {} },
  { name: "dev_heal_links", args: {} },
  { name: "dev_clear_routes", args: { prefix: "/x" } },
  // dev_stage 四件套（手册 v3.39：纳入敏感授权检查；归类保持 artifact）
  { name: "dev_stage_add", args: { name: "x", execute: "console.log(1)" } },
  { name: "dev_stage_call", args: { name: "x", args: {} } },
  { name: "dev_stage_promote", args: { name: "x" } },
  { name: "dev_stage_demote", args: { name: "x" } },
  // 官方 terminal/装配
  { name: "terminal_open", args: {} },
  { name: "terminal_send", args: { id: "t", input: "x" } },
  // Cordis 定义类
  { name: "cordis_define", args: {} },
  { name: "cordis_run", args: {} },
  { name: "cordis_stop", args: {} },
  { name: "cordis_undefine", args: {} },
  // 任务/团队/工作流协调（会话面，但参数可含写）
  { name: "followup_task", args: {} },
  { name: "spawn_teammate", args: {} },
  { name: "team_task_create", args: {} },
  { name: "team_task_update", args: {} },
  { name: "wait_agent", args: {} },
  { name: "job_kill", args: { job_id: "j" } }
];

const failures = [];
for (const { name, args } of CASES) {
  const state = makeState();
  const s = getSessionState(state, "global");
  s.turn.userText = "这样可以吗？";           // 问句回合
  s.turn.intents = parseUserIntents(s.turn.userText); // 无执行分点
  // 已知注入上下文属规则未命中的常规消息；无需 manualReadSeen（18 仅弱检测，问句不触发首次工具检测）——
  // 精确模拟：已有 manualRead 标记避免 18 干扰（本测试专注 22/12A/13A/24 链）
  s.turn.manualReadSeen = true;
  const hit = guardDecision(state, { name, arguments: args });
  const cls = toolClass(name, args);
  if (hit) continue;                         // 命中守卫链（被拦）= ✅ 纳入守卫
  if (cls === "analysis" || cls === "artifact") {
    // 豁免面：只读/产物类——规则 22 ③ 明列豁免；但受保护路径仍由 13A/self-protect 把关（本测试用普通路径，放行合规）
    continue;
  }
  failures.push(`${name}（cls=${cls}）问句回合静默放行——未纳入守卫链`);
}

if (failures.length > 0) {
  console.error("GUARDCHAIN-COVERAGE-FAIL：以下写/删/移工具在问句回合静默放行（逃逸守卫）：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`GUARDCHAIN-COVERAGE-OK：${CASES.length} 个写/删/移工具均纳入守卫链（被拦或属豁免面）`);
