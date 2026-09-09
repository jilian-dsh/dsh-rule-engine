// authorization.js - 授权证据结构化匹配（P0：授权关联具体操作，区分询问与授权）
// 纯函数，可独立测试。
import { GENERIC_EXEC_TOOLS, pathTarget, commandText, writeTargetPathsFromCommand, extractCopyPaths } from "./patterns.js";
import { questionWordsRe } from "./lexicon.js";
import {
  approvalExecRe,
  directiveWordsRe,
  rejectionWordsRe,
  planOnlyRe,
  actionWordsRe
} from "./lexicon.js";

export const AUTH_TTL_MS = 10 * 60 * 1000;

// 0.5.11（用户拍板）：词表唯一源 = lexicon.js——授权判定所用的许可词/指令词/拒绝词/动作词
// 一律从那里取；本文件不再自持定义。
// P8 小批 A（2026-09-08）：词表改经函数取（approvalExecRe() 等）——配置层注入后立即生效；
// 顶层 `const X = SOME_RE` 缓存会锁死内置值，故本文件不再保留任何正则别名。
// 遗留（本批范围外，如实记账）：下面这份 APPROVAL_RE 是本文件自持的第二份许可词定义，
// 与 lexicon.approval 存在漂移（多"是/执行/去吧/开始"、少"行"）——本批保持行为等价不动，
// 是否合并/迁入配置待第三方裁定（迁入会改变判定结果，不属"等价迁移"）。
const APPROVAL_RE = /(?:允许|同意|可以|是|好|确认|授权|执行|批准|去吧|开始|ok|yes)/i;

const TYPE_HINTS = [
  { re: /删除|移除|remove|delete/i, type: "delete" },
  { re: /修改|编辑|替换|写入|写(?:入|文件|作|下|好|完|成)?|改(?:为|成)?|保存|另存为|转化|转换|edit|write|replace/i, type: "write" },
  { re: /备份|backup/i, type: "backup" },
  { re: /git\s+(push|commit)|提交|推送/i, type: "git" },
  // 命令类只在有明确命令上下文时推断；"执行/开始/做"等宽泛指令保持 any，避免把普通文件变更误限为 command
  // 0.5.12（F1 重证）：command 规则补 ①引号包裹路径 ②无扩展名可执行文件（tsc/tsdown 等）
  // ③pnpm/yarn/bun 显式收录（此前靠 npm\s+ 子串巧合命中 pnpm，非设计保证）
  { re: /命令|运行|执行\s*(?:命令|脚本|以下|程序)|run|execute|pwsh|bash|node\s+(?!-e\b|-p\b|--eval\b|--print\b)(?:['"])?[\w./\\-]+(?:['"])?(?:\s|$)|(?:npm|pnpm|yarn|bun)\s+(?:run|exec|install|add)|(?:^|[^a-z])(?:tsc|tsdown|vite|webpack|rollup)\b/i, type: "command" },
  // 2026-08-31（skill 词残留收紧）：12B 已禁用（技能调用流程），原 /技能|skill/i 把任意文本中的
  // "Skill"名词（如 repo 描述）判成技能类→授权范围不匹配误拦（VCI2RX 实证）。
  // 收紧为**真实技能操作**（skill 工具/技能目录管理上下文），名词性"Skill"不再命中。
  { re: /(?:技能|skill)\s*(?:调用|目录|管理|列表|启用|禁用|安装|删除|加载|查询)|(?:启用|禁用|调用|安装|删除|加载|查询|打开|查看|管理)\s*技能|(?:启用|禁用|调用|安装|删除|加载|查询|打开|查看|管理)\s*skill\b|skill\s+(?:tools?|dir|enable|disable|list|install)\b|\/guard\s+skills?\b/i, type: "skill" },
  // 0.5.12（F1 重证）：network 词表由裸子串改词边界+上下文——`fetch` 出现在目录名/标识符中
  //（dsh-web-fetch-playwright）不再误判；真网络形态（URL/调用/下载动词）仍命中
  { re: /下载|网络|https?:\/\/\S*|(?:^|[^a-z])(?:curl|fetch|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)\s*(?:\(|\.|[^\w]|$)/i, type: "network" },
  // 只读/审查类（置末位，2026-08-25 RB-05）：不覆盖在前类别的变更语义（“修改并审查”仍按 write/delete），
  // 仅当无其它类型命中时给只读类型——配合 ACTION_RE 只读词（审查/阅读/验证等），使“审查文件”类执行分点
  // 授权类型为 analysis（只读），不再落入 any 宽泛授权。
  { re: /审查|阅读|查看|核对|检查|审阅|复核|查阅|验证|对照|评估|分析|研究|排查|核实|梳理|调查|诊断|读取|读(?:出|一下|一遍|完)?|展示|打开|提取/i, type: "analysis" },
  // C4（2026-09-04）：archive 独立类型（解压/归档高频用例；物理确认最小范围）
  { re: /解压|解包|解压缩|归档|unzip|expand-archive|extract-archive|tar\s+-x|7z\s+x/i, type: "archive" }
];

// ── C4（2026-09-04）：类型提示配置化 + 物理确认类型枚举 ──
// typeHintsOverride = null → 内置表；非空 → 完全替换（clear 语义）；空 → 还原内置。
let typeHintsOverride = null;

function isValidHint(h) {
  if (!h || typeof h.type !== "string" || h.type.length === 0 || h.type === "any") return false;
  if (typeof h.re !== "string") return false;
  try {
    new RegExp(h.re, "i");
    return true;
  } catch {
    return false;
  }
}

function normalizeHints(list) {
  const out = [];
  for (const h of list) {
    if (!isValidHint(h)) continue;
    if (!out.some((x) => x.type === h.type)) out.push({ type: h.type, re: new RegExp(h.re, "i") });
  }
  return out;
}

/** C4：配置层扩展/替换授权类型提示；空列表 = 还原内置；{ clear: true } = 完全替换（不含内置） */
export function setTypeHints(hints, opts = {}) {
  const list = Array.isArray(hints) ? hints : [];
  if (list.length === 0) {
    typeHintsOverride = null;
    return;
  }
  const normalized = normalizeHints(list);
  typeHintsOverride = opts?.clear ? normalized : [...TYPE_HINTS, ...normalized];
}

/** C4：当前生效的类型枚举（内置 9 类 + 配置扩展；any=全局通配被禁止，不枚举） */
export function APPROVE_TYPES() {
  const hints = typeHintsOverride ?? TYPE_HINTS;
  const types = [];
  for (const h of hints) {
    if (h && typeof h.type === "string" && h.type !== "any" && !types.includes(h.type)) types.push(h.type);
  }
  return types;
}

function currentHints() {
  return typeHintsOverride ?? TYPE_HINTS;
}

// C2（2026-08-28 阶段二）：`、`（中文顿号）从非路径字符黑名单移除——Windows 中文目录名
// 常见顿号（"D:\1、示例\..."——用户工作目录），原正则在此截断 → 授权记录成 "d:/1"，
// 真实操作路径匹配失败（ERR-LU50QQ：已授权范围 [write d:/1] 拦 d:/1、示例/练习/...）。
// 保守边界：顿号后跟空格+新词时可能合并（fail-closed——提取过长 → 授权匹配失败 → 拦而非放），
// 不放大授权；引号包裹分支本就不受此影响。
const PATH_TOKEN_RE = /["'][A-Za-z]:[\\/](?!\/)[^"']+["']|[A-Za-z]:[\\/](?!\/)[^\s'"`，。；：！？（）【】《》]+|(?:^|[\s"'`])\/(?:[^\s"'`，。；：！？（）【】《》、]+)/g;

export function normalizePath(p) {
  if (typeof p !== "string") return "";
  return p.replace(/\\/g, "/").toLowerCase();
}

/** 从文本推断操作类型（取第一个命中） */
export function inferTypeFromText(text) {
  const s = String(text || "");
  for (const hint of currentHints()) {
    if (hint.re.test(s)) return hint.type;
  }
  return "any";
}

/** 0.5.10 建议1①（用户审查采纳）：ask 答复文本 → 结构化操作类型（修复"弹窗授权宽泛 any 接不住真操作"）。
 *  返回 write | command | any（analysis/artifact 类本就不需授权，不落入授权记录）。
 *  明确操作词 → 具体类型；含糊/纯查看 → any（保守：TTL 短兜底）。 */
/** ask 授权类型推导（E3/簇 A 配置化）：接入 TYPE_HINTS（内置表含 git 类）+ 配置层 typeHints 扩展共同生效。
 *  多类型命中按具体类优先序取（delete/backup/git/network/archive/skill > write > command > analysis）；无命中 → any（保守）。
 *  原硬编码 write/command 两正则废弃——与 hints 表漂移（"提交/覆盖"等中文词误映射）的风险源。 */
const ASK_SCOPE_PRIORITY = ["delete", "backup", "git", "archive", "skill", "write", "command", "network", "analysis"];
export function classifyAskScopeType(text) {
  const s = String(text || "");
  const hints = currentHints();
  const hits = [];
  for (const h of hints) if (h.re.test(s)) hits.push(h.type);
  if (hits.length === 0) return "any";
  for (const t of ASK_SCOPE_PRIORITY) if (hits.includes(t)) return t;
  return hits[0];
}

/** 从文本推断全部命中的操作类型（用于一条子句含多个操作，如“修改 A 并删除 B”） */
export function inferTypesFromText(text) {
  const s = String(text || "");
  const types = [];
  for (const hint of currentHints()) {
    if (hint.re.test(s)) types.push(hint.type);
  }
  return types.length ? [...new Set(types)] : ["any"];
}

/**
 * 从文本提取路径候选（批次 4 统一入口：pairActionScopes 与 inferPathPrefixesFromText 共用）。
 * 处理两类噪声：
 *  1. 前缀冗余：引号路径同时命中两分支 → 截断前缀（如 "d:/example"）被更长匹配覆盖 → 丢弃；
 *  2. 截断可疑：裸含空格路径（无引号）只能提取到空格前的半截（"D:\\workspace\docs\..." → "d:/workspace"）
 *     ——匹配后紧跟空白且后随 token 是路径字符开头且非盘符/引号 → 判定为截断 → 丢弃（fail-closed：
 *     宁缺授权，拦截后请用户给完整/引号路径，也不把半截前缀当成授权）。
 * @returns {Array<{index:number,path:string}>} 去噪后的候选（保留原文索引供就近配对）
 */
function extractPathCandidates(text) {
  const s = String(text || "");
  const all = [...s.matchAll(PATH_TOKEN_RE)]
    .map((m) => {
      const rawTok = m[0];
      const after = s.slice(m.index + rawTok.length);
      const afterChar = after.charAt(0);
      const afterWord = after.match(/^[ \t]+(\S+)/)?.[1] || "";
      const truncated = !/["']$/.test(rawTok) // 引号包裹完整路径不可能是截断
        && /\s/.test(afterChar)
        && afterWord.length > 0
        && !/^("|')?[A-Za-z]:[\\/]/i.test(afterWord) // 后随是新盘符路径 → 不是延续
        && /^[A-Za-z0-9_.[\]\\/-]/i.test(afterWord); // 后随是路径字符（非中文标点/动词）
      return { index: m.index, path: normalizePath(rawTok.replace(/^["']|["']$/g, "")), truncated };
    })
    .filter((p) => p.path && !p.truncated);
  // 前缀冗余：完整匹配覆盖截断前缀（后一字符为空白/结束符）
  return all.filter(
    (p) => !all.some((q) => q !== p && q.path.startsWith(p.path) && /[\s"'`，。；：！？（）【】《》、]/.test(q.path.slice(p.path.length, p.path.length + 1) || ""))
  );
}

/** 从文本提取全部绝对路径（用于一条子句含多个路径） */
export function inferPathPrefixesFromText(text) {
  const unique = [...new Set(extractPathCandidates(text).map((p) => p.path))];
  return unique;
}

/**
 * 委托任务书检测（批次 3，2026-08-24；R2④ 实测驱动）。
 * 特征：≥2 步骤枚举 + 显式绝对路径 + 文本较长 + 委托框架词（任务/步骤/目录下/只允许…）。
 * 命中 → strict 模式：无路径绑定的动作子句不产生全局 scope（委托最小 scope 收紧）。
 * 普通用户消息（短/无步骤枚举/无框架词）不命中 → 保持现状（规则 22⑤ 宽泛指令语义）。
 */
const DELEGATION_MARKER_RE = /(?:任务|只允许|仅限|受限于|范围内|目录下|依次执行|执行以下|步骤)/;
export function isDelegationText(text) {
  const s = String(text || "");
  const stepCount = (s.match(/(?:^|\n)\s*\d+[.、)．]\s*/g) || []).length;
  if (stepCount < 2) return false;
  if (s.length < 120) return false;
  if (!/(["'][A-Za-z]:[\\/]|[A-Za-z]:[\\/](?!\/))/.test(s)) return false;
  return DELEGATION_MARKER_RE.test(s);
}

/**
 * 从本回合执行子句推导授权范围（规则 22 粒度升级，2026-08-24）。
 * R6④ 分点级精确配对（2026-08-24）：每个 execute 子句按「动作词 → 就近路径」精确配对，
 * 不再对 type×path 做笛卡尔积——"修改 A 并删除 B"只产生 {write,A} 与 {delete,B}，
 * 绝不产生 {write,B}/{delete,A} 等用户没说的组合。
 * 批次 3（2026-08-24）：委托任务书（isDelegationText）→ strict 模式，无路径子句跳过（最小 scope）。
 * @param {object} intents parseUserIntents 返回值
 * @returns {Array<{type:string,pathPrefix:string,source:string,clauseId?:string}>}
 */
export function scopesFromIntents(intents) {
  if (!intents || !Array.isArray(intents.clauses)) return [];
  const strict = isDelegationText(intents.raw || "");
  const scopes = [];
  for (const c of intents.clauses) {
    if (c.type !== "execute") continue;
    scopes.push(...pairActionScopes(c.raw || "", c.id, strict));
  }
  return scopes;
}

// 动作词 → 操作类型（精确配对用；"执行/运行"保持 any，避免把宽泛指令误限为 command）
const VERB_TYPE_RE = [
  [/删除|移除|清理|清空|丢弃/i, "delete"],
  [/备份/i, "backup"],
  [/提交|推送/i, "git"],
  [/下载/i, "network"],
  [/执行|运行/i, "any"],
  [/写|保存|另存为|创建|复制|移动|修改|编辑|替换|改|补|修|做|安装|卸载|修复|重建|启动|停止|调整|改进|优化|升级|迁移|整理|添加|增加/i, "write"]
];
const VERB_RE =
  /删除|移除|修改|编辑|替换|写入|写|保存|另存为|创建|复制|移动|备份|提交|推送|下载|执行|运行|安装|卸载|清理|修复|重建|启动|停止|调整|改进|优化|升级|迁移|整理|添加|增加|改|补|修|做|实施|推进|继续|处理|解决|转化|转换|读取|读(?:完|出|一下|一遍|出来)?|展示|打开|提取|还原|导入|导出|落盘|落地/g;

function verbType(word, fullText) {
  for (const [re, type] of VERB_TYPE_RE) {
    if (re.test(word)) {
      // 宽泛"执行/运行"在出现具体命令上下文时仍收窄为 command
      if (type === "any" && /node\s+[\w./\\-]+\.(?:m?js|cjs)|npm\s+(?:run|exec|install)|run\s+|execute/i.test(fullText)) return "command";
      return type;
    }
  }
  return inferTypeFromText(fullText);
}

/** R6④：子句内动作-路径就近配对（纯函数）。strict（委托任务书）下无路径子句跳过，不产生全局。 */
export function pairActionScopes(raw, clauseId, strict = false) {
  const text = String(raw || "");
  const verbs = [...text.matchAll(VERB_RE)].map((m) => ({ index: m.index, word: m[0] }));
  // 批次 4：统一路径提取（去前缀冗余 + 截断可疑）——仅保留可靠 token 供就近配对
  const paths = extractPathCandidates(text);
  if (verbs.length === 0) {
    // 无动词的 execute 子句（如【执行】标签正文无动作词）→ 回退整句推断（保持旧语义）
    const types = inferTypesFromText(text);
    const pathList = inferPathPrefixesFromText(text);
    // 批次 3：strict（委托任务书）且无路径 → 跳过该子句（最小 scope：无明确路径不授权）
    if (strict && pathList.length === 0) return out;
    const list = pathList.length > 0 ? pathList : [""];
    const out = [];
    for (const type of types) {
      for (const pathPrefix of list) {
        if (!out.some((s) => s.type === type && s.pathPrefix === pathPrefix)) out.push({ type, pathPrefix, source: "clause", clauseId });
      }
    }
    return out;
  }
  const scopes = [];
  for (const v of verbs) {
    // 绑定规则：该动词之后、中间无其他动词间隔的全部路径（"修改 A 和 B" → A、B 都绑）；
    // 无后续路径时取动词之前同条件的全部路径（"把 X 和 Y 修改"）；再否则全局。
    const between = (p) => verbs.some((v2) => v2.index !== v.index && v2.index > Math.min(p.index, v.index) && v2.index < Math.max(p.index, v.index));
    const after = paths.filter((p) => p.index > v.index && !between(p));
    let boundPaths = after.map((p) => p.path);
    if (boundPaths.length === 0) {
      const before = paths.filter((p) => p.index < v.index && !between(p));
      boundPaths = before.map((p) => p.path);
    }
    if (boundPaths.length === 0) {
      // 批次 3：strict（委托任务书）且无路径 → 跳过（最小 scope）；普通消息 → 全局兜底（规则 22⑤）
      if (strict) continue;
      boundPaths = [""];
    }
    const type = verbType(v.word, text);
    for (const pathPrefix of boundPaths) {
      if (!scopes.some((s) => s.type === type && s.pathPrefix === pathPrefix)) {
        scopes.push({ type, pathPrefix, source: "clause", clauseId, object: extractActionObjects(text) });
      }
    }
  }
  return scopes;
}

/** 格式化授权范围（用于规则 22 拒绝原因） */
export function describeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return "无";
  return scopes
    .map((s) => `${s.type || "any"}｜路径 ${s.pathPrefix || "全局"}${Array.isArray(s.object) && s.object.length ? `｜对象 ${s.object.join(",")}` : ""}`)
    .join("；");
}

/** 从文本提取路径前缀（取最长的路径 token；支持引号包裹的含空格路径） */
export function inferPathPrefixFromText(text) {
  const s = String(text || "");
  const matches = s.match(PATH_TOKEN_RE) || [];
  if (matches.length === 0) return "";
  const normalized = matches
    .map((m) => normalizePath(m.replace(/^["']|["']$/g, "")))
    .filter(Boolean);
  if (normalized.length === 0) return "";
  return normalized.sort((a, b) => b.length - a.length)[0];
}

/** 从一次工具调用推导操作范围 */
export function operationOf(toolName, args) {
  const name = String(toolName || "");
  const p = pathTarget(args);
  const cmd = commandText(args);
  let type = "any";
  let pathPrefix = "";
  let pathPrefixes = [];

  if (name === "edit" || name === "write" || (name === "str_replace_editor" && args?.command !== "view")) {
    type = "write";
    pathPrefix = normalizePath(p || "");
    if (pathPrefix) pathPrefixes = [pathPrefix];
  } else if (name === "pwsh" || name === "bash") {
    const text = cmd || "";
    type = inferTypeFromText(text);
    if (/git\s+(push|commit)/i.test(text)) type = "git";
    else if (/remove-item|rm\s+-r|rmdir|del\s+/i.test(text)) type = "delete";
    else if (/backup|(?:copy-item|move-item|rename-item)[^\n]*(?:\.bak|\.backups|trash-)/i.test(text)) type = "backup";
    else if (/set-content|add-content|out-file|writealltext|copy-item|move-item|rename-item/i.test(text)) type = "write";
    const writeTargets = writeTargetPathsFromCommand(text).map(normalizePath).filter(Boolean);
    pathPrefixes = [...writeTargets];
    const cp = extractCopyPaths(text);
    if (cp && cp.source) pathPrefixes.push(normalizePath(cp.source));
    pathPrefixes = [...new Set(pathPrefixes.filter(Boolean))];
    // P0-1d：主写目标优先取真实写参数（Copy-Item 的 Destination 等），
    // 避免"源路径比目标长"时最长路径误选源（13A 误拦）；授权匹配仍走多候选 pathPrefixes
    pathPrefix = writeTargets[0] || pathPrefixes.sort((a, b) => b.length - a.length)[0] || inferPathPrefixFromText(text);
  } else if (name === "skill") {
    type = "skill";
    pathPrefix = "";
  } else if (GENERIC_EXEC_TOOLS.has(name)) {
    type = "command";
    pathPrefix = "";
  } else if (name === "ask_user_question") {
    type = "ask";
    pathPrefix = "";
  }

  return { type, pathPrefix, pathPrefixes, commandText: cmd || "" };
}

/**
 * 柱子 B（2026-08-31）：显式命名对象锚定——分点文本中"X 仓库/repo/目录/项目/包/文件"的
 * **实体名 token**（含连字符/点/下划线/数字的命名形态；"skill 仓库"这类类别概念词不锚定——
 * 防过度误拦）。锚定后授权仅覆盖该对象；未锚定（空）→ 不收紧（维持既有语义）。
 */
const NAMED_OBJECT_RE = /([A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)+|[\u4e00-\u9fff]{2,12}[A-Za-z0-9]*)(?:\s*)(?:远程|远端)?(?:仓库|repo(?:sitory)?|目录|项目|包|package|文件)/gi;
export function extractActionObjects(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(NAMED_OBJECT_RE)) {
    const token = m[1].trim();
    if (token.length >= 3) out.add(token.toLowerCase());
  }
  return [...out];
}

/** 路径是否在授权边界内：相等，或为授权路径的子路径（子路径以 / 为边界，防止文件前缀误伤） */
function pathUnderAuth(p, authPath) {
  if (p === authPath) return true;
  return p.startsWith(authPath.endsWith("/") ? authPath : authPath + "/");
}

/** 判断授权记录是否匹配本次操作（支持源/目标多路径任一匹配）。
 *  2026-08-24（R6.3）：纯 startsWith 改为边界匹配——授权 "d:/a.txt" 不再放行 "d:/a.txt.bak"（同前缀文件误伤），
 *  目录前缀（含无尾斜杠的目录名）仍正确匹配子路径。 */
export function authMatches(auth, op) {
  if (!auth || !op) return false;
  if (auth.type !== "any" && op.type !== "any" && auth.type !== op.type) return false;
  if (auth.pathPrefix) {
    const candidates = Array.isArray(op.pathPrefixes) && op.pathPrefixes.length > 0
      ? op.pathPrefixes
      : (op.pathPrefix ? [op.pathPrefix] : []);
    if (candidates.length === 0) return false;
    const authPath = normalizePath(auth.pathPrefix);
    if (!candidates.some((p) => pathUnderAuth(normalizePath(p), authPath))) return false;
  }
  // 柱子 B（2026-08-31）：对象锚定——授权声明了显式命名对象 → 操作命令文本必须命中该对象
  //（"推送 X 仓库"不覆盖"推送 Y 仓库"；未锚定对象=不收紧）
  if (Array.isArray(auth.object) && auth.object.length > 0) {
    const opText = String(op.commandText || "").toLowerCase();
    if (!opText || !auth.object.some((o) => opText.includes(String(o).toLowerCase()))) return false;
  }
  return true;
}

/** 在授权列表中查找匹配项，返回最近一条（过期记录忽略） */
export function findMatchingAuth(auths, op, now = Date.now()) {
  if (!Array.isArray(auths)) return null;
  const matches = auths.filter((a) => authMatches(a, op) && (!a.expiresAt || a.expiresAt > now));
  if (matches.length === 0) return null;
  return matches.sort((a, b) => (b.at || 0) - (a.at || 0))[0];
}

export function describeAuth(auth) {
  if (!auth) return "无";
  const type = auth.type || "any";
  const path = auth.pathPrefix ? `路径 ${auth.pathPrefix}` : "全局";
  const expires = auth.expiresAt ? `｜到期 ${new Date(auth.expiresAt).toISOString()}` : "";
  return `${type}｜${path}｜${new Date(auth.at || 0).toISOString()}${expires}｜仅本次运行有效`;
}

export function describeOp(op) {
  if (!op) return "未知";
  return `${op.type || "any"}｜路径 ${op.pathPrefix || "未指定"}`;
}

/** 用户消息是否为“询问影响”而非授权（词表与 intent.js 统一，2026-08-24） */
export function isQuestionMessage(text) {
  return questionWordsRe().test(String(text || ""));
}

/** 用户消息是否包含明确执行许可（确认/同意/授权 + 执行语；且不是询问句） */
export function isAuthMessage(text) {
  const s = String(text || "");
  return approvalExecRe().test(s) && !isQuestionMessage(s);
}

/** 用户消息是否为直接命令式指令（非询问，视为授权执行） */
export function isDirectiveMessage(text) {
  const s = String(text || "");
  return directiveWordsRe().test(s) && !isQuestionMessage(s);
}

/** 选项/自由文本是否表示批准（纯"确认方案/理解/方向"不算批准） */
export function isApprovalText(text) {
  const s = String(text || "");
  if (planOnlyRe().test(s) && !actionWordsRe().test(s) && !approvalExecRe().test(s)) return false;
  return APPROVAL_RE.test(s) || actionWordsRe().test(s);
}

/** 选项/自由文本是否表示拒绝 */
export function isRejectionText(text) {
  return rejectionWordsRe().test(String(text || ""));
}

/** 从 ask_user_question 的 arguments 中提取问题文本（用于推断授权范围） */
export function askQuestionText(questions) {
  if (!Array.isArray(questions)) return "";
  const parts = [];
  for (const q of questions) {
    if (q && typeof q === "object") {
      if (q.question) parts.push(q.question);
      if (q.header) parts.push(q.header);
      if (q.detail) parts.push(q.detail);
      if (Array.isArray(q.options)) {
        for (const o of q.options) {
          if (o && typeof o === "object") {
            if (o.label) parts.push(o.label);
            if (o.description) parts.push(o.description);
          } else if (typeof o === "string") {
            parts.push(o);
          }
        }
      }
    } else if (typeof q === "string") {
      parts.push(q);
    }
  }
  return parts.join(" ");
}

/**
 * 仅取 ask 的问题/标题/说明，不含选项文本。
 * 2026-08-24 修复：选项描述里的“仅会话内说明/不跨会话保留”等字样不得影响授权范围判定。
 */
export function askQuestionCoreText(questions) {
  if (!Array.isArray(questions)) return "";
  const parts = [];
  for (const q of questions) {
    if (q && typeof q === "object") {
      if (q.question) parts.push(q.question);
      if (q.header) parts.push(q.header);
      if (q.detail) parts.push(q.detail);
    } else if (typeof q === "string") {
      parts.push(q);
    }
  }
  return parts.join(" ");
}

/** 提取 ask 结果中用户实际选择的文本（selected 标签 + 自定义输入），用于授权范围判定 */
export function askResultSelectedText(result) {
  const answers = extractAnswers(result);
  if (!answers || answers.length === 0) return "";
  const parts = [];
  for (const item of answers) {
    const texts = [...(item.selected || []), item.custom || ""].filter(Boolean);
    for (const t of texts) parts.push(t);
  }
  return parts.join(" ");
}

/**
 * 判定 ask 授权是否应为“会话级/全局长时”授权。
 * 只匹配明确的范围词，不再匹配裸“会话内”（避免“仅会话内说明”把一次小授权放大成 12h 全局）。
 */
const SESSION_WIDE_RE = /(?:全部|本会话|本次会话|整个会话|当前会话|会话内所有|会话内全部|所有后续|剩余所有|所有操作|整个profile|整个工作区|全部推进项|全部操作)/i;
export function isSessionWideAskText(text) {
  return SESSION_WIDE_RE.test(String(text || ""));
}

/** 从 ask_user_question 的结果中提取是否批准 */
export function askResultApproved(result) {
  const answers = extractAnswers(result);
  if (!answers || answers.length === 0) return false;
  let approved = false;
  let rejected = false;
  for (const item of answers) {
    const texts = [...(item.selected || []), item.custom || ""].filter(Boolean);
    for (const t of texts) {
      if (isRejectionText(t)) rejected = true;
      else if (isApprovalText(t)) approved = true;
    }
  }
  return approved && !rejected;
}

/**
 * C3（2026-08-28 阶段二）：ask 结果是否为【明确拒绝】——区别于"未响应/超时/无选择"。
 * 用户说"你也没给我时间回复啊"：engine 旧逻辑把「任何未批准」一律记为拒绝（auth-reject +
 * askRejections 池）→ 5 分钟内再有 ask 被 __ask-throttle 拦 —— 用户没回 ≠ 用户拒绝，
 * 节流烧掉的是"用户可能还没来得及看"。仅当结果文本含明确拒绝词才记拒绝。
 */
export function askResultRejected(result) {
  const answers = extractAnswers(result);
  if (!answers || answers.length === 0) return false;
  for (const item of answers) {
    const texts = [...(item.selected || []), item.custom || ""].filter(Boolean);
    for (const t of texts) {
      if (isRejectionText(t)) return true;
    }
  }
  return false;
}

function extractToolResultText(result) {
  const msg = result?.message ?? result;
  const content = Array.isArray(msg?.content)
    ? msg.content
    : Array.isArray(result?.content)
      ? result.content
      : null;
  if (!content) return null;
  const block = content.find((b) => b && b.type === "tool-result");
  if (!block) return null;
  const inner = Array.isArray(block.content) ? block.content : [];
  const text = inner
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
  return text || null;
}

function extractAnswers(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (typeof result === "string") {
    try {
      return extractAnswers(JSON.parse(result));
    } catch {
      return [];
    }
  }
  // tool/result 事件实际形状：message.content[0] = { type:'tool-result', content:[{type:'text', text:'{...}'}] }
  const toolText = extractToolResultText(result);
  if (toolText) {
    try {
      return extractAnswers(JSON.parse(toolText));
    } catch {
      return [];
    }
  }
  if (Array.isArray(result.answers)) return result.answers;
  if (Array.isArray(result.value?.answers)) return result.value.answers;
  if (Array.isArray(result.result?.answers)) return result.result.answers;
  return [];
}
