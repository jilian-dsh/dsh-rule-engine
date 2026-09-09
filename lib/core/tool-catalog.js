// tool-catalog.js - 工具分类制（机制 B，2026-08-24；0.5.9 升级 2026-08-27）
// 任何插件（现有/未来）注册的工具都按此分类：
//   analysis  = 只读分析（无条件放行）
//   artifact  = 写产物/会话态（低风险：放行 + 审计留痕；受保护路径仍由 13A/__self-protect 把关）
//   mutating  = 变更类（维持现有严格授权：规则 22 粒度 / 12A / 13A）
//   unknown   = 未归类（由 index.js 的 pre-execute 层处置：unknownPolicy=ask（官方弹窗）或 deny + 提示）
// 0.5.9 改动（用户"整体审查"要求，K-01~K-06 依据）：
//   1. 补全官方全集（tool-catalog 镜像交叉：cordis_*/terminal_*/session_*/goal/jobs/子代理/团队/保留工具等）；
//   2. 前缀规则（mcp__=mutating；esr_ 细化）——生态命名空间新工具自动覆盖，不再依赖静态枚举；
//   3. 单一真源：24④ 守卫与 unknown 决策均读本表（废弃 guard-core 的独立覆盖表，杜绝双表漂移）；
// 设计原则：工具名不是安全边界，内容才是（K-04）——归类只决定"识别"，内容审查（12C/13A）不因归类豁免。
import { isReadOnlyTool } from "./patterns.js";

// 只读分析类：无任何文件副作用（或仅有会话内状态），无条件放行
const ANALYSIS_TOOLS = new Set([
  "read", "grep", "glob", "read_image",
  // 视觉分析类（纯看图，无文件副作用）
  "vision_describe", "vision_detect", "vision_ground", "vision_colors", "vision_ocr", "vision_bootstrap",
  // 查询/状态类（工具自身状态，无持久副作用）
  "job_list", "job_output", "list_agents", "get_goal", "schedule_list",
  "dev_plugin_status", "dev_injected_list", "dev_stage_list", "dev_self_test",
  "engram_recall", "engram_detail", "engram_model",
  // 官方只读联网工具（@deepseek-ai/dsh-tool-web 家族，2026-08-25 补）：只读抓取/搜索，无文件副作用；
  // 公网访问由 12C 的 B 级留痕与 D⑤ 边界继续把关（回环/内网/SSRF 防护不因分类豁免）
  "web_fetch", "web_search",
  // 子代理交付工具（官方 dsh-tool-subagent-report，2026-08-24 实测发现）：仅子代理环境注册，
  // 参数仅 output 文本 → 直接交付父代理，无文件副作用 → analysis（避免子代理交付被 unknown deny 阻断）
  "report",
  // 官方子代理模型发现（@deepseek-ai/dsh-tool-subagent，2026-09-06 工具目录漂移补录）：只读枚举
  // 可用子代理模型（模型发现/所选路由校验），无持久副作用 → analysis
  "list_subagent_models",
  // 官方 0.5.9 补全（tool-catalog 镜像 2026-08-27 交叉）
  "lsp",
  "session_event_read", "session_event_search", "session_event_trace", "session_search", "session_trace",
  "terminal_list", "terminal_read",
  "cordis_inspect_list", "cordis_inspect_query", "cordis_inspect_self",
  "ask_user_question",
  // ESR 状态查询（读工作区记忆状态，无持久副作用）
  "esr_status", "esr_ready", "esr_model",
  // univer-office 只读族（2026-09-09 补录：规则 24④ 实测 univer_execute 被硬拦——该族未分类；
  // 逐工具分类而非前缀一刀切：只读/查询类 → analysis）
  "univer_status", "univer_inspect", "univer_lint", "univer_api", "univer_resources"
]);

// 产物类：工具自然行为会写文件（artifact/工作区/会话存储），低风险——放行 + 审计。
// 若写目标命中受保护路径/工作区外，仍由 __self-protect / 13A / 12A 独立把关（不因分类而豁免）。
const ARTIFACT_TOOLS = new Set([
  // 视觉产物类（裁剪/截图/长图 OCR/矢量化/抠图/物化/展示 → 写 artifact）
  "vision_crop", "vision_pixel_diff", "vision_trace", "vision_extract_foreground",
  "vision_html_screenshot", "vision_long_screenshot_ocr", "vision_materialize", "vision_present",
  // 记忆/日程/目标/技能（写引擎/会话存储，低风险）
  "engram_store", "schedule_create", "schedule_delete",
  "create_goal", "update_goal",
  "skill", "todo_write", "visualize",
  // 子代理/工作流协调（会话/子会话态，无文件副作用；内容审查另有其责）
  "subagent", "subagent_fork", "send_message", "interrupt_agent", "workflow", "ralph",
  // 官方 plan-mode 交互工具（参数为 markdown 计划，批准/继续规划，无文件副作用）
  "exit_plan_mode",
  // 开发侧 staging（写 staging 区，dev_* 工具的自然行为）
  // 0.5.11 修正（手册 v3.39 口径）：dev_stage 四件套（add/call/promote/demote）= 纳入**敏感
  // 授权检查**（守卫链覆盖），**不是改分类**——统一保持 artifact；授权检查由 guard-core
  // （12A isSensitiveToolCall / 13A / 24 装配判定）链上覆盖，不再各自归类。
  "dev_stage_add", "dev_stage_call", "dev_stage_promote", "dev_stage_demote",
  // ESR 工程状态写操作（写工作区记忆存储，engram_store 同族）
  "esr_task", "esr_node", "esr_link", "esr_claim", "esr_close", "esr_unclaim", "esr_dep", "esr_gc",
  // univer-office 产物族（2026-09-09 补录）：截图写 artifact；univer_new 只新建不覆盖
  "univer_screenshot", "univer_new"
]);

// 变更类：维持现有严格授权（规则 22 粒度比对 / 12A 敏感授权 / 13A 备份）
const MUTATING_TOOLS = new Set([
  "edit", "write", "str_replace_editor", "pwsh", "bash", "upload_file",
  // 插件装配类（规则 24/27 管辖）
  "dev_install_package", "dev_inject_plugin", "dev_uninject_plugin", "dev_reload_package",
  "dev_fix_patch", "dev_heal_links",
  "dev_scaffold_plugin", "dev_build_plugin", "dev_release_plugin", "dev_clear_routes",
  // 官方 0.5.9 补全（tool-catalog 镜像 2026-08-27 交叉）
  "run_code",              // 官方保留传输（Code Mode 唯一入口，语义"不可限制"——归类=纳入统一守卫而非拦死）
  "cordis_define", "cordis_run", "cordis_stop", "cordis_undefine",
  "terminal_open", "terminal_send", "terminal_close", "terminal_signal",
  "job_kill",
  "followup_task", "spawn_teammate", "team_task_create", "team_task_get",
  "team_task_list", "team_task_update", "wait_agent",
  // 本机命名空间兜底（dev_ 前缀 = 开发侧工具，行为可写可管理；具体已枚举，前缀兜底未来新增）
  "dev_router_status",
  // univer-office 变更族（2026-09-09 补录，规则 24④：未分类 + 疑似写 → 硬拦；逐工具分类纳入守卫链）
  "univer_execute", "univer_import", "univer_unit", "univer_worktree",
  "univer_compile_svg", "univer_export", "univer_print_pdf"
]);

// 前缀规则：生态命名空间的工具自动归类（0.5.9 新）——将来的新插件遵循惯例即被覆盖。
// 安全注记（K-03）：mcp__ 服务器段不做通配（Claude Code 同款约束）；mcp 工具按变更类走授权（保守）。
const PREFIX_RULES = [
  { prefix: "mcp__", cls: "mutating" },
  { prefix: "esr_", cls: "artifact" },
  { prefix: "vision_", cls: "analysis" },
  { prefix: "engram_", cls: "artifact" },
  { prefix: "dev_", cls: "mutating" },
  { prefix: "schedule_", cls: "artifact" },
  { prefix: "job_", cls: "analysis" },
  { prefix: "terminal_", cls: "mutating" },
  { prefix: "cordis_", cls: "mutating" },
  { prefix: "session_", cls: "analysis" },
  { prefix: "team_", cls: "mutating" }
];

/**
 * 工具分类判定（纯函数）。0.5.9 单一真源：24④ 守卫与 unknown 处置均读此结果。
 * @param {string} name 工具名
 * @param {object} args 工具参数（pwsh/bash 需要命令文本判读写）
 * @returns {'analysis'|'artifact'|'mutating'|'unknown'}
 */
export function toolClass(name, args = {}) {
  const n = String(name || "");
  if (n === "pwsh" || n === "bash") {
    return isReadOnlyTool(n, args) ? "analysis" : "mutating";
  }
  if (ANALYSIS_TOOLS.has(n)) return "analysis";
  if (ARTIFACT_TOOLS.has(n)) return "artifact";
  if (MUTATING_TOOLS.has(n)) return "mutating";
  // 前缀规则（细粒度集合优先；esr_ 状态查询放宽为 analysis）
  if (n.startsWith("esr_") && ["esr_status", "esr_ready", "esr_model"].includes(n)) return "analysis";
  for (const rule of PREFIX_RULES) {
    if (n.startsWith(rule.prefix)) return rule.cls;
  }
  return "unknown";
}

/**
 * unknown 工具的处置决策（pre-execute 层调用）。
 * 0.5.9 修订（K-02/K-03 依据）：unknown 首调从物理 deny 改为由 index.js 按 unknownPolicy 走
 * 官方 ask（弹窗，allowed-once）或 deny；本函数保留"未分类且未白名 → deny（需要处置）"的
 * 对外契约（调用方翻译策略），已知分类或已白名 → null（放行）。
 * @param {string} name 工具名
 * @param {object} args 工具参数
 * @param {Set<string>|null} whitelist 会话内已批准工具集（可选）
 * @returns {'deny'|null} unknown 且未白名 → 'deny'；已知分类或已白名 → null
 */
export function unknownToolDecision(name, args = {}, whitelist = null) {
  if (toolClass(name, args) !== "unknown") return null;
  if (whitelist && whitelist.has(name)) return null;
  return "deny";
}
