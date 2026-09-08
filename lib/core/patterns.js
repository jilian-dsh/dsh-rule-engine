// patterns.js - 规则引擎共享的正则与常量。
// 注意：本文件只放可测试的纯函数/常量，不依赖 Cordis。

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

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

/** 当下时间词（规则 2①：写当下相对时间前必须先 Get-Date 核对——A1 拆组，2026-09-03） */
export const TIME_WORDS =
  /今天|昨天|前天|上周|本周|刚才|\d+\s*分钟前/;

/** 历史日期/绝对日期（规则 2②：只要求事件证据锚，不要求 Get-Date——A1 拆组；含 ISO 格式，本机高频表述） */
export const HISTORIC_DATE_RE =
  /\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/;

/** 事件时间证据标注（规则 2②：过去事件时间必须绑定事件自身证据；"之前/当时"等模糊词不触发检测、不采信）
 *  A1 增补证据锚（2026-09-03）：commit hash / 版本号 / 踩坑 N / 版本记录 vX —— 历史日期带锚即视为已标注来源，免 Get-Date */
export const EVIDENCE_MARK_RE =
  /日志\s*(?:ts|时间戳)|mtime|启动时间|进程\s*StartTime|文件\s*修改时间|来源[:：]|ts\s*[:＝]|Get-Date\s*输出|事件时间已核实|【时间未核实】|\b[0-9a-f]{7,40}\b|\bv\d+(?:\.\d+){1,2}\b|踩坑\s*\d+|版本(?:记录)?\s*v\d+(?:\.\d+){1,2}/i;

export const PROMISE_WORDS =
  /包在我身上|肯定能|绝对没问题|保证(?!不|无法)|一定可以|放心(?:，|,)?肯定|万无一失/;

export const URL_RE = /https?:\/\/[^\s]+/i;

/** 回环/内网地址模式（规则 12C B 级留痕用） */
export const PRIVATE_NETWORK_RE =
  /(?:127\.0\.0\.1|localhost|169\.254\.169\.254|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})/i;

export const SOURCE_MARK = /来源|出处|via|source|reference|引自|参考/i;

export const CJK_RE = /[\u4e00-\u9fff]/;

export const DSH_KEYWORDS_RE =
  /DSH|dsh|插件|技能|规则|配置|迁移|手册|会话|装配|profile|bundle/i;

export const SELF_PROTECT_PATHS = [
  "**/rule-engine.json",
  "**/rule-understanding.json",
  "**/rule-guard.json"
];

/** 判断一条命令文本是否是「读取手册」类命令（manualPaths = 本机配置的手册路径列表；无配置 = 无对象，恒 false） */
export function isManualReadCommand(command, manualPaths = []) {
  if (typeof command !== "string") return false;
  if (!Array.isArray(manualPaths)) return false;
  const hit = manualPaths.some((pp) => command.toLowerCase().includes(String(pp).toLowerCase()));
  return hit && /get-content|cat|type|read|grep|findstr|str_replace_editor/i.test(command);
}

/** 本机追加文件路径匹配（A2-2 算法）：相对 DSH_HOME 归一化 + 大小写不敏感 + 包含比较。
 *  manualPaths 为空 = 无本机配置 = 恒 false（守卫无对象，自然静默）。 */
export function matchManualPath(p, manualPaths = []) {
  if (typeof p !== "string" || !Array.isArray(manualPaths)) return false;
  const norm = (s) => s.replace(/\\/g, "/").replace(/^["']+|["']+$/g, "").toLowerCase();
  const n = norm(p);
  return manualPaths.some((pp) => n.includes(norm(String(pp))));
}

/** 判断一次工具调用是否算作「已读手册」（manualPaths = 本机配置的手册路径列表；无配置 = 无对象，恒 false） */
export function isManualReadTool(toolName, args, manualPaths = []) {
  const name = String(toolName || "");
  if (name === "read" || name === "grep" || name === "str_replace_editor") {
    const p = String(args?.file_path || args?.path || args?.pattern || "");
    if (isManualReadCommand(p, manualPaths)) return true;
  }
  if (name === "pwsh" || name === "bash") {
    return isManualReadCommand(args?.command || args?.code || "", manualPaths);
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
  /(?:\b(?:Get-Content|Get-ChildItem|Get-Item|Get-Command|Get-Date|Select-String|Find-String|Test-Path|Get-Process|Get-Service|Get-ItemProperty|Get-Variable|Get-FileHash|cat|type|dir|ls|grep|findstr|more|netstat|where|echo|Write-Output|Write-Host|Get-Location|pwd|cwd|Get-Help|help|Select-Object|Out-String|Format-Table|Format-List|Format-Wide|Measure-Object|Sort-Object|Where-Object|Group-Object|ForEach-Object|Out-Null|ConvertTo-Json|ConvertFrom-Json|Join-Path|Split-Path|Resolve-Path|New-Object|Add-Type|Get-Member|Get-ChildItemProperty|Get-CimInstance|Get-WmiObject)\b)|(?:\bgit\s+(?:-[^\s]+\s+[^\s]+\s+|--[^\s]+\s+)*\b(?:status|log|diff|show|branch|tag|remote|rev-parse|diff-tree|ls-files)(?:\s|$))|(?:\bgit\s+ls-remote(?:\s|$))|(?:\bdsh\s+(?:--version|--help|--dump-config|plugin\s+(?:list|show|status))(?:\s|$))|(?:\bdsh\s+--profile\s+[^\s]+\s+(?:--dump-config|plugin\s+(?:list|show|status))(?:\s|$))|(?:\bnode\s+(?:--check|--test|--version)(?:\s|$))|(?:\bnpm\s+(?:test|run\s+test)(?:\s|$))|(?:\bpnpm\s+(?:test|run\s+test)(?:\s|$))|(?:\bgh\s+(?:auth\s+status|repo\s+view|release\s+view|issue\s+view|pr\s+view|run\s+view)(?:\s|$))|(?:\bnpm\s+(?:ls|view)(?:\s|$))|(?:\bgh\s+api\b(?![^\r\n;|]*?\s(?:-X|--method|graphql|-F|-f)\s)[^\r\n;|]*$)|(?:\bcmdkey\s+(?:\/list|\/list:[^\s]+)(?:\s|$))|(?:\b(?:if|elseif|else|foreach|while|switch|for|do|try|catch|finally)\b(?:\s*\(|\s|\{|$))/i;
const MUTATING_CMD_RE =
  /(?:Set-Content|Add-Content|Out-File|Tee-Object|Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|Clear-Content|Start-Process|Invoke-Expression|Invoke-Item|Export-Csv|Export-Clixml|Export-ModuleMember|Compress-Archive|Expand-Archive|Add-Type\s+-Output(?:Assembly|Type)|git\s+(?:push|commit)|rm\s+-r|rmdir\s+\/s|del\s+\/s|(?:^|[^0-9])(?:\d*>|\d*>>|>|>>)(?!\s*&\s*\d|\s*\$?(?:null|nul)\b)|(?:curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)\s+(?=[^\n;|]*\s(?:-o|--output|-OutFile|OutFile)\s))/i;
// 0.5.12（F4）：PowerShell 别名展开表——写/删除/移动/执行别名 → 标准 cmdlet 名
// 供 normalizeAliases 做命令规范化（MUTATING_CMD_RE 覆盖完整 cmdlet；别名先展开再判）
const PS_ALIAS_MAP = [
  [/^rm\b(?![a-z])/i, "Remove-Item"], [/^rd\b(?![a-z])/i, "Remove-Item"], [/^ri\b(?![a-z])/i, "Remove-Item"],
  [/^del\b(?![a-z])/i, "Remove-Item"], [/^erase\b(?![a-z])/i, "Remove-Item"],
  [/^cp\b(?![a-z])/i, "Copy-Item"], [/^copy\b(?![a-z])/i, "Copy-Item"],
  [/^mv\b(?![a-z])/i, "Move-Item"], [/^move\b(?![a-z])/i, "Move-Item"],
  [/^ren\b(?![a-z])/i, "Rename-Item"], [/^iex\b(?![a-z])/i, "Invoke-Expression"],
  [/^gc\b(?![a-z])/i, "Get-Content"], [/^gci\b(?![a-z])/i, "Get-ChildItem"], [/^gi\b(?![a-z])/i, "Get-Item"],
  [/^gp\b(?![a-z])/i, "Get-ItemProperty"], [/^gv\b(?![a-z])/i, "Get-Variable"], [/^gl\b(?![a-z])/i, "Get-Location"]
];
/** 规范化命令文本中的 PS 别名 → 标准 cmdlet 大写（只变换命令头，不动参数/字符串） */
export function normalizeAliases(command) {
  const s = String(command || "");
  return s.replace(/(?:^|[\s;|&{(])\s*(rm|rd|ri|del|erase|cp|copy|mv|move|ren|iex|gc|gci|gi|gp|gv|gl)(?=\s+)/gi, (m, name) => {
    const hit = PS_ALIAS_MAP.find(([re]) => re.test(name));
    return hit ? `${m.slice(0, m.length - name.length)}${hit[1]}` : m;
  });
}
// .NET 静态/实例写方法（MUTATING 补充：Set-Content 等 cmdlet 之外的写路径）
const MUTATING_METHOD_RE =
  /(?:\[[\w.]+\]::\s*(?:Write|Set|Remove|Delete|Move|Copy|Create|Save|Append)\w*\s*\(|\.(?:Write(?:AllText|Line|Bytes|Text)?|SetContent|MoveTo?|CopyTo|Delete|Remove|SaveAs?2?\s*\(|CreateDirectory|CreateFile|WriteLine)\s*\()/i;
// B1（阶段一，2026-08-28）：只读豁免——白名单之外的"分明无害段"（纯变量赋值 / COM 只读打开 /
// 内容属性读取 / 变量引出），让读取 .doc 的 COM 命令（Open(...,$true)+Content.Text）不再误判写。
// 保守边界：内容属性赋值（$doc.Text=... / $doc.Content.Text=...）是写文档，不豁免。
const COM_CONTENT_ASSIGN_RE = /\.(?:Text|Content|Value|Range|Paragraphs|Sections|Documents|Document)\s*=/i;
const ALLOW_SEG_RE =
  /(?:\$[A-Za-z_][\w$]*(?:(?:\.[\w$]+)|(?:\[[^\]]+\]))*\s*=)|(?:\$[\w$.]+\.(?:Content|Range|Text|Value|Paragraphs|Sections|Length|Count|Name|Selected|LinkType|Target|FullName|Extension|Directory|PSPath|Property|Attributes|Mode|LastWriteTime|Exists|Line|Error|Errors|Matches|Groups|Success|ExitCode|Output|Stderr|Stdout|Items|Keys|Values|Entries|Timestamp|DateTime)\b)|(?:\$[\w$.]+\.(?:Trim|Substring|ToString|ToLower|ToUpper|TrimStart|TrimEnd|Replace|Split|Join|Contains|StartsWith|EndsWith|IndexOf|LastIndexOf|GetType|ToCharArray|PadLeft)\s*\()|(?:\$[\w$.]+$)|(?:\b(?:Documents|Document)\.(?:Open|Item)\s*\([^)]*,\s*\d+\s*,\s*\$?true\s*\))|(?:\(!?\$[\w$.]+(?:\.\w+)?\)|\([^()\r\n]*\$[\w$.]+\.[\w.]+\s*\))/;
// 0.5.12（F4）：纯字符串/纯输出段（整段是引号包裹字符串或 $() 子表达式）——不是命令，放行。
// 保守边界：只匹配"整段即字符串"（^...$ 锚定），不让 node -e "..." / curl -o "..." 借道。
const PURE_STRING_SEG_RE = /^(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|\$\(\s*[^()\r\n]*\s*\))+$/;
// 剥离 try/catch/finally 控制块：块内语句与主语句同样接受只读判定（Try-* 不是 cmdlet）。
// 注意：不做全量 [{}] 替换——if/else 子表达式（$(if(...){...}else{...})）会被切碎误判。
function stripControlBlocks(command) {
  return String(command)
    .replace(/try\s*\{([\s\S]*?)\}\s*catch\s*\([^)]*\)\s*\{([\s\S]*?)\}/gi, "$1; $2")
    .replace(/try\s*\{([\s\S]*?)\}\s*catch\s*\{([\s\S]*?)\}/gi, "$1; $2")
    .replace(/try\s*\{([\s\S]*?)\}\s*finally\s*\{([\s\S]*?)\}/gi, "$1; $2")
    .replace(/^[\s]*(?:try|catch(?:\([^)]*\))?|finally)\s*\{[^\S\n]*(?:#.*)?\s*$/gm, ";")
    .replace(/^\s*\}\s*(?:catch(?:\([^)]*\))?|finally)?\s*\{?\s*$/gm, ";");
}

/** 写/删除/提交类命令判定（0.5.10 单真源：guard-core self-protect 等全部复用——修复 Write-Output 被 `write` 子串误杀） */
export function isMutationCommand(command) {
  return typeof command === "string" && MUTATING_CMD_RE.test(command);
}

/** 只读命令链按分隔符折段（机制 B，2026-08-24）：`; 换行 && || |`（管道前后是命令链；`2>&1`/`2>$null` 的 stderr 重定向不拆分） */
function splitCommandSegments(command) {
  return String(command)
    .split(/\r?\n|;|&&|\|\||(?<!\d)\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 判断命令文本是否只读（读文件/查询类，无写入/删除/提交副作用）。
 *  2026-08-24 分段化：整条命令按 ; | & 换行拆段，每段都必须只读——
 *  修复 "git -C <dir> status" 变体不匹配、"git status; echo ok" 链式被误判为写 的实测缺陷。
 *  B1（2026-08-28 阶段一）：段判定三档化，修复只读豁免失效（读取 .doc 的 COM 命令被判写）：
 *    ① 写特征（MUTATING_CMD_RE / MUTATING_METHOD_RE / 内容属性赋值）→ 非只读；
 *    ② 白名单命令 / 分明无害段（纯变量赋值、COM 只读打开、内容属性读取、变量引出）→ 只读；
 *    ③ 其它不认识的段 → 保守判非只读（不放大白名单，宁紧勿松）。 */
export function isReadOnlyCommand(command) {
  if (typeof command !== "string") return false;
  // 0.5.12（F4）：先做别名规范化（rm→Remove-Item、gc→Get-Content…），
  // 保证 MUTATING/READONLY 词表只看标准 cmdlet（别名双向缺口：写漏 rm/del/iex、读漏 gc/gci）
  const normalized = normalizeAliases(command);
  const segments = splitCommandSegments(stripControlBlocks(normalized));
  if (segments.length === 0) return false;
  return segments.every((seg) => {
    const s = String(seg).trim();
    if (!s) return true; // 剥离残留的空段放行
    if (s.startsWith("#")) return true;
    if (MUTATING_CMD_RE.test(s)) return false;
    if (MUTATING_METHOD_RE.test(s)) return false;
    if (COM_CONTENT_ASSIGN_RE.test(s)) return false; // $doc.Text=... 是写文档
    if (READONLY_CMD_RE.test(s)) return true;
    if (ALLOW_SEG_RE.test(s)) return true;
    if (PURE_STRING_SEG_RE.test(s)) return true; // 0.5.12（F4）：纯字符串/输出段（非命令）
    return false; // 看不清的段：保守按非只读处理
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

// ═══════════ 0.5.10 分析通道（用户多次提出"只读分析需要写临时脚本/输出"）═══════════
// 0.5.11（用户定稿）：移除"repo scripts/*.mjs 一律=分析"的语义豁免——脚本名判不了脚本干什么，
// 执行类脚本（release/inject/uninstall 等）会借道放行（执行口径漏洞）。语义判给模型；
// 本通道只保留物理判据：严格只读（isReadOnlyTool）+ 分析临时区写（logs/.analysis-tmp/.backups
// 按路径段机械判定）+ 下载到临时区。红线由 guard-core 追加（工作区外/受保护名/覆盖既有）。
const ANALYSIS_SCRATCH_SEG_RE = /(?:^|[\\/])(?:logs|\.analysis-tmp|\.backups)[\\/]/i;
// 0.5.10 建议：远程下载到临时区（调研场景 curl/iwr/wget -o 临时区 → analysis；12C 联网审查照旧）
// 目标支持引号包裹（含空格路径）+ 裸 token
const DOWNLOAD_OUT_RE = /(?:curl|wget|iwr|Invoke-WebRequest)(?:(?!\n)[^&;|])*?(?:-o\s+|OutFile\s+|>\s*)\s*(?:'([^']+)'|"([^"]+)"|([^\s"'&;|]+))/i;

/** 是否分析临时区路径（logs/.analysis-tmp/.backups 段；工作区外红线由 guard-core 用 isOutsideWorkspace 把关） */
export function isAnalysisScratchPath(p) {
  if (typeof p !== "string" || !p) return false;
  return ANALYSIS_SCRATCH_SEG_RE.test(p.replace(/\\/g, "/"));
}

/** 提取命令文本中命中分析临时区的路径 token（保守：仅取带临时区特征的片段） */
export function extractAnalysisScratchPaths(command) {
  const n = String(command || "");
  const out = [];
  const re = /(?:logs|\.analysis-tmp|\.backups)[\\/][^\s"'&|;]+/gi;
  let m;
  while ((m = re.exec(n))) out.push(m[0].replace(/\\/g, "/"));
  return out;
}

/**
 * 分析类操作判定（0.5.10 单真源；0.5.11 修订）：true = 可按 analysis 放行（无副作用，或副作用仅限分析临时区）。
 * 场景：① 严格只读（isReadOnlyTool）；②（已移出，0.5.11）脚本区调用不再按"目录=分析"放行——
 *      脚本名判不了脚本行为，执行类脚本（release/inject/uninject 等）曾借道放行；语义判给模型；
 *      ③ 临时区写（命令含写特征且提取到的目标路径全部命中分析临时区，且无受保护文件名）。
 * 红线（guard-core 追加，本函数不含）：工作区外路径（isOutsideWorkspace）、受保护名、覆盖既有正式文件。
 */
export function isAnalysisOp(toolName, args) {
  const name = String(toolName || "");
  if (isReadOnlyTool(name, args)) return true;
  const cmd = commandText(args) || "";
  // A 方案（2026-08-28）：write/edit 工具直接写分析临时区（logs/.analysis-tmp/.backups 路径段）
  // → 分析通道放行（方案回合"写临时脚本/产物"是调研工具，不是落盘；0.5.10 只覆盖 pwsh 命令，
  // write 工具写临时区此前误判正式路径 → A 拦截误伤调研工具）。红线同 pwsh：受保护名不豁免。
  if (name === "write" || (name === "str_replace_editor" && args?.command !== "view")) {
    const p = pathTarget(args);
    if (p && isAnalysisScratchPath(p) && !PROTECTED_FILENAME_RE.test(p)) {
      return true;
    }
  }
  if (name === "node" || name === "pwsh" || name === "bash") {
    // ㊄ 验证通道（2026-08-31，用户定稿）：验证类命令（测试/体检/探针/审计/dry-run/只读查询）
    // 独立放行——调研/验证灵活性与"执行类"严格授权分层；清单见 isVerificationCommand（执行类不匹配）。
    if (isVerificationCommand(cmd)) return true;
    // ③ 临时区写：写命令（不含删除/移动——删除/移动属 13A 红线，不走分析豁免）+ 提取路径全部命中临时区 + 无受保护名
    if (isMutationCommand(cmd) && !/(?:Remove-Item|Move-Item|Rename-Item|del\s|rm\s|git\s+push|git\s+commit)/i.test(cmd)) {
      const paths = extractAnalysisScratchPaths(cmd);
      if (paths.length > 0 && paths.every((p) => isAnalysisScratchPath(p)) && !PROTECTED_FILENAME_RE.test(cmd)) {
        return true;
      }
    }
    // ④ 远程下载到分析临时区（调研场景：下载 tgz/网页到临时区再解压查看；12C 联网审批与内网审查照旧）
    const dl = cmd.match(DOWNLOAD_OUT_RE);
    const dlTarget = dl ? (dl[1] || dl[2] || dl[3] || "") : "";
    if (dlTarget && isAnalysisScratchPath(dlTarget) && !PROTECTED_FILENAME_RE.test(cmd)) {
      return true;
    }
  }
  return false;
}

// ═══════════ 0.5.10 已知环境坑特征表（建议5——错误码自动召回，K-01/K-05 依据）═══════════
// 工具/命令错误文本命中特征 → 审计 error-hint + 注入指向知识库的提示（低频：仅命中才提示；语义=指路不打扰）。
const KNOWN_PITFALLS = [
  { key: "SEC_E_NO_CREDENTIALS", re: /SEC_E_NO_CREDENTIALS/i, hint: "TLS 凭据失败（常见于沙箱/受限会话）——先查手册踩坑 60/89；Node fetch 配 NODE_USE_ENV_PROXY 可绕" },
  { key: "proxy-7890-refused", re: /ECONNREFUSED[^\n]*7890/i, hint: "代理端口 7890 无监听——确认代理软件已启动；git/gh 可直连，npm registry 直连本机不可用（发布脚本默认直连，DSH_RELEASE_PROXY 可指定）" },
  { key: "sandbox-pipe-EPERM", re: /EPERM/i, hint: "受限沙箱下子进程管道受限（踩坑 22⑤）——需 danger-full-access 运行" },
  { key: "ERR_MODULE_NOT_FOUND", re: /ERR_MODULE_NOT_FOUND/i, hint: "模块缺失——检查依赖闭包/空壳目录（踩坑 54）" }
];

/** 已知坑特征匹配（纯函数）：错误文本命中特征表 → 返回条目；未命中 → null */
export function matchKnownPitfall(text) {
  const t = String(text || "");
  for (const p of KNOWN_PITFALLS) if (p.re.test(t)) return p;
  return null;
}

export { KNOWN_PITFALLS };

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
 * 2026-09-06 M7 修复：opts.askApproved（本回合已获 ask 授权答复）→ 豁免——ask 答复后同一任务落盘
 * 不再被保守误报 approval-gap（12A 授权链已由 ask 建立，M7 不重复提醒）。
 */
const PLAN_INSTRUCTION_RE = /方案|调整|补充|建议|评估|草案|完善|优化|改进|提炼|重构|梳理/;
const WRITE_INSTRUCTION_RE = /落盘|写入|发布|正式写入|正式落盘|改为|改成|保存到手册|写进手册|确定为|确认后(?:落盘|写入|发布)/;
// 2026-09-06 0.6.x：建议+执行并存（"按第三方的建议按顺序执行修改"）=执行分点——执行词豁免（M7 误报修复）
const EXECUTE_ACTION_RE = /执行|推进|实施|开始|落实|继续|启动|办理|开展|落地|操作|运行/;
export function needsApprovalReminder(userText, opts = {}) {
  const t = String(userText || "");
  if (!t) return false;
  if (opts.askApproved) return false; // M7 修复：ask 授权答复豁免 approval-gap
  if (!PLAN_INSTRUCTION_RE.test(t)) return false;
  if (EXECUTE_ACTION_RE.test(t)) return false; // 0.6.x：方案词+执行词并存=执行指令（"按建议执行"含执行语）
  return !WRITE_INSTRUCTION_RE.test(t);
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
 * 2026-08-31（验证通道放行面，用户定稿）：清单扩展 + 由 isAnalysisOp 独立调用——
 * ① 单测通配（任意 *.test.mjs）、② 验证/门禁脚本（check-tool-coverage / publish-aptitude-check）、
 * ③ --dry-run（发布脚本 dry-run=只读推导，发布链无 dry-run 不匹配）、④ gh api 只读 GET、npm whoami。
 * 安全边界：执行类脚本（release-plugin 无 --dry-run / inject / uninject / install / publish / commit /
 * push / Remove-Item 等）一律不匹配——执行类仍走授权语义严格版（0.5.11 防借道回归不放松）。
 */
export function isVerificationCommand(command) {
  if (typeof command !== "string") return false;
  if (/\b(?:node|npm|npx)\s+[^\n]*(?:run-all\.mjs|audit-mount-consistency\.mjs|loader-smoke\.e2e\.mjs|verify-all\.mjs|health-audit\.mjs|check-tool-coverage\.mjs|publish-aptitude-check\.mjs|\.test\.mjs\b|--check|--test|--dry-run)\b/i.test(command)) return true;
  if (/\b(?:npm|pnpm)\s+(?:test|run\s+test)\b/i.test(command)) return true;
  if (/\bgh\s+api\b/i.test(command)) {
    // 只读 GET 形态；写形态（--method/-X 显式方法、-F/--field 表单）不豁免（gg api 写=执行类）
    return !/(?:--method|-X)\s+(?:POST|PUT|PATCH|DELETE)|\s-(?:F|f)\s|--field\s/i.test(command);
  }
  if (/\bnpm\s+whoami\b/i.test(command)) return true;
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

/**
 * v0.5.7 后续（2026-08-26 用户拍板，承诺兑现）：工作区内低风险变更判定——规则 12A 正文
 * "工作区内低风险新建"豁免的机器实现（此前只修了相邻项：--profile 模板/多工作区根/验证伴生；
 * 本项未修——只读诊断脚本被拦的承诺闭环于此）。edit/write 且：目标在工作区内 / 非受保护路径 /
 * 非插件装配文件 / 非高风险启动入口 → 低风险变更（22-7 无执行分点回合也放行；12A 侧
 * isSensitiveToolCall 本就对工作区普通文件返回 false）。
 */
export function isLowRiskWorkspaceNew(toolName, args) {
  const name = String(toolName || "");
  if (name !== "edit" && name !== "write") return false;
  const p = pathTarget(args);
  if (!p) return false;
  if (isProtectedConfigPath(p)) return false;
  if (isOutsideWorkspace(p)) return false;
  if (isAssemblyMutationTool(name, args)) return false;
  if (isHighRiskEntryFile(p)) return false;
  // 0.5.11（用户定稿）：豁免原文是"工作区内低风险**新建**"——"新建"=目标尚不存在。
  // 已存在的文件无论编辑还是覆盖写入都算变更（改旧文件），不是新建 → 不豁免，走正常授权判定。
  // 相对路径无法判定存在性 → 保守不豁免（宁要授权，不放行未知目标的覆盖）。
  if (p) {
    if (!isAbsolute(p)) return false;
    if (existsSync(p)) return false;
  }
  return true;
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
 * 通用引述/转述语境判定（2026-08-29 B3，取代 isPromiseQuoteContext 单一用途）：
 * 给定词表 wordRe 每次命中，处于 ① 引号包裹（词两侧 8 字符内配对引号）或
 * ② 转述/改写语境 → 视为引述而非断言（规则 2 时间词 / 规则 7 承诺词通用）。
 * 转述语境 = 第三人称对象 + 说/表示/提到…（before 14 字符内），或引述/转述/原文/改成类标记。
 * 不豁免第一人称（"我说保证"仍按承诺——承诺转述不了自己）。
 * 修复背景：B3 规则 7 仅认引号+白名单标记词，无引号转述（"用户之前说万无一失"）误报；
 * 规则 2 原本无引述豁免（引述用户原话"昨天"也报未核对）。
 */
const PARAPHRASE_BEFORE_RE =
  /(?:用户|你|他|她|它|对方|作者|维护者|客户|大家|网友|某人|群友|别人).{0,6}?(?:说|说过|表示|提到|提到过|称|强调|认为|写道|原话)/;
const PARAPHRASE_MARK_BEFORE_RE = /引述|引用|原文|转述|转发|据\S{0,5}说|写过|改成|改为|换成/;
const PARAPHRASE_MARK_AFTER_RE = /改成|改为|换成|转述|引用/;

export function isQuoteOrParaphraseContext(text, wordRe) {
  if (typeof text !== "string" || !(wordRe instanceof RegExp)) return false;
  // matchAll 要求全局正则；用副本（不污染共享词表的 lastIndex）
  const re = new RegExp(wordRe.source, wordRe.flags.includes("g") ? wordRe.flags : wordRe.flags + "g");
  for (const m of text.matchAll(re)) {
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    // 引述包装 = 承诺词两侧 8 字符内都有引号（ASCII/中文弯引号均算；不区分左右——
    // ASCII 单引号左右同形，分区判定会自相矛盾；双侧近邻引号即视为被引述包裹）。
    const openNear = /[“"「『‘'””」』’]/.test(before.slice(-8));
    const closeNear = /[“"「『‘'””」』’]/.test(after.slice(0, 8));
    if (openNear && closeNear) return true;
    if (PARAPHRASE_BEFORE_RE.test(before.slice(-14))) return true;
    if (PARAPHRASE_MARK_BEFORE_RE.test(before.slice(-12))) return true;
    if (PARAPHRASE_MARK_AFTER_RE.test(after.slice(0, 12))) return true;
  }
  return false;
}

/** v0.5.7 P0.5-5（用户拍板）+ B3 扩展：承诺词处于引述/改写/转述语境 → 是引述不是承诺 */
export function isPromiseQuoteContext(text) {
  return isQuoteOrParaphraseContext(text, PROMISE_WORDS);
}
