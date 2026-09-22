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
    // 0.5.12（F5 批次 3）：类别白名单——null=不限制类别（走既有判定）；数组=仅放行该类别集合。
    // 破坏类（delete/move/rm 等）永不可入 categories（由 isDestructiveCategory 结构性排除）。
    categories: null,
    // 0.5.12（F5 批次 3）：完成自动降级——契约内命令成功后（exit 0 + 产出物），将此信号记录
    // 至 completesAfter，后续契约命中自动降级为普通判定（TTL 不再续期）。
    completesAfter: null,
    source: "default"
  };
}

/** 非破坏动作类别（F5 类别白名单的可选集；破坏类永不可入） */
export const NON_DESTRUCTIVE_CATEGORIES = new Set(["install", "build", "test", "audit", "analyze", "naming", "sync", "restore"]);
/** 破坏类类别（任何契约类别白名单都必须排除） */
export const DESTRUCTIVE_CATEGORIES = new Set(["delete", "move", "replace", "purge"]);

/** 从命令文本推断动作类别（纯函数；未知→null 走普通判定）。破坏性词返回破坏类。 */
export function categoryOfCommand(command) {
  const s = String(command || "").toLowerCase();
  if (/remove-item|\brm(?:dir)?\b|del(?:ete)?\b|move-item|\bmv\b|rename-item|\bren\b|clear-content|clean|purge|rm\s+-/.test(s)) return "delete";
  if (/install|add\s+--save|pnpm\s+add|npm\s+install|yarn\s+add/.test(s)) return "install";
  if (/build|tsc|tsdown|vite\s+build|webpack|rollup|compile|bundle/.test(s)) return "build";
  if (/test|jest|vitest|playwright|npm\s+test|pnpm\s+test|verify/.test(s)) return "test";
  if (/audit|mount|consistency|dump-config|inspect/.test(s)) return "audit";
  if (/analyze|analysis|review|read|grep|search/.test(s)) return "analyze";
  return null;
}

/** 类别是否属于破坏类（结构性排除：破坏类永不因契约类别白名单放行） */
export function isDestructiveCategory(cat) {
  return cat === "delete" || cat === "move" || cat === "replace" || cat === "purge";
}

/**
 * 会话契约初始化（批次 4，阶段 3 默认武装）：
 * 优先级：defaults 显式（用户配置）> global 模板（用户 /guard mode|budget 写入且非默认）> armed 推导 > 系统默认。
 * 默认武装（用户拍板 A）：armed 且未见显式 mode/level → {mode:"change", level:"guard"}；
 * agentBudget 0（系统默认/未显式设置）→ 2（日常可用，避免武装附带"子代理全拦"副作用）。
 * @param {object} cfg config.js 的 taskContract 配置段（{taskContractMode, defaults})
 * @param {object|null} globalContract 全局（模板）会话契约；首次/global 自身传 null
 */
export function initSessionContract(cfg = {}, globalContract = null) {
  const defaults = (cfg && cfg.defaults) || {};
  const base = { ...defaultContract(), ...defaults };
  const globalUserSet = globalContract && globalContract.source && globalContract.source !== "default";
  if (globalUserSet) {
    if (globalContract.mode && globalContract.mode !== base.mode) base.mode = globalContract.mode;
    if (globalContract.level && globalContract.level !== base.level) base.level = globalContract.level;
    if (typeof globalContract.agentBudget === "number" && globalContract.agentBudget > 0 && base.agentBudget === 0) {
      base.agentBudget = globalContract.agentBudget;
    }
    if (globalContract.hashPolicy && globalContract.hashPolicy !== base.hashPolicy) base.hashPolicy = globalContract.hashPolicy;
    if (globalContract.dependencyPolicy && globalContract.dependencyPolicy !== base.dependencyPolicy) base.dependencyPolicy = globalContract.dependencyPolicy;
    if (Array.isArray(globalContract.allowedPaths)) base.allowedPaths = globalContract.allowedPaths;
  }
  const armed = cfg && cfg.taskContractMode === "armed";
  const explicitMode = "mode" in defaults || (globalUserSet && globalContract.mode && globalContract.mode !== "unconfirmed");
  if (armed && base.agentBudget === 0) base.agentBudget = 2;
  if (armed && !explicitMode) {
    base.mode = "change";
    base.level = "guard";
  }
  base.source = "session-init";
  return base;
}

/** 契约裁决 → pre-execute 决策（批次 4：deny 真实物理拦截，不再仅审计放行）。allow/report → null。 */
export function contractOutcomeToPreDecision(dec) {
  if (!dec) return null;
  if (dec.outcome === "deny") {
    return { kind: "deny", reason: `${dec.reason}（任务契约｜${dec.nextStep || "请调整契约或停止该操作"}）` };
  }
  if (dec.outcome === "ask") {
    return { kind: "ask", reason: `${dec.reason}（任务契约｜${dec.nextStep || "请确认或使用放行词"}）` };
  }
  return null;
}

/**
 * 委托预算扣减（批次 5.5，2026-08-24；用户指示提前到发布前）：启动即计——纯函数，不污染原对象。
 * 语义：调用即占额度（失败不退还，保守安全面）；配合 decideContractAction 的预算越限 deny。
 */
export function consumeDelegateBudget(contract, count = 1) {
  const n = Math.max(0, Number(count) || 0);
  return { ...contract, agentsUsed: (Number(contract?.agentsUsed) || 0) + n };
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

// ── 域 3 第一枪（2026-09-22）：naturalMode 五条正则迁配置层（rule-engine.json 的 naturalMode 键）。
// 内置＝语言无关最小集；取词走 getter，禁止顶层缓存实例。──
const NATURAL_MODE_BUILTIN = {
  stop: /^(?:stop|stop now)[.!\s]*$/.source,
  review: /\breview only\b|\b(?:do not|don't) (?:edit|change|fix) (?:anything|the (?:repo|repository|files?|code))\b/.source,
  answer: /\banswer only\b/.source,
  monitor: /\bmonitor only\b/.source,
  change: /^(?:please\s+)?(?:fix|implement|change|apply|patch)\b/.source
};
const NATURAL_MODE_KEYS = ["stop", "review", "answer", "monitor", "change"];

let naturalModeOverride = null; // { <key>?: string } | null

/** 域 3 第一枪：以现 override 为底，合法键写入；非法／未知／空串不改该键；
 *  仅非对象或空对象才五键全还原；某键非空＝该键默认合并；{ clear: true }＝该键仅配置 */
export function setNaturalMode(cfg, opts = {}) {
  if (cfg === undefined || cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
    naturalModeOverride = null;
    return;
  }
  if (Object.keys(cfg).length === 0) {
    naturalModeOverride = null;
    return;
  }
  const next = { ...(naturalModeOverride || {}) };
  for (const [k, v] of Object.entries(cfg)) {
    if (!NATURAL_MODE_KEYS.includes(k)) continue;
    if (typeof v !== "string" || v.length === 0) continue;
    try {
      new RegExp(v, "i");
    } catch {
      continue;
    }
    next[k] = opts?.clear ? v : `(?:${NATURAL_MODE_BUILTIN[k]})|(?:${v})`;
  }
  naturalModeOverride = Object.keys(next).length > 0 ? next : null;
}

function currentNaturalMode(key) {
  return new RegExp(naturalModeOverride?.[key] ?? NATURAL_MODE_BUILTIN[key], "i");
}

// 件 D（2026-09-22）：haystack 收窄——剥围栏后再取词。
// 三步顺序固定：① 已闭合围栏块（``` 或 ~~~，至少三连；含语言标记行与收尾行）
//              ② 未闭合围栏开头（有开头无收尾 → 剥到串尾）
//              ③ 同行成对的行内反引号（一连或两连，内容不含反引号与换行）
// 不剥缩进代码块（4 空格缩进块照旧留在文本里）。
// 注：件 A（classifyAction）与此处无关，勿混同（两者都以 analysis 命名，本处是取词面）。
function stripFencedCode(text) {
  const lines = String(text || "").split(/\r?\n/);
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^[ \t]*(`{3,}|~{3,})([\s\S]*)$/);
    if (!m || /[^\s\w.+-]/.test(m[2])) {
      kept.push(lines[i]);
      continue;
    }
    const markerChar = m[1][0];
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const close = lines[j].match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
      // 收尾围栏须同字符且不短于开头（Markdown 口径）
      if (close && close[1][0] === markerChar && close[1].length >= m[1].length) {
        end = j;
        break;
      }
    }
    if (end === -1) break; // 未闭合 → 剥到串尾（后续行不再保留）
    i = end; // 已闭合 → 连同收尾行整块摘除
  }
  // 两连整段优先于一连（防一连空对````先吃掉两连开头）
  return kept.join("\n").replace(/``[^`\n]*``|`[^`\n]*`/g, "");
}

/** 件 D：取剥围栏后第一条非空行（trim）；无非空行返回 null（review／answer／monitor 据此不命中） */
function firstNonEmptyLine(s) {
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return null;
}

/** 从用户自然语言推断任务模式；低置信返回 null */
export function naturalMode(text, previous = defaultContract()) {
  const s2 = stripFencedCode(text).trim();
  if (!s2) return null;
  if (currentNaturalMode("stop").test(s2)) {
    return { mode: "answer", source: "explicit-stop" };
  }
  const first = firstNonEmptyLine(s2);
  if (first !== null && currentNaturalMode("review").test(first)) {
    return { mode: "review", source: "natural-explicit" };
  }
  if (first !== null && currentNaturalMode("answer").test(first)) {
    return { mode: "answer", source: "natural-explicit" };
  }
  if (first !== null && currentNaturalMode("monitor").test(first)) {
    return { mode: "monitor", source: "natural-explicit" };
  }
  const wasNonMutating = ["answer", "review", "monitor"].includes(previous.mode);
  const explicitChange = currentNaturalMode("change").test(s2);
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

  // 0.5.12（F5 批次 3）：类别白名单——契约配置了 categories 时：
  // ① 破坏类句子结构性拒绝（不因契约放行——最坏情况缓解）；
  // ② 已知类别不在白名单 → deny；未知类别（null）→ 普通判定（不放大契约）。
  if (Array.isArray(contract.categories) && contract.categories.length > 0) {
    const cat = categoryOfCommand(action.commandText || action.cmd || "");
    if (cat && isDestructiveCategory(cat)) {
      return { outcome: "deny", family: "S", reasonCode: "DESTRUCTIVE_NOT_ALLOWED", reason: `动作类别 ${cat} 属破坏类，任务契约永不放行`, nextStep: "改用非破坏操作，或退出任务契约" };
    }
    if (cat && !contract.categories.includes(cat)) {
      return { outcome: "deny", family: "S", reasonCode: "CATEGORY_NOT_IN_CONTRACT", reason: `动作类别 ${cat} 不在契约白名单 [${contract.categories.join(",")}]`, nextStep: `更新契约类别（如 /guard contract categories build,test）` };
    }
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
