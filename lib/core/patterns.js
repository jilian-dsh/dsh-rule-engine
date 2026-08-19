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

export const SOURCE_MARK = /来源|出处|via|source|reference|引自|参考/i;

export const CJK_RE = /[\u4e00-\u9fff]/;

export const MANUAL_PATH_RE = /dsh-usage-manual[\\/]SKILL\.md/i;

export const DSH_KEYWORDS_RE =
  /DSH|dsh|插件|技能|规则|配置|迁移|手册|会话|装配|profile|bundle/i;

export const SKILL_EXEMPT = new Set(["dsh-usage-manual", "task-planner"]);

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
  /\b(?:Get-Content|Get-ChildItem|Get-Item|Get-Command|Get-Date|Select-String|Find-String|Test-Path|Get-Process|Get-Service|cat|type|dir|ls|grep|findstr|more|netstat|where)\b/i;
const MUTATING_CMD_RE =
  /(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|Clear-Content|git\s+(?:push|commit)|rm\s+-r|rmdir\s+\/s|del\s+\/s|(?:^|[^0-9])>>|(?:^|[^0-9])>)/i;

/** 判断命令文本是否只读（读文件/查询类，无写入/删除/提交副作用） */
export function isReadOnlyCommand(command) {
  if (typeof command !== "string") return false;
  if (MUTATING_CMD_RE.test(command)) return false;
  return READONLY_CMD_RE.test(command);
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

let workspaceRootOverride = "";

/** 由插件 apply 阶段从 workspaceRegistry 设置工作区根目录 */
export function setWorkspaceRoot(p) {
  workspaceRootOverride = p || "";
}

function workspaceRoot() {
  return workspaceRootOverride || process.env.DSH_WORKSPACE || "";
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

/** 判断路径是否在工作区外（用于“工作区外写入”敏感判定） */
export function isOutsideWorkspace(p) {
  if (typeof p !== "string") return false;
  if (!/^[a-z]:[\\/]/i.test(p) && !p.startsWith("/")) return false; // 只判断绝对路径
  return !isPathInside(p, workspaceRoot());
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

function commandHasOutsideWrite(cmd) {
  if (typeof cmd !== "string") return false;
  return writeTargetPathsFromCommand(cmd).some((p) => isOutsideWorkspace(p));
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

/** 审计输出是否明确通过（无 DUPLICATES/INCONSISTENT/MISSING 且出现通过标记） */
export function auditOutputPassed(output) {
  const text = String(output || "");
  return /MOUNT CONSISTENT|NO duplicate loader entry ids found/i.test(text) && !/DUPLICATES FOUND/i.test(text) && !/INCONSISTENT/i.test(text) && !/\[MISSING\]/i.test(text);
}

/** 审计输出是否明确发现重复/缺失/不一致（含 3.6 缺失检测的 INCONSISTENT 与 [MISSING] 标记） */
export function auditOutputFailed(output) {
  return /DUPLICATES FOUND|INCONSISTENT|\[MISSING\]/i.test(String(output || ""));
}

/** 判断是否命中敏感操作（需要授权证据；只读操作永远不算） */
export function isSensitiveToolCall(toolName, args) {
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
    if (cmd && (SENSITIVE_CMD.test(cmd) || (MUTATING_CMD_RE.test(cmd) && PROTECTED_FILENAME_RE.test(cmd)) || commandHasOutsideWrite(cmd))) return true;
  }
  if (name === "edit" || name === "write") {
    if (p && (isProtectedConfigPath(p) || isOutsideWorkspace(p))) return true;
  }
  if (name === "str_replace_editor" && args?.command !== "view") {
    if (p && (isProtectedConfigPath(p) || isOutsideWorkspace(p))) return true;
  }
  if (GENERIC_EXEC_TOOLS.has(name)) return true;
  return false;
}
