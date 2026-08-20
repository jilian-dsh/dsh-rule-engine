// overengineering.js - 反过度工程模式库（SHIT）
// 参考 lennney/stop-that-shit：Scope / Hash / Intent / Task thrashing。
// 纯函数，可独立测试。
import { commandText, isReadOnlyTool, pathTarget } from "./patterns.js";
import { normalizePath } from "./authorization.js";

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
  const text = JSON.stringify(args || {});
  return HASH_RE.test(text);
}

/** 是否命中“添加依赖”类动作 */
export function detectDependencyIntent(toolName, args) {
  const name = String(toolName || "");
  const cmd = commandText(args) || "";
  if (name === "pwsh" || name === "bash") return DEPENDENCY_RE.test(cmd);
  const text = JSON.stringify(args || {});
  return DEPENDENCY_RE.test(text);
}

/** 粗分类一次工具调用的可变更性 */
export function classifyAction(toolName, args) {
  const name = String(toolName || "");
  const p = pathTarget(args);
  const cmd = commandText(args);
  let mutability = "unknown";
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
  if (/(?:顺手|顺便|额外|多加|防止以后|以防万一|先加上|先建个)/.test(s) && /(?:重构|依赖|抽象|兼容|迁移|flag|校验|哈希|hash|全量测试|保险)/i.test(s)) {
    hits.push("检测到可能的过度工程表述：请用 Stop Ladder 四问自证（是否被要求/是否必要/可达证据/省略是否会失败）");
  }
  if (/(?:再检查一遍|再跑一次测试|再审计一次|重新验证一遍)/.test(s) && !/(?:新证据|发现|失败|报错|修改后|变更后)/.test(s)) {
    hits.push("检测到可能的重复打转：请确认是否有新证据，避免 Task thrashing");
  }
  return hits;
}
