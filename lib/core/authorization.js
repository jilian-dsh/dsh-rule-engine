// authorization.js - 授权证据结构化匹配（P0：授权关联具体操作，区分询问与授权）
// 纯函数，可独立测试。
import { GENERIC_EXEC_TOOLS, pathTarget, commandText, writeTargetPathsFromCommand, extractCopyPaths } from "./patterns.js";

export const AUTH_TTL_MS = 10 * 60 * 1000;

const AUTH_WORDS_RE = /(?:可以|同意|授权|去做|开始|执行吧|批准|允许|确认|好的|行|去吧|ok|yes)/i;
const QUESTION_WORDS_RE = /(?:影响吗|可以吗|要不要|是否|能不能|行不行|需不需要|吗\s*$|？|\?)/i;
const DIRECTIVE_RE = /(?:请\s*)?(?:删除|移除|修改|编辑|替换|写入|创建|复制|移动|执行|运行|下载|提交|推送|备份|安装|卸载|清理|启动|停止|重建|修复|保存)/i;
const APPROVAL_RE = /(?:允许|同意|可以|是|好|确认|授权|执行|批准|去吧|开始|ok|yes)/i;
const REJECTION_RE = /(?:不允许|拒绝|不要|否|取消|不同意|no|No)/i;

const TYPE_HINTS = [
  { re: /删除|移除|remove|delete/i, type: "delete" },
  { re: /修改|编辑|替换|写入|写文件|edit|write|replace/i, type: "write" },
  { re: /备份|backup/i, type: "backup" },
  { re: /git\s+(push|commit)|提交|推送/i, type: "git" },
  { re: /执行|命令|运行|run|execute|pwsh|bash/i, type: "command" },
  { re: /技能|skill/i, type: "skill" },
  { re: /下载|网络|curl|fetch/i, type: "network" }
];

const PATH_TOKEN_RE = /["'][A-Za-z]:[\\/](?!\/)[^"']+["']|[A-Za-z]:[\\/](?!\/)[^\s'"`，。；：！？（）【】《》、]+|(?:^|[\s"'`])\/(?:[^\s"'`，。；：！？（）【】《》、]+)/g;

export function normalizePath(p) {
  if (typeof p !== "string") return "";
  return p.replace(/\\/g, "/").toLowerCase();
}

/** 从文本推断操作类型 */
export function inferTypeFromText(text) {
  const s = String(text || "");
  for (const hint of TYPE_HINTS) {
    if (hint.re.test(s)) return hint.type;
  }
  return "any";
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
    pathPrefix = pathPrefixes.sort((a, b) => b.length - a.length)[0] || inferPathPrefixFromText(text);
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

  return { type, pathPrefix, pathPrefixes };
}

/** 判断授权记录是否匹配本次操作（支持源/目标多路径任一匹配） */
export function authMatches(auth, op) {
  if (!auth || !op) return false;
  if (auth.type !== "any" && op.type !== "any" && auth.type !== op.type) return false;
  if (auth.pathPrefix) {
    const candidates = Array.isArray(op.pathPrefixes) && op.pathPrefixes.length > 0
      ? op.pathPrefixes
      : (op.pathPrefix ? [op.pathPrefix] : []);
    if (candidates.length === 0) return false;
    const authPath = normalizePath(auth.pathPrefix);
    if (!candidates.some((p) => normalizePath(p).startsWith(authPath))) return false;
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

/** 用户消息是否为“询问影响”而非授权 */
export function isQuestionMessage(text) {
  return QUESTION_WORDS_RE.test(String(text || ""));
}

/** 用户消息是否包含明确授权词（且不是询问句） */
export function isAuthMessage(text) {
  const s = String(text || "");
  return AUTH_WORDS_RE.test(s) && !isQuestionMessage(s);
}

/** 用户消息是否为直接命令式指令（非询问，视为授权执行） */
export function isDirectiveMessage(text) {
  const s = String(text || "");
  return DIRECTIVE_RE.test(s) && !isQuestionMessage(s);
}

/** 选项/自由文本是否表示批准 */
export function isApprovalText(text) {
  return APPROVAL_RE.test(String(text || ""));
}

/** 选项/自由文本是否表示拒绝 */
export function isRejectionText(text) {
  return REJECTION_RE.test(String(text || ""));
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
