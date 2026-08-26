// patterns.js - 规则引擎共享的正则与常量。
// 注意：本文件只放可测试的纯函数/常量，不依赖 Cordis。

export const INLINE_CMD =
  /\b(?:node|pwsh|powershell)\s+(?:-[ep]|--eval|--print|-Command|-c)\b/i;

// PS7 语义（2026-08-19 同步）：utf8 = 无 BOM、utf8BOM = 带 BOM、utf8NoBOM = 无 BOM。
// 只拦显式 -Encoding utf8BOM 写 .json/.yaml；PS7 下 -Encoding utf8 无 BOM 合规放行。
export const BOM_WRITE =
  /(?:set-content|add-content|out-file|writealltext)[\s\S]{0,300}?(?:-Encoding\s+utf8bom|utf8bom)[\s\S]{0,300}?\.(?:json|ya?ml)\b|(?:set-content|add-content|out-file|writealltext)[\s\S]{0,300}?\.(?:json|ya?ml)\b[\s\S]{0,300}?(?:-Encoding\s+utf8bom|utf8bom)/i;

export const DESTRUCTIVE_CMD =
  /(?:remove-item|rm\s+-r|rmdir\s+\/s|rd\s+\/s|del\s+(?:\/[a-z]+\s+)*\/[a-z]*s[a-z]*|move-item|rename-item|copy-item\s+[^\n]*?(?:-\s*force|overwrite))/i;

export const SENSITIVE_CMD =
  /(?:git\s+(?:push|commit)|remove-item|rm\s+-r|rmdir\s+\/s|rd\s+\/s|del\s+\/s|move-item|rename-item|copy-item\s+[^\n]*?(?:-\s*force|overwrite))/i;

export const CONFIG_FILE_RE =
  /(?:^|[\\/])(?:AGENTS\.md|settings\.yaml|\.credentials\.yaml|workspace\.json|cordis\.patch\.yml|rule-understanding\.json|rule-guard\.json|rule-engine\.json)$/i;

/** 受保护文件名（命令文本中出现即需警惕；P0-1c 起仅在写类命令中生效） */
export const PROTECTED_FILENAME_RE =
  /(?:AGENTS\.md|settings\.yaml|\.credentials\.yaml|workspace\.json|cordis\.patch\.yml|rule-understanding\.json|rule-engine\.json)/i;

export const DATA_DIR_RE =
  /(?:^|[\\/])\.dsh[\\/](?:sessions|storages|\.backups)[\\/]/i;

export const TIME_WORDS =
  /今天|昨天|前天|上周|本周|刚才|\d+\s*分钟前|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/;

export const PROMISE_WORDS =
  /包在我身上|肯定能|绝对没问题|保证(?!不|无法)|一定可以|放心(?:，|,)?肯定|万无一失/;

export const URL_RE = /https?:\/\/[^\s]+/i;

/** 回环/内网地址模式（规则 12C B 级留痕用） */
export const PRIVATE_NETWORK_RE =
  /(?:127\.0\.0\.1|localhost|169\.254\.169\.254|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})/i;

export const SOURCE_MARK = /来源|出处|via|source|reference|引自|参考/i;

export const CJK_RE = /[\u4e00-\u9fff]/;

export const MANUAL_PATH_RE = /example-usage-manual[\\/]SKILL\.md/i;

export const DSH_KEYWORDS_RE =
  /DSH|dsh|插件|技能|规则|配置|迁移|手册|会话|装配|profile|bundle/i;

export const SKILL_EXEMPT = new Set(["example-usage-manual", "example-planner"]);

export const SELF_PROTECT_PATHS = [
  "**/rule-engine.json",
  "**/rule-understanding.json",
  "**/rule-guard.json"
];

/** 判断一条命令文本是否是「读取手册」类命令 */
export function isManualReadCommand(command) {
  if (typeof command !== "string") return false;
  return MANUAL_PATH_RE.test(command) && /get-content|cat|type|read|grep|findstr|str_replace_editor/i.test(command);
}

/** 判断一次工具调用是否算作「已读手册」 */
export function isManualReadTool(toolName, args) {
  const name = String(toolName || "");
  if (name === "read" || name === "grep" || name === "str_replace_editor") {
    const p = String(args?.file_path || args?.path || args?.pattern || "");
    if (MANUAL_PATH_RE.test(p)) return true;
  }
  if (name === "pwsh" || name === "bash") {
    return isManualReadCommand(args?.command || args?.code || "");
  }
  return false;
}

/** 从工具参数中提取目标路径（edit/write/read 等） */
export function pathTarget(args) {
  if (!args || typeof args !== "object") return null;
  const p = args.file_path ?? args.path;
  return typeof p === "string" ? p : null;
}

/** 从工具参数中提取命令文本（pwsh/bash） */
export function commandText(args) {
  if (!args || typeof args !== "object") return null;
  const c = args.command ?? args.code;
  return typeof c === "string" ? c : null;
}

/** 判断是否命中配置文件保护路径 */
export function isProtectedConfigPath(p) {
  if (typeof p !== "string") return false;
  const n = p.replace(/\\/g, "/").toLowerCase();
  return CONFIG_FILE_RE.test(n) || DATA_DIR_RE.test(n);
}

/** 从 Copy-Item 命令中提取源与目标路径（优先支持带引号/空格的 Windows 路径） */
export function extractCopyPaths(command) {
  if (typeof command !== "string") return null;
  const quoted = command.match(
    /(?:copy-item\s+)?(?:-literalpath|-path)?\s*["']([^"']+)["']\s+(?:-destination\s*)?["']([^"']+)["']/i
  );
  if (quoted && quoted[1] && quoted[2]) {
    return { source: quoted[1].trim(), dest: quoted[2].trim() };
  }
  const simple = command.match(
    /copy-item\s+(?:-literalpath|-path)?\s*([^\s"']+)\s+(?:-destination\s*)?([^\s"']+)/i
  );
  if (simple && simple[1] && simple[2]) {
    return { source: simple[1].trim(), dest: simple[2].trim() };
  }
  return null;
}

/** 判断路径是否含 shell 变量（$var / ${var} / %var%），含变量的路径无法可靠解析为真实目标 */
export function isVariablePath(p) {
  if (typeof p !== "string") return false;
  return /\$[A-Za-z_][A-Za-z0-9_]*|%\w+%|\$\([^)]*\)/.test(p);
}

/** 判断是否为“不在自动备份范围的高风险运行入口文件”（Electron 壳、启动脚本、CLI 入口等） */
export function isHighRiskEntryFile(p) {
  if (typeof p !== "string") return false;
  const n = p.replace(/\\/g, "/").toLowerCase();
  if (/(?:^|[\\/])(?:dsh\.cmd|dsh\.ps1|dsh)$/i.test(n)) return true;
  if (/(?:^|[\\/])main\.js$/i.test(n) && /(?:dsh-desktop|electron|dsh-web|dsh-client)/i.test(n)) return true;
  if (/(?:^|[\\/])bin\.js$/i.test(n) && /@deepseek-ai[\\/]dsh[\\/]lib/i.test(n)) return true;
  return /(?:^|[\\/])(?:startup|launcher|entry)[\\/][^\\/]+\.(?:js|mjs|cjs)$/i.test(n);
}

/** 从命令文本中提取“真正会被写入/删除的目标路径”（Copy-Item 只取 Destination；Set-Content 等只取 -Path/-LiteralPath/重定向目标，不再把值字符串里的路径当写目标） */
export function writeTargetPathsFromCommand(command) {
  if (typeof command !== "string") return [];
  const cmd = command;
  if (/\bcopy-item\b/i.test(cmd)) {
    const cp = extractCopyPaths(cmd);
    if (cp && cp.dest) return [cp.dest];
    // 解析失败时保守返回全部绝对路径，避免漏拦
    return absolutePathTokens(cmd);
  }
  if (/\b(?:move-item|rename-item)\b/i.test(cmd)) {
    // 移动/重命名：源被删除、目标被写入，保守都算写目标
    return absolutePathTokens(cmd);
  }
  if (/(?:set-content|add-content|out-file|writealltext|new-item|remove-item|clear-content)/i.test(cmd)) {
    return extractCommandWriteTargets(cmd);
  }
  return [];
}

/** 从写类命令中提取真正的目标路径：优先 -Path/-LiteralPath/-FilePath/-Destination/-Target，其次重定向，最后取第一个绝对路径 */
function extractCommandWriteTargets(command) {
  const targets = [];
  const flagRe = /-(?:path|literalpath|filepath|destination|target)\s+/ig;
  let m;
  while ((m = flagRe.exec(command))) {
    const rest = command.slice(m.index + m[0].length);
    // 只取 flag 的“紧邻参数值”（引号包裹或单个 token），不再扫描剩余整条命令——
    // 否则 `-Path $var` 后跟的无关只读路径会被误判为写目标（P0-1 误拦）
    const quoted = rest.match(/^\s*["']([^"']+)["']/);
    let token = null;
    if (quoted) {
      token = quoted[1].trim();
    } else {
      const plain = rest.match(/^\s*([^\s"'`，。；：！？（）【】《》、;|&]+)/);
      if (plain) token = plain[1].trim();
    }
    // 只接受绝对路径字面量：变量（$x / %x%）、相对路径无法可靠解析 → 跳过（不误判）
    if (token && /^[a-z]:[\\/]/i.test(token)) {
      if (!isExecutableToken(token)) targets.push(token);
    }
  }
  const redirRe = /(?:^|[\s>])(?:>>|>)\s*["']?([A-Za-z]:[\\/][^"';\s]+)/g;
  while ((m = redirRe.exec(command))) {
    targets.push(m[1].trim());
  }
  if (targets.length > 0) return [...new Set(targets)];
  // flag 未解析出目标时：命令含变量则无法可靠推断 → 返回空（宁可不拦，不误拦）
  if (/\$[A-Za-z_][A-Za-z0-9_]*|%\w+%|\$\([^)]*\)/.test(command)) return [];
  const fallback = absolutePathTokens(command);
  return fallback.length > 0 ? [fallback[0]] : [];
}

function isBackupDestination(dest) {
  return /\.bak$/i.test(dest) || /\.backups[\\/]|trash-/i.test(dest);
}

/** 从备份工具调用推导目标路径与备份路径；无法推导或非备份目标返回 null */
export function backupPathsFromTool(toolName, args) {
  const name = String(toolName || "");
  const p = pathTarget(args);
  const cmd = commandText(args);
  if (name === "pwsh" || name === "bash") {
    const paths = extractCopyPaths(cmd || "");
    if (paths && /^[a-z]:[\\/]/i.test(paths.source) && /^[a-z]:[\\/]/i.test(paths.dest) && isBackupDestination(paths.dest)) {
      return { targetPath: paths.source, backupPath: paths.dest };
    }
  }
  if (p) {
    if (/\.bak$/i.test(p)) {
      return { targetPath: p.replace(/\.bak$/i, ""), backupPath: p };
    }
    if (/\.backups[\\/]|trash-/i.test(p)) {
      return { targetPath: p, backupPath: p };
    }
  }
  return null;
}

/** 判断命令是否包含备份动作（简单启发式） */
export function isBackupCommand(command) {
  if (typeof command !== "string") return false;
  return /backup|\.backups|copy-item[^\n]*\.bak|robocopy[^\n]*\/e|copy-item[^\n]*trash-/i.test(command);
}

/** 判断一次工具调用是否算作备份动作 */
export function isBackupTool(toolName, args) {
  const name = String(toolName || "");
  const p = pathTarget(args);
  if (p && /\.backups[\\/]|trash-|\.bak$/i.test(p)) return true;
  if (name === "pwsh" || name === "bash") return isBackupCommand(commandText(args) || "");
  return false;
}

/** 判断一次工具调用是否是授权询问 */
export function isAskTool(toolName) {
  return String(toolName || "") === "ask_user_question";
}

/** 判断命令是否包含 Get-Date 核对 */
export function isGetDateCommand(command) {
  return typeof command === "string" && /\bget-date\b/i.test(command);
}

// 注：PS5.1 时代的「含中文 .ps1 必须 UTF-8 带 BOM」硬拦已移除（2026-08-19）——
// PS7 默认且正确读取 UTF-8 无 BOM 脚本，无需 BOM；规则 9 已同步 PS7 语义。

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "read_image"]);
const READONLY_CMD_RE =
  /(?:\b(?:Get-Content|Get-ChildItem|Get-Item|Get-Command|Get-Date|Select-String|Find-String|Test-Path|Get-Process|Get-Service|cat|type|dir|ls|grep|findstr|more|netstat|where|echo|Write-Output|Write-Host|Get-Location|pwd|cwd|Get-Help|help)\b)|(?:\bgit\s+(?:-[^\s]+\s+[^\s]+\s+|--[^\s]+\s+)*\b(?:status|log|diff|show|branch|tag|remote|rev-parse|diff-tree|ls-files)(?:\s|$))|(?:\bdsh\s+(?:--version|--help|--dump-config|plugin\s+(?:list|show|status))(?:\s|$))|(?:\bdsh\s+--profile\s+[^\s]+\s+(?:--dump-config|plugin\s+(?:list|show|status))(?:\s|$))|(?:\bnode\s+(?:--check|--test|--version)(?:\s|$))|(?:\bnpm\s+(?:test|run\s+test)(?:\s|$))|(?:\bpnpm\s+(?:test|run\s+test)(?:\s|$))|(?:\bgh\s+(?:auth\s+status|repo\s+view)(?:\s|$))|(?:\bnpm\s+(?:ls|view)(?:\s|$))/i;
const MUTATING_CMD_RE =
  /(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|Clear-Content|git\s+(?:push|commit)|rm\s+-r|rmdir\s+\/s|del\s+\/s|(?:^|[^0-9])>>|(?:^|[^0-9])>)/i;

/** 只读命令链按分隔符折段（机制 B，2026-08-24）：`; 换行 && || |`（管道前后是命令链；`2>&1`/`2>$null` 的 stderr 重定向不拆分） */
function splitCommandSegments(command) {
  return String(command)
    .split(/\r?\n|;|&&|\|\||(?<!\d)\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 判断命令文本是否只读（读文件/查询类，无写入/删除/提交副作用）。
 *  2026-08-24 分段化：整条命令按 ; | & 换行拆段，每段都必须只读——
 *  修复 "git -C <dir> status" 变体不匹配、"git status; echo ok" 链式被误判为写 的实测缺陷。 */
export function isReadOnlyCommand(command) {
  if (typeof command !== "string") return false;
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return false;
  return segments.every((seg) => {
    if (MUTATING_CMD_RE.test(seg)) return false;
    return READONLY_CMD_RE.test(seg);
  });
}

/** 判断一次工具调用是否只读（必须无条件放行） */
export function isReadOnlyTool(toolName, args) {
  const name = String(toolName || "");
  if (READ_ONLY_TOOLS.has(name)) return true;
  if (name === "str_replace_editor" && args?.command === "view") return true;
  if (name === "pwsh" || name === "bash") {
    return isReadOnlyCommand(commandText(args) || "");
  }
  return false;
}

/**
 * node -e 内联代码的危险特征判定（机制批 M4：diag-run 受控诊断工具使用）。
 * 黑名单命中任一 = 判定有写/网络/进程副作用（保守：宁可拒）。规则 9 正文不动（A2=B 方案）。
 */
const DANGEROUS_INLINE_NODE_RE =
  /(?:fs\.|\bwriteFile(?:Sync)?\b|\bappendFile(?:Sync)?\b|\bcreateWriteStream\b|\bunlink(?:Sync)?\b|\brm(?:Sync)?\b|\bcopyFile(?:Sync)?\b|\brename(?:Sync)?\b|\bmkdir(?:Sync)?\b|\brmdir(?:Sync)?\b|\bchild_process\b|\bexec(?:Sync)?\b|\bspawn\b|\bfetch\s*\(|\bhttps?\.|\bnet\.|\bcreateServer\b|\brequire\s*\(\s*["']fs|from\s+["']node:fs|from\s+["']node:child_process|process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*)?\s*=)/i;
/** 供 diag-run 及其测试使用：true = 判定有副作用（应拒绝执行） */
export function isDangerousInlineNode(code) {
  return DANGEROUS_INLINE_NODE_RE.test(String(code || ""));
}

/**
 * 落盘授权粒度提醒（机制批 M7，2026-08-24，用户确认）：
 * 方案性指令（调整/补充/评估/建议/草案……）不构成"落盘/发布"授权（规则 22 自证③）。
 * true = 用户消息更像"要方案"而非"授权落盘"——此时对受保护文件统一入口调用应记 approval-gap 提醒。
 * 保守：含落盘性词（落盘/写入/发布/改为……）→ false（不提醒）。
 */
const PLAN_INSTRUCTION_RE = /方案|调整|补充|建议|评估|草案|完善|优化|改进|提炼|重构|梳理/;
const WRITE_INSTRUCTION_RE = /落盘|写入|发布|正式写入|正式落盘|改为|改成|保存到手册|写进手册|确定为|确认后(?:落盘|写入|发布)/;
export function needsApprovalReminder(userText) {
  const t = String(userText || "");
  if (!t) return false;
  return PLAN_INSTRUCTION_RE.test(t) && !WRITE_INSTRUCTION_RE.test(t);
}

let workspaceRoots = []; // 全局注册的工作区根（兜底层）
const sessionWorkspaceRoots = new Map(); // v0.5.7 P0-3：会话→工作区根（精确层，根随会话走）

/** 由插件 apply 阶段从 workspaceRegistry 设置工作区根目录（单根兼容入口） */
export function setWorkspaceRoot(p) {
  setWorkspaceRoots(p ? [p] : []);
}

/** v0.5.7 P0-3：注册全部工作区根（多工作区环境；兜底层用） */
export function setWorkspaceRoots(paths) {
  workspaceRoots = Array.isArray(paths) ? paths.filter((p) => typeof p === "string" && p.length > 0) : [];
}

/** v0.5.7 P0-3：注册"会话→工作区根"映射——多工作区正确模型：根随会话走（写其他工作区=外部，需授权） */
export function setSessionWorkspaceRoot(sessionId, root) {
  if (sessionId && typeof root === "string" && root.length > 0) {
    sessionWorkspaceRoots.set(String(sessionId), root);
  }
}

function isPathInside(target, root) {
  const t = normalizePathForCompare(target);
  const r = normalizePathForCompare(root);
  if (!t || !r) return false;
  return t === r || t.startsWith(r.endsWith("/") ? r : r + "/");
}

function normalizePathForCompare(p) {
  return String(p).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

/**
 * 判断路径是否在工作区外（用于"工作区外写入"敏感判定）。
 * v0.5.7 P0-3（用户拍板多工作区模型，2026-08-26）：
 *  ① 会话已知且已映射 → 只用该会话的工作区根（精确：写其他工作区/他盘 = 外部 = 要授权）；
 *  ② 无会话映射 → 全局注册根列表（任一命中=内部）；
 *  ③ 仍无 → 环境变量/进程 cwd（最后尝试）；
 *  ④ 全不可得 → 保守判"内部"（受保护文件/数据目录有独立清单兜底，避免工作区内普通文件被
 *  误判外→12A 全量要授权——此前"只读脚本被拦"的根因）。
 */
export function isOutsideWorkspace(p, sessionId) {
  if (typeof p !== "string") return false;
  if (!/^[a-z]:[\\/]/i.test(p) && !p.startsWith("/")) return false; // 只判断绝对路径
  if (sessionId) {
    const root = sessionWorkspaceRoots.get(String(sessionId));
    if (root) return !isPathInside(p, root);
  }
  const roots = workspaceRoots.length > 0 ? workspaceRoots
    : [process.env.DSH_WORKSPACE, process.cwd()].filter(Boolean);
  if (roots.length === 0) return false;
  return !roots.some((root) => isPathInside(p, root));
}

const ABS_PATH_RE = /[A-Za-z]:[\\/][^\s'"`，。；：！？（）【】《》、]+/g;
const QUOTED_ABS_PATH_RE = /["']([A-Za-z]:[\\/][^"']+)["']/g;

/** 判断绝对路径 token 是否是可执行程序（命令本身，非文件目标） */
function isExecutableToken(tok) {
  const base = tok.replace(/\\/g, "/").split("/").pop() || "";
  return /\.(?:exe|cmd|bat|com|ps1|psm1|psd1|sh|bash|mjs|cjs)$/i.test(base);
}

/** 提取命令中的绝对路径（支持带引号含空格路径；去重；排除可执行程序本身、URL scheme 与引号路径的前缀重复） */
export function absolutePathTokens(command) {
  if (typeof command !== "string") return [];
  const isHttpScheme = (idx) => idx >= 4 && command.slice(idx - 4, idx).toLowerCase() === "http";
  const quoted = [];
  let m;
  QUOTED_ABS_PATH_RE.lastIndex = 0;
  while ((m = QUOTED_ABS_PATH_RE.exec(command))) {
    if (isHttpScheme(m.index)) continue;
    const tok = m[1].trim();
    if (!isExecutableToken(tok)) quoted.push(tok);
  }
  const unquoted = [];
  ABS_PATH_RE.lastIndex = 0;
  while ((m = ABS_PATH_RE.exec(command))) {
    if (isHttpScheme(m.index)) continue;
    const tok = m[0].trim();
    if (isExecutableToken(tok)) continue; // 程序名不是文件目标
    if (quoted.some((q) => q.toLowerCase().startsWith(tok.toLowerCase()))) continue;
    unquoted.push(tok);
  }
  return [...new Set([...quoted, ...unquoted])];
}

function commandHasOutsideWrite(cmd, sessionId) {
  if (typeof cmd !== "string") return false;
  return writeTargetPathsFromCommand(cmd).some((p) => isOutsideWorkspace(p, sessionId));
}

export const GENERIC_EXEC_TOOLS = new Set([
  "dev_stage_add",
  "dev_stage_call",
  "dev_stage_promote",
  "dev_stage_demote"
]);

const ASSEMBLY_TOOLS = new Set(["dev_install_package", "dev_inject_plugin", "dev_uninject_plugin"]);
const ASSEMBLY_PATH_RE = /cordis\.patch\.yml|dsh\.profile\.bundles|profiles[\\/][^\\/]+[\\/]package\.json$/i;
const ASSEMBLY_CMD_RE = /(?:cordis\.patch\.yml|dsh\.profile\.bundles)/i;
const ASSEMBLY_WRITE_CMD_RE = /(?:set-content|add-content|out-file|writealltext|copy-item|move-item|rename-item|remove-item|new-item)/i;

/** 判断一次工具调用是否属于 DSH 插件装配变更（规则 27 C 时序的“变更”侧） */
export function isAssemblyMutationTool(toolName, args) {
  const name = String(toolName || "");
  if (ASSEMBLY_TOOLS.has(name)) return true;
  const p = pathTarget(args);
  const cmd = commandText(args);
  if ((name === "edit" || name === "write" || (name === "str_replace_editor" && args?.command !== "view")) && p && ASSEMBLY_PATH_RE.test(p)) return true;
  if ((name === "pwsh" || name === "bash") && cmd && ASSEMBLY_CMD_RE.test(cmd) && ASSEMBLY_WRITE_CMD_RE.test(cmd)) return true;
  return false;
}

/** 判断命令是否为全量挂载审计脚本（规则 27 的“审计”侧）；读取/搜索脚本内容不算执行审计 */
export function isAuditCommand(command) {
  if (typeof command !== "string") return false;
  // 只要真正执行 audit-mount-consistency.mjs（node/npm/npx/bun/deno 开头），即使后面带管道过滤也算审计
  if (/\b(?:node|npm|npx|bun|deno)\s+[^\n]*audit-mount-consistency\.mjs/i.test(command)) return true;
  // 读取/搜索审计脚本本身不是执行审计
  if (/(?:get-content|cat|type|findstr|grep|more)\b/i.test(command)) return false;
  return false;
}

/**
 * v0.5.7 P0-1（用户拍板 2026-08-26）：验证类命令判定——运行测试/冷加载探针/挂载审计/语法检查。
 * 与"修/改/写"授权伴生放行使用：用户授权修改后，验证是变更的正常闭环，不再被
 * write vs command 类型不匹配误拦（今天实弹连卡 4 次）。
 */
export function isVerificationCommand(command) {
  if (typeof command !== "string") return false;
  if (/\b(?:node|npm|npx)\s+[^\n]*(?:run-all\.mjs|example-plugin-load\.mjs|audit-mount-consistency\.mjs|loader-smoke\.e2e\.mjs|verify-all\.mjs|health-audit\.mjs|--check|--test)\b/i.test(command)) return true;
  if (/\b(?:npm|pnpm)\s+(?:test|run\s+test)\b/i.test(command)) return true;
  return false;
}

/** 审计输出是否明确通过（无 DUPLICATES/INCONSISTENT/MISSING 且出现通过标记） */
export function auditOutputPassed(output) {
  const text = String(output || "");
  return /MOUNT CONSISTENT|NO duplicate loader entry ids found/i.test(text) && !/DUPLICATES FOUND/i.test(text) && !/INCONSISTENT/i.test(text) && !/\[MISSING\]/i.test(text);
}

/** 审计输出是否明确发现重复/缺失/不一致（含 3.6 缺失检测的 INCONSISTENT 与 [MISSING] 标记） */
export function auditOutputFailed(output) {
  return /DUPLICATES FOUND|INCONSISTENT|\[MISSING\]/i.test(String(output || ""));
}

/** 判断是否命中敏感操作（需要授权证据；只读操作永远不算）
 *  v0.5.7 P0-3（复查修复 2026-08-26）：透传 sessionId——"工作区外"判定需按会话精确根（多工作区
 *  模型：会话根优先；此前遗漏透传导致会话级根从未在运行时激活，只有全局兜底层生效）。 */
export function isSensitiveToolCall(toolName, args, sessionId) {
  if (isReadOnlyTool(toolName, args)) return false;
  const name = String(toolName || "");
  const p = pathTarget(args);
  const cmd = commandText(args);
  if (isProtectedConfigPath(p)) {
    // 只有变更类工具才受配置写保护；read/grep/glob 已在上方放行
    if (name === "edit" || name === "write" || name === "pwsh" || name === "bash") return true;
  }
  if (name === "pwsh" || name === "bash") {
    // P0-1c：受保护文件名检查必须配合「写类命令」——纯描述性文本（如 gh release --notes 里的
    // "AGENTS.md" 字样、echo 输出内容）不再触发敏感判定；真写类命令（Set-Content/Remove-Item 等
    // 命中 MUTATING_CMD_RE）提到受保护文件仍判敏感。
    if (cmd && (SENSITIVE_CMD.test(cmd) || (MUTATING_CMD_RE.test(cmd) && PROTECTED_FILENAME_RE.test(cmd)) || commandHasOutsideWrite(cmd, sessionId))) return true;
  }
  if (name === "edit" || name === "write") {
    if (p && (isProtectedConfigPath(p) || isOutsideWorkspace(p, sessionId))) return true;
  }
  if (name === "str_replace_editor" && args?.command !== "view") {
    if (p && (isProtectedConfigPath(p) || isOutsideWorkspace(p, sessionId))) return true;
  }
  if (GENERIC_EXEC_TOOLS.has(name)) return true;
  return false;
}

// ── 批次 5 文本健康检测词表（2026-08-24） ──────────────────────────────
/** 技术术语（规则 11③ 零基础表达：中文提问 + 术语 + 无解释 → 自证）。英文词带 \b，中文词组按字面。 */
export const TECH_TERM_RE =
  /\b(?:API|JSON|REST|WebSocket|OAuth|JWT|ORM|Schema|SSR|CSR|DI|Docker|Kubernetes|K8s|npm|pnpm|Node\.js|TypeScript|Git)\b|正则(?:表达|表达式)?|异步|回调|闭包|哈希|令牌|中间件|依赖注入|虚拟DOM|虚拟 DOM|数据库|SQL|序列化|反序列化|面向对象|函数式|类型推断|泛型/i;

/** 术语解释伴随词（出现任一 → 视为已解释，不触发密度自证） */
export const TERM_EXPLANATION_RE =
  /例如|比如|即\b|就是|简单说|换言之|类比|也就是说|通俗|直白|理解为|打个比方|举个例子/;

/** 建议类表述（规则 16 重复推销：会话内同类建议 ≥2 → 自证） */
export const SUGGEST_RE =
  /我建议|建议用|推荐|更优方案|建议(?:是|考虑|换成|用|来)|档位建议|不如换|优化建议/;

/**
 * v0.5.7 P0.5-6（用户拍板）：否定/合规声明语境（"不再/避免/停止/无 XX"）——那不是重复推销。
 * 粗筛层直接不计数（合规声明不产生重复计数）；语义判断权仍归裁决器，
 * 此处只为省钱（不送 LLM 裁决）并消除"自证--触发"噪音。
 */
export function isNegatingSuggestion(text) {
  if (typeof text !== "string") return false;
  return /(?:不再|不重复|避免|停止|取消|暂不|未再|不要(?:再)?|以后(?:不|别)|今后(?:不|别)|已呼应|已回应|无(?:新)?(?:建议|重复)|没有(?:新)?(?:建议|重复)|只等待)/.test(text);
}

/**
 * v0.5.7 P0.5-5（用户拍板）：承诺词处于引述/改写语境（"把'保证'改成…"）→ 是引述不是承诺。
 * 判定：词前 8 字符内配对开引号 + 词后 8 字符内配对闭引号；或前后 12 字符内引述标记词。
 */
export function isPromiseQuoteContext(text) {
  if (typeof text !== "string") return false;
  for (const m of text.matchAll(/(?:包在我身上|肯定能|绝对没问题|保证|一定可以|万无一失)/g)) {
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    // 引述包装 = 承诺词两侧 8 字符内都有引号（ASCII/中文弯引号均算；不区分左右——
    // ASCII 单引号左右同形，分区判定会自相矛盾；双侧近邻引号即视为被引述包裹）。
    const openNear = /[“"「『‘'””」』’]/.test(before.slice(-8));
    const closeNear = /[“"「『‘'””」』’]/.test(after.slice(0, 8));
    if (openNear && closeNear) return true;
    if (/引述|引用|原文|写过|改成|改为|换成/.test(before.slice(-12)) || /改成|改为|换成/.test(after.slice(0, 12))) return true;
  }
  return false;
}
