// overengineering.js - 反过度工程模式库（SHIT）
// 参考 lennney/stop-that-shit：Scope / Hash / Intent / Task thrashing。
// 纯函数，可独立测试。
import { commandText, isReadOnlyTool, patMap, onPatternsReset, pathTarget } from "./patterns.js";
import { normalizePath } from "./authorization.js";
import { toolClass } from "./tool-catalog.js";

// ── overeng_checks 取词（第三批，2026-09-21）──
// 四条判定词迁 patterns.overeng_checks；flags 口径留代码（extra_tech 用 "i"，其余为空）。
// 缓存不被模块级锁死：onPatternsReset 在 setPatterns／resetPatterns 生效后清空本缓存。
const OVERENG_CHECK_FLAGS = { extra_tech: "i" };
let overengReCache = new Map();
function overengRe(key) {
  if (overengReCache.has(key)) return overengReCache.get(key);
  const src = patMap("overeng_checks")[key];
  let re = null;
  if (typeof src === "string" && src.length > 0) {
    try {
      re = new RegExp(src, OVERENG_CHECK_FLAGS[key] || "");
    } catch {
      re = null;
    }
  }
  overengReCache.set(key, re);
  return re;
}
onPatternsReset(() => overengReCache.clear());

const HASH_RE =
  /\b(?:get-filehash|sha256sum|sha1sum|md5sum|openssl\s+dgst|certutil\s+-hashfile|checksum)\b/i;

const DEPENDENCY_RE =
  /\b(?:npm|pnpm|yarn|bun|pip|pip3|poetry|go\s+get|gem\s+install|apt-get\s+install|brew\s+install|winget\s+install)\b[\s\S]{0,120}?\b(?:install|add|update|upgrade|i\b)\b/i;

const READ_WORDS_RE =
  /\b(?:get-content|get-childitem|get-item|get-command|get-date|select-string|findstr|cat|type|dir|ls|grep|more|netstat|where|test-path|read)\b/i;

/** 是否命中“无消费者哈希/校验和”类动作 */
export function detectHashIntent(toolName, args) {
  const name = String(toolName || "");
  const cmd = commandText(args) || "";
  if (name === "pwsh" || name === "bash") return HASH_RE.test(cmd);
  // 批次 4：只对命令类字段判定——写入类工具内容含命令字样 ≠ 相关操作（参数全文匹配导致 hash=deny 误拦一切含字样的写入）
  const cmdish = ["script", "query", "sql", "code"].map((k) => (typeof args?.[k] === "string" ? args[k] : "")).join("\n");
  return HASH_RE.test(cmdish);
}

/** 是否命中“添加依赖”类动作 */
export function detectDependencyIntent(toolName, args) {
  const name = String(toolName || "");
  const cmd = commandText(args) || "";
  if (name === "pwsh" || name === "bash") return DEPENDENCY_RE.test(cmd);
  // 批次 4：只对命令类字段判定（同上：写入内容含依赖安装字样 ≠ 添加依赖动作）
  const cmdish = ["script", "query", "sql", "code"].map((k) => (typeof args?.[k] === "string" ? args[k] : "")).join("\n");
  return DEPENDENCY_RE.test(cmdish);
}

/** 粗分类一次工具调用的可变更性 */
export function classifyAction(toolName, args) {
  const name = String(toolName || "");
  const p = pathTarget(args);
  const cmd = commandText(args);
  let mutability = "unknown";
  // 件 A（2026-09-22）：先消费工具分类表（toolClass）的 analysis——与 isReadOnlyTool 各自独立成 if，
  // 不并进 pwsh／bash 分支（那两件仍按下方分支保持 unknown，除非 isReadOnlyTool 放行）。
  if (toolClass(name, args) === "analysis") {
    mutability = "read";
  }
  if (isReadOnlyTool(name, args)) {
    mutability = "read";
  } else if (name === "edit" || name === "write" || (name === "str_replace_editor" && args?.command !== "view")) {
    mutability = "write";
  } else if (name === "pwsh" || name === "bash") {
    // 无法证明只读的一律视为 unknown（armed 下会按 MUTABILITY_UNPROVEN 处理）
    mutability = "unknown";
  } else if (name === "subagent" || name === "tool-subagent" || name === "tool-subagent-fork" || name === "workflow") {
    mutability = "delegate";
  }
  const affectedPaths = p ? [normalizePath(p)] : [];
  const delegationCount = name === "workflow" ? 0 : 1;
  const unboundedDelegation = name === "workflow";
  return {
    mutability,
    hashIntent: detectHashIntent(name, args),
    dependencyIntent: detectDependencyIntent(name, args),
    affectedPaths,
    delegationCount,
    unboundedDelegation
  };
}

/** 记录一次工具动作（用于 Task thrashing 检测） */
export function recordAction(session, toolName, args) {
  if (!session || !Array.isArray(session.recentActions)) session.recentActions = [];
  const key = `${toolName}:${commandText(args) || JSON.stringify(args || {})}`;
  session.recentActions.push({ key, at: Date.now() });
  if (session.recentActions.length > 20) session.recentActions = session.recentActions.slice(-20);
  return session.recentActions;
}

/**
 * 判断是否为重复任务打转（同一工具+同一命令在短时间内出现 ≥3 次）。
 * 返回 true 时建议注入提醒/升级拦截。
 */
export function isRepeatedTaskAction(session, toolName, args, windowMs = 10 * 60 * 1000) {
  if (!session || !Array.isArray(session.recentActions)) return false;
  const key = `${toolName}:${commandText(args) || JSON.stringify(args || {})}`;
  const now = Date.now();
  const count = session.recentActions.filter((a) => a.key === key && now - a.at <= windowMs).length;
  return count >= 3;
}

/** 输出文本中的越界/过度工程表述检测（B/D 级提示用） */
export function detectOverengineeringText(text) {
  const s = String(text || "");
  const hits = [];
  // 第三批（2026-09-21）：四条判定词经 patterns.overeng_checks 取（patMap；带缓存，onPatternsReset 生效时清空）；
  // AND／NOT 组合逻辑仍在本函数内（配置只给词，不给逻辑）。命中后的提示字符串不变。
  if (overengRe("extra_act")?.test(s) && overengRe("extra_tech")?.test(s)) {
    hits.push("检测到可能的过度工程表述：请用 Stop Ladder 四问自证（是否被要求/是否必要/可达证据/省略是否会失败）");
  }
  if (overengRe("recheck")?.test(s) && !overengRe("recheck_except")?.test(s)) {
    hits.push("检测到可能的重复打转：请确认是否有新证据，避免 Task thrashing");
  }
  return hits;
}
