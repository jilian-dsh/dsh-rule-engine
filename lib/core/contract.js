// contract.js - 任务契约（Task Contract）
// 参考 lennney/stop-that-shit 的 review/answer/change/monitor/watch 模式与预算机制。
// 纯函数，可独立测试；不依赖 Cordis。
import { normalizePath } from "./authorization.js";

export const MODES = new Set(["review", "answer", "change", "monitor", "watch", "off"]);
export const LEVELS = new Set(["watch", "guard", "lock", "off"]);
export const HASH_POLICIES = new Set(["deny", "ask", "allow"]);
export const SCOPE_POLICIES = new Set(["deny", "ask", "allow"]);

export function defaultContract() {
  return {
    mode: "unconfirmed",
    level: "watch",
    agentBudget: 0,
    agentsUsed: 0,
    hashPolicy: "deny",
    allowedPaths: null,
    dependencyPolicy: "ask",
    source: "default"
  };
}

/** 从 /guard mode 指令解析契约模式；无法解析返回 null */
export function parseModeCommand(text) {
  const m = /^mode\s+([a-z]+)(?:\s+(watch|guard|lock|off))?$/i.exec(String(text || "").trim());
  if (!m) return null;
  const mode = m[1].toLowerCase();
  if (!MODES.has(mode)) return null;
  let level = m[2]?.toLowerCase() || null;
  if (mode === "watch" || mode === "off") level = level || mode;
  else if (!level) level = "guard";
  if (!LEVELS.has(level)) return null;
  return { mode, level };
}

/** 从 /guard budget 指令解析预算；无法解析返回 null */
export function parseBudgetCommand(text) {
  const s = String(text || "").trim();
  if (!/^budget\b/i.test(s)) return null;
  const tokens = s.replace(/^budget\b/i, "").split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const out = {};
  let changed = false;
  for (const token of tokens) {
    const agents = /^agents=(\d+)$/i.exec(token);
    if (agents) {
      out.agentBudget = Math.min(Number(agents[1]), 8);
      changed = true;
      continue;
    }
    const files = /^files=(.+)$/i.exec(token);
    if (files) {
      out.allowedPaths = files[1].split("|").map((v) => normalizePath(v)).filter(Boolean);
      changed = true;
      continue;
    }
    const hash = /^hash=(deny|ask|allow)$/i.exec(token);
    if (hash && HASH_POLICIES.has(hash[1].toLowerCase())) {
      out.hashPolicy = hash[1].toLowerCase();
      changed = true;
      continue;
    }
    const deps = /^deps=(deny|ask|allow)$/i.exec(token);
    if (deps && SCOPE_POLICIES.has(deps[1].toLowerCase())) {
      out.dependencyPolicy = deps[1].toLowerCase();
      changed = true;
      continue;
    }
  }
  return changed ? out : null;
}

/** 从用户自然语言推断任务模式；低置信返回 null */
export function naturalMode(text, previous = defaultContract()) {
  const s = String(text || "").trim();
  if (/^(?:stop|stop now|停止|停下来)[.!。！\s]*$/i.test(s)) {
    return { mode: "answer", source: "explicit-stop" };
  }
  if (/\breview only\b|\b(?:do not|don't) (?:edit|change|fix) (?:anything|the (?:repo|repository|files?|code))\b|只审查|只看不改|不要修改(?:任何|代码|文件)/i.test(s)) {
    return { mode: "review", source: "natural-explicit" };
  }
  if (/\banswer only\b|只回答/i.test(s)) {
    return { mode: "answer", source: "natural-explicit" };
  }
  if (/\bmonitor only\b|只监控|只观察/i.test(s)) {
    return { mode: "monitor", source: "natural-explicit" };
  }
  const wasNonMutating = ["answer", "review", "monitor"].includes(previous.mode);
  const explicitChange = /^(?:please\s+)?(?:fix|implement|change|apply|patch)\b|^(?:请)?(?:修复|修改|实现|应用补丁)|^把.+(?:修复|修改|改掉)/i.test(s);
  if (wasNonMutating && explicitChange) {
    return { mode: "change", source: "natural-explicit" };
  }
  return null;
}

/** 应用一次契约变更（指令/自然语言），返回新契约与是否变化 */
export function applyContract(previous, patch) {
  const next = { ...defaultContract(), ...(previous || {}) };
  if (!patch) return { contract: next, changed: false };
  let changed = false;
  if (patch.mode && patch.mode !== next.mode) {
    next.mode = patch.mode;
    next.agentsUsed = 0;
    changed = true;
  }
  if (patch.level && patch.level !== next.level) {
    next.level = patch.level;
    changed = true;
  }
  if (Number.isInteger(patch.agentBudget) && patch.agentBudget !== next.agentBudget) {
    next.agentBudget = patch.agentBudget;
    next.agentsUsed = 0;
    changed = true;
  }
  if (patch.hashPolicy && patch.hashPolicy !== next.hashPolicy) {
    next.hashPolicy = patch.hashPolicy;
    changed = true;
  }
  if (Array.isArray(patch.allowedPaths)) {
    next.allowedPaths = patch.allowedPaths;
    changed = true;
  }
  if (patch.dependencyPolicy && patch.dependencyPolicy !== next.dependencyPolicy) {
    next.dependencyPolicy = patch.dependencyPolicy;
    changed = true;
  }
  if (patch.source) next.source = patch.source;
  if (patch.mode && !patch.level && next.level === "watch") {
    next.level = "guard";
    changed = true;
  }
  if (next.mode === "unconfirmed" && next.level !== "off") {
    next.level = "watch";
  }
  return { contract: next, changed };
}

/** 全局是否启用任务契约 */
export function taskContractActive(config) {
  return Boolean(config?.taskContractEnabled);
}

/** 是否处于观察模式（全局 observe 或契约 watch） */
export function isObserving(contract, config) {
  if (!taskContractActive(config)) return false;
  if (config?.taskContractMode === "armed") {
    return contract?.level === "watch" || contract?.level === "off";
  }
  return true;
}

/** 是否处于 armed（全局 armed 且契约 guard/lock） */
export function isArmed(contract, config) {
  if (!taskContractActive(config)) return false;
  if (config?.taskContractMode !== "armed") return false;
  return contract?.level === "guard" || contract?.level === "lock";
}

/** 判断 action 是否在允许路径内 */
export function pathAllowed(path, allowedPaths) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) return true;
  if (!path) return false;
  const p = normalizePath(path);
  return allowedPaths.some((allowed) => {
    const a = normalizePath(allowed);
    if (a === "**") return true;
    if (a.endsWith("/**")) {
      const prefix = a.slice(0, -3);
      return p === prefix || p.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
    }
    return p === a;
  });
}

/**
 * 任务契约裁决（纯函数）。
 * 返回 { outcome: 'allow'|'deny'|'ask'|'report', family, reasonCode, reason, nextStep }
 */
export function decideContractAction({ contract, action, config = {} }) {
  const mode = contract?.mode || "unconfirmed";
  const level = contract?.level || "watch";
  if (mode === "unconfirmed" || level === "watch" || level === "off") {
    return { outcome: "allow", family: null, reasonCode: "CONTROL_INACTIVE", reason: "任务契约未武装，不拦截", nextStep: "" };
  }

  const nonMutatingMode = ["answer", "review", "monitor"].includes(mode);
  if (nonMutatingMode && action.mutability === "write") {
    return { outcome: "deny", family: "I", reasonCode: "MODE_FORBIDS_MUTATION", reason: `任务模式 ${mode} 不允许修改文件`, nextStep: "改用只读操作，或获得明确的 change 授权" };
  }
  if (nonMutatingMode && action.mutability === "unknown") {
    return { outcome: "deny", family: "I", reasonCode: "MUTABILITY_UNPROVEN", reason: `任务模式 ${mode} 下该操作无法证明只读`, nextStep: "改用明确只读命令，或获得 change 授权" };
  }

  if (action.hashIntent && contract.hashPolicy !== "allow") {
    if (contract.hashPolicy === "ask" && config.askEnabled) {
      return { outcome: "ask", family: "H", reasonCode: "HASH_NOT_AUTHORIZED", reason: "检测到哈希/校验和操作，当前 hash=ask", nextStep: "获得 hash=allow 或确认消费者" };
    }
    return { outcome: "deny", family: "H", reasonCode: "HASH_NOT_AUTHORIZED", reason: "检测到哈希/校验和操作，当前 hash=deny", nextStep: "使用 hash=allow 或说明消费者" };
  }

  if (Array.isArray(contract.allowedPaths) && contract.allowedPaths.length > 0 && action.mutability === "write") {
    const outside = (action.affectedPaths || []).filter((p) => !pathAllowed(p, contract.allowedPaths));
    if (action.affectedPaths?.length === 0) {
      return { outcome: "deny", family: "S", reasonCode: "WRITE_PATH_UNPROVEN", reason: "写操作无法证明在文件边界内", nextStep: "使用带明确路径的写工具，或扩大 files= 范围" };
    }
    if (outside.length) {
      return { outcome: "deny", family: "S", reasonCode: "PATH_OUTSIDE_CONTRACT", reason: `写路径超出文件边界：${outside.join(", ")}`, nextStep: "保持在 files= 范围内，或更新文件边界" };
    }
  }

  if (action.dependencyIntent && contract.dependencyPolicy !== "allow") {
    if (contract.dependencyPolicy === "ask" && config.askEnabled) {
      return { outcome: "ask", family: "S", reasonCode: "DEPENDENCY_NOT_AUTHORIZED", reason: "检测到添加依赖操作，当前 deps=ask", nextStep: "获得 deps=allow 或确认该依赖" };
    }
    return { outcome: "deny", family: "S", reasonCode: "DEPENDENCY_NOT_AUTHORIZED", reason: "检测到添加依赖操作，当前 deps=deny", nextStep: "使用 deps=allow 或说明必要性" };
  }

  if (action.mutability === "delegate" && action.unboundedDelegation) {
    return { outcome: "deny", family: "S", reasonCode: "UNBOUNDED_DELEGATION", reason: "该委托可能无界启动子代理，无法满足 agents=N", nextStep: "使用显式子代理调用，或关闭任务契约" };
  }

  const delegationCount = action.mutability === "delegate" ? (Number.isInteger(action.delegationCount) ? action.delegationCount : 1) : 0;
  if (action.mutability === "delegate" && (contract.agentsUsed + delegationCount > contract.agentBudget)) {
    return { outcome: "deny", family: "S", reasonCode: "AGENT_BUDGET_EXHAUSTED", reason: `子代理预算不足：已用 ${contract.agentsUsed}/${contract.agentBudget}，本次需要 ${delegationCount}`, nextStep: "继续本地完成，或获得 agents=N 授权" };
  }

  return { outcome: "allow", family: null, reasonCode: "WITHIN_CONTRACT", reason: "动作在任务契约内", nextStep: "" };
}

export function contractSummary(contract) {
  const c = contract || defaultContract();
  return `mode=${c.mode}; agents=${c.agentsUsed}/${c.agentBudget}; hash=${c.hashPolicy || "deny"}; deps=${c.dependencyPolicy || "ask"}; files=${Array.isArray(c.allowedPaths) && c.allowedPaths.length ? c.allowedPaths.join("|") : "unbounded"}; level=${c.level}`;
}
