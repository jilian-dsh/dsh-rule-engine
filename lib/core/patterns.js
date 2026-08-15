// patterns.js - 规则引擎共享的正则与常量。
// 注意：本文件只放可测试的纯函数/常量，不依赖 Cordis。

export const INLINE_CMD =
  /\b(?:node|pwsh|powershell)\s+(?:-[ep]|--eval|--print|-Command|-c)\b/i;

export const BOM_WRITE =
  /(?:set-content|add-content|out-file|writealltext)[\s\S]{0,300}?(?:-Encoding\s+UTF8|utf8)[\s\S]{0,300}?\.(?:json|ya?ml)\b|(?:set-content|add-content|out-file|writealltext)[\s\S]{0,300}?\.(?:json|ya?ml)\b[\s\S]{0,300}?(?:-Encoding\s+UTF8|utf8)/i;

export const DESTRUCTIVE_CMD =
  /(?:remove-item|rm\s+-r|rmdir\s+\/s|rd\s+\/s|del\s+(?:\/[a-z]+\s+)*\/[a-z]*s[a-z]*|move-item|rename-item|copy-item\s+[^\n]*?(?:-\s*force|overwrite))/i;

export const SENSITIVE_CMD =
  /(?:git\s+(?:push|commit)|remove-item|rm\s+-r|rmdir\s+\/s|rd\s+\/s|del\s+\/s|move-item|rename-item|copy-item\s+[^\n]*?(?:-\s*force|overwrite))/i;

export const CONFIG_FILE_RE =
  /(?:^|[\\/])(?:AGENTS\.md|settings\.yaml|\.credentials\.yaml|workspace\.json|cordis\.patch\.yml|rule-understanding\.json|rule-guard\.json|rule-engine\.json)$/i;

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

const PS1_FILE_RE = /\.(?:ps1|psm1|psd1)(?=[\s'"`]|$)/i;

/** 判断是否命中规则 9 的「含中文 .ps1 未按 UTF-8 带 BOM」硬拦项 */
export function isChinesePs1Violation(toolName, args) {
  const name = String(toolName || "");
  const p = pathTarget(args);
  const cmd = commandText(args);
  const hasCJK = (s) => typeof s === "string" && CJK_RE.test(s);
  if ((name === "write" || name === "edit") && p && PS1_FILE_RE.test(p)) {
    const content = args?.content ?? args?.new_string ?? "";
    if (hasCJK(content)) return true;
  }
  if ((name === "pwsh" || name === "bash") && cmd && PS1_FILE_RE.test(cmd) && hasCJK(cmd)) {
    if (/(?:-Encoding\s+UTF8|utf8)/i.test(cmd)) return false;
    return true;
  }
  return false;
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "read_image"]);
const READONLY_CMD_RE =
  /(?:^|\s)(?:Get-Content|Get-ChildItem|Get-Item|Get-Command|Get-Date|Select-String|Find-String|Test-Path|Get-Process|Get-Service|cat|type|dir|ls|grep|findstr|more|netstat|where)\b/i;
const MUTATING_CMD_RE =
  /(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|Clear-Content|git\s+(?:push|commit)|rm\s+-r|rmdir\s+\/s|del\s+\/s|>|>>)/i;

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

function commandHasOutsideWrite(cmd) {
  if (typeof cmd !== "string") return false;
  if (!/(?:set-content|add-content|out-file|writealltext|copy-item|move-item|rename-item|new-item|remove-item)/i.test(cmd)) return false;
  const paths = cmd.match(ABS_PATH_RE) || [];
  return paths.some((p) => isOutsideWorkspace(p));
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
    if (cmd && (SENSITIVE_CMD.test(cmd) || /(?:AGENTS\.md|settings\.yaml|\.credentials\.yaml|workspace\.json|cordis\.patch\.yml|rule-understanding\.json|rule-engine\.json)/i.test(cmd) || commandHasOutsideWrite(cmd))) return true;
  }
  if (name === "edit" || name === "write") {
    if (p && (isProtectedConfigPath(p) || isOutsideWorkspace(p))) return true;
  }
  if (name === "str_replace_editor" && args?.command !== "view") {
    if (p && (isProtectedConfigPath(p) || isOutsideWorkspace(p))) return true;
  }
  return false;
}
