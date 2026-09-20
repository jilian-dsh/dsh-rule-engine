// guard-core.js - 工具守卫裁决（纯函数，可独立测试）。
// 被 index.js 的 ctx.tools.guard() 调用；返回 reason 即物理拒绝。
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getMessage, hasMessage } from "../messages.js";
import {
  BOM_WRITE,
  DESTRUCTIVE_CMD,
  dshKeywordsRe,
  INLINE_CMD,
  PROTECTED_FILENAME_RE,
  commandText,
  isAssemblyMutationTool,
  isBackupTool,
  isHighRiskEntryFile,
  isManualReadTool,
  isMutationCommand,
  isOutsideWorkspace,
  isProtectedConfigPath,
  isReadOnlyTool,
  isSensitiveToolCall,
  isVariablePath,
  isVerificationCommand,
  isLowRiskWorkspaceNew,
  isAnalysisOp,
  isAnalysisScratchPath,
  extractAnalysisScratchPaths,
  matchManualPath,
  pathTarget
} from "./patterns.js";
import { authMatches, describeAuth, describeOp, describeScopes, findMatchingAuth, operationOf, askQuestionText, inferPathPrefixFromText, inferTypeFromText, scopesFromIntents } from "./authorization.js";
import { parseUserIntents, shouldDenyMutation } from "./intent.js";
import { toolClass } from "./tool-catalog.js";
import { verdictForDeny } from "./llm-intent.js";
import { computeMountSignature, profileNameFromArgs } from "./mount-signature.js";
import { findBackupForPath, getSessionState, maybeReloadIfChanged } from "./state.js";
import { isVersionedFile, validateEditedFile } from "./version-guard.js";
import { decideContractAction, defaultContract, isArmed } from "./contract.js";
import { kindOf } from "./measure-kinds.js";
import { classifyAction } from "./overengineering.js";
import { labelFingerprint, labelsAllowFingerprint } from "./label-fingerprint.js";

function sessionIdOf(exec) {
  const agent = exec?.agent;
  if (!agent) return "global";
  if (typeof agent.session === "object" && agent.session?.id) return agent.session.id;
  if (typeof agent.session === "string") return agent.session;
  return "global";
}

/**
 * B2（2026-08-28 阶段二）：委派/子代理会话判定（规则 22④"无用户消息回合（委派…）"的识别层）。
 * 官方子代理（dsh-subagent-in-process-driver）把任务 prompt 以 source.kind="user" 注入子会话，
 * 引擎按真实用户消息处理 → 子代理的"任务书"被判"无执行分点"→ 读文件等操作被 ERR-L8QAXS 拦
 * （2026-08-28 实弹）。规则 22④ 承诺委派回合不做此判定；判定依据 = 会话元数据
 * （agent.session.meta.delegationDepth>0 / origin==="subagent" / 存在 parentSession）。
 */
function isDelegatedSession(exec) {
  const agent = exec?.agent;
  const sess = agent?.session;
  if (!sess || typeof sess !== "object") return false;
  const meta = sess.meta;
  if (meta && typeof meta === "object") {
    if (Number(meta.delegationDepth) > 0) return true;
    if (meta.origin === "subagent") return true;
    if (typeof meta.parentSession === "string") return true;
  }
  // 兜底：agent 层（部分驱动结构 meta 在 agent 侧）
  if (Number(agent?.meta?.delegationDepth) > 0 || agent?.meta?.origin === "subagent") return true;
  return false;
}

// 判据 A（2026-09-09）：规则号清单**不再硬编码**——放行提示 key 由约定推导
//（rule-hint.<ruleId>），是否存在由 messages 层决定；规则号变化时改本机配置即可。

// 0.5.12（F3）：拒绝来源前缀——机器可解析 token 化（/guard log 可按来源 grep 过滤）
// 约定：[guardian:rule22]（规则层）/ [guardian:contract]（任务契约/机制类）/ [guardian:guard]（守卫层）
// 官方 approval 层在引擎外，无法加前缀（F3 边界：只做自己三层 + 文档化官方行为）
export function prefixSource(ruleId) {
  if (!ruleId) return "[guardian:guard]";
  if (String(ruleId).startsWith("__")) return "[guardian:contract]";
  return `[guardian:rule${ruleId}]`;
}

// ═══════════ 自由面 / 盲区（AGI 清单 P1-2，2026-09-09 第三批）═══════════
// 显式声明本守卫「不拦什么」（自由面）与「看不见/判不准什么」（盲区）——
// 目的：被拦的人能一眼看到哪些动作本来就不需要授权（少走弯路），
// 以及哪些风险本引擎兜不住（别把守卫当安全边界）。
// 查询：/guard freedom
/** 自由面：无需授权即可执行的操作类别（守卫不拦）。
 *  第 1 批 1b：内置默认 = **通用骨架**（语言/环境/规则集无关）；本机完整版经
 *  rule-engine.json 的 guardFreedom 键覆盖（原为硬编码的本机规则体系自描述）。 */
export const FREEDOM_SURFACE_DEFAULT = [
  "Read-only tools: file reads, searches, status queries, web fetch/search",
  "Scratch-area writes: the analysis scratch and backup directories (scripts, downloads, temp artifacts)",
  "Verification commands: tests, audit scripts, cold-load probes, --dry-run, read-only GETs",
  "Low-risk new files inside the workspace: a plain file that does not exist yet (not a protected name, not an assembly file, not a high-risk entry point)",
  "Asking and presenting: ask_user_question / todo_write / visualize / report",
  "Changes within an authorized scope: this turn has an execution clause and the path/type falls inside it",
  "Escape hatches: /guard unlock (config write protection) and /guard bypass (all guards suspended, audited)"
];
/** 盲区：守卫看不见或判不准的（本引擎不是安全边界）。默认 = 通用骨架，本机可覆盖。 */
export const BLIND_SPOTS_DEFAULT = [
  "Out-of-band writes: editing files in a terminal or another editor bypasses the tool chain entirely — the guard cannot see them",
  "Semantic misjudgment: authorization/intent decisions rely on word lists and the LLM; uncovered phrasing may be misread (use /guard label to flag)",
  "Unclassified tools: tools absent from the classification table are treated as unknown (first call is blocked until allowed)",
  "External programs writing files: a program invoked by the shell can write files whose paths never appear in the command text",
  "Self-certification rules: the engine only reminds; whether they are followed depends on the model",
  "Weak criticism signals: deliberately broad shapes are logged but not blocked, so real criticism can be missed",
  "Cross-session state: authorization/unlock live in process memory and do not survive a restart or carry across sessions"
];

// 本机覆盖（rule-engine.json 的 guardFreedom 键；null = 用通用骨架）
let freedomOverride = null;

/**
 * 注入本机自由面/盲区（Override 语义：undefined/null = 不干预；对象 = 配置即真相；{} = 回退骨架）。
 * @param {{freedom?: string[], blindSpots?: string[]}} cfg
 */
export function setGuardFreedom(cfg) {
  const applied = [];
  const rejected = [];
  if (cfg === undefined || cfg === null) return { applied, rejected, noop: true };
  if (typeof cfg !== "object" || Array.isArray(cfg)) {
    freedomOverride = null;
    return { applied, rejected };
  }
  const next = {};
  for (const field of ["freedom", "blindSpots"]) {
    const list = cfg[field];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      rejected.push({ key: field, reason: "not-array" });
      continue;
    }
    const clean = list.filter((x) => typeof x === "string" && x.trim().length > 0);
    if (clean.length !== list.length) rejected.push({ key: field, reason: "non-string-items-dropped" });
    if (clean.length > 0) {
      next[field] = clean;
      applied.push(field);
    }
  }
  freedomOverride = Object.keys(next).length > 0 ? next : null;
  return { applied, rejected };
}

/** 当前生效的自由面（本机覆盖优先 → 通用骨架） */
export function getFreedomSurface() {
  return freedomOverride?.freedom ?? FREEDOM_SURFACE_DEFAULT;
}

/** 当前生效的盲区（本机覆盖优先 → 通用骨架） */
export function getBlindSpots() {
  return freedomOverride?.blindSpots ?? BLIND_SPOTS_DEFAULT;
}

/** 是否处于本机覆盖状态 */
export function hasFreedomOverride() {
  return freedomOverride !== null;
}

/** 回退通用骨架（测试用） */
export function resetGuardFreedom() {
  freedomOverride = null;
}

/** 兼容别名（旧引用；等价于 getFreedomSurface） */
export const FREEDOM_SURFACE = FREEDOM_SURFACE_DEFAULT;
/** 兼容别名（旧引用；等价于 getBlindSpots） */
export const BLIND_SPOTS = BLIND_SPOTS_DEFAULT;

function makeHit(cfg, reason) {
  const errId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const hintKey = `rule-hint.${cfg.ruleId}`;
  const hint = hasMessage(hintKey) ? getMessage(hintKey) : getMessage("guard.rule-hint-fallback");
  return {
    ruleId: cfg.ruleId,
    title: cfg.title,
    action: "deny",
    errId,
    reason: `${prefixSource(cfg.ruleId)} ${reason}（规则 ${cfg.ruleId}｜放行：${hint}｜ERR-${errId}｜误判可打标：/guard label ERR-${errId} incorrect）`
  };
}

// 0.5.9（单真源）：COVERED_MUTATION_TOOLS / SAFE_UNCOVERED_TOOLS 独立覆盖表已废弃——
// 工具分类以 lib/core/tool-catalog.js 的唯一分类表为准（24④/22/unknown 全部读它），
// 双表漂移即 run_code 事故根因（K-01/K-02/K-06 依据）。

function looksLikeFileMutation(name, args) {
  const a = args || {};
  return Boolean(a.file_path || a.path || a.command || a.code || a.execute || a.script || a.fn);
}

/** 统计 substring 在 text 中出现的次数（0.5.11 唯一性前提辅助） */
function countOccurrences(text, sub) {
  if (typeof text !== "string" || typeof sub !== "string" || sub.length === 0) return 0;
  let count = 0;
  let idx = text.indexOf(sub);
  while (idx !== -1) {
    count++;
    idx = text.indexOf(sub, idx + sub.length);
  }
  return count;
}

export function isProfilePackageJson(p) {
  return typeof p === "string" && /profiles[\\/][^\\/]+[\\/]package\.json$/i.test(p);
}

/** 判定命令是否"整条命令仅调用统一入口脚本"（无 ; | & 链式/换行/重定向）
 *  N1（2026-09-04 P2）：排除向文件的重定向（> / >> / &> / fd>file）——`入口 status x > AGENTS.md` 不再被豁免；
 *    仅保留 fd→fd 复制（2>&1 / 1>&2）。
 *  G1（2026-09-04 P2）：引号感知——引号内的换行/;|& 视为合法参数内容（上会话曾误拦合法多行参数）。
 *  entryMarker：统一入口脚本名（来自 localIntegrations.entryScript；无配置 = 不存在"统一入口"概念）。 */
function isEntryChannelCommand(cmd, entryMarker) {
  if (typeof cmd !== "string") return false;
  if (!entryMarker) return false; // 无配置 = 无对象，自然静默
  const c = cmd.trim();
  if (!c.includes(entryMarker)) return false;
  // ① 链式分隔（引号感知）：引号外的 ; | & 换行 → 非法
  let inQ = null;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (inQ) { if (ch === inQ) inQ = null; continue; }
    if (ch === '"' || ch === "'") { inQ = ch; continue; }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") return false;
  }
  // ② 重定向：摘除 fd 复制（N>&M / N<&M）后，任何 > / >> / &> 均非法（N1——含数字前置 2>/1> 盲区）
  //  2026-09-06 0.6.x 修复：引号感知——参数值内的 >（如 markdown 引用符/⟨⟩ 占位）不再误判重定向
  const noFd = c.replace(/\d*\s*[<>]&\s*\d+/g, "");
  const noQuoted = noFd.replace(/"[^"]*"|'[^']*'/g, "");
  if (/>>|&>|(?:^|[^<])>/.test(noQuoted)) return false;
  return true;
}

/** 计算 edit/write/str_replace 后的目标文件内容；无法可靠计算时返回 null */
function resultingFileContent(name, args) {
  const p = pathTarget(args);
  if (!p) return null;
  if (name === "write") return typeof args?.content === "string" ? args.content : null;
  if (!existsSync(p)) return null;
  let current;
  try { current = readFileSync(p, "utf8"); } catch { return null; }
  if (name === "edit") {
    const oldS = args?.old_string;
    const newS = args?.new_string;
    if (typeof oldS === "string" && typeof newS === "string" && current.includes(oldS)) return current.replace(oldS, newS);
    return null;
  }
  if (name === "str_replace_editor" && args?.command === "str_replace") {
    const oldS = args?.old_str;
    const newS = args?.new_str;
    if (typeof oldS === "string" && typeof newS === "string" && current.includes(oldS)) return current.replace(oldS, newS);
    return null;
  }
  return null;
}

/** 从 profile 目录解析 bundle 的 package.json（兼容 profiles/web/node_modules 与 profiles/node_modules） */
function resolveBundlePkgPath(bundleName, profilePkgPath) {
  const profileDir = dirname(profilePkgPath);
  const profilesNodeModules = join(dirname(profileDir), "node_modules");
  const candidates = [];
  if (bundleName.startsWith("@")) {
    const [scope, name] = bundleName.split("/");
    candidates.push(join(profileDir, "node_modules", scope, name, "package.json"));
    candidates.push(join(profilesNodeModules, scope, name, "package.json"));
  } else {
    candidates.push(join(profileDir, "node_modules", bundleName, "package.json"));
    candidates.push(join(profilesNodeModules, bundleName, "package.json"));
  }
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** 从 profile package.json 的 dependencies 中解析本地 link/file 依赖的包路径；无法解析返回 null */
function resolveLocalDependencyPkgPath(bundleName, profilePkgPath, parsed) {
  const dep = parsed?.dependencies?.[bundleName] ?? parsed?.devDependencies?.[bundleName] ?? parsed?.optionalDependencies?.[bundleName];
  if (typeof dep !== "string") return null;
  let localPath = null;
  if (dep.startsWith("link:")) localPath = dep.slice(5);
  else if (dep.startsWith("file:")) localPath = dep.slice(5);
  if (!localPath) return null;
  const resolved = isAbsolute(localPath) ? localPath : resolve(dirname(profilePkgPath), localPath);
  const pkgPath = join(resolved, "package.json");
  return existsSync(pkgPath) ? pkgPath : null;
}

/** 官方 bundle 白名单（B1 修复，2026-09-10）：规则 24 自己的豁免条款原文即「官方 bundle 由官方机制管理，
 *  模型不主动修改」——引擎此前未在代码里兑现。这两个包**永远**位于 DSH 本体或 profiles 共享层，
 *  独立 DSH_HOME 的新 profile 两者都可能尚未建立 → 校验必然失败并**卡死 profile 声明编辑**（试点主要阻塞点）。 */
const OFFICIAL_BUNDLES = new Set(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);

/** 解析给定 profile package.json **内容**中非 bundle / 无法确认的项（内容级纯函数，供 B1 与 C1 复用） */
export function nonBundleInContent(content, profilePkgPath) {
  let parsed;
  try { parsed = JSON.parse(content); } catch { return null; }
  const bundles = parsed?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return null;
  const bad = [];
  for (const b of bundles) {
    if (OFFICIAL_BUNDLES.has(b)) continue; // B1：官方 bundle 直接放行（规则 24 豁免条款）
    const pkgPath = resolveBundlePkgPath(b, profilePkgPath) || resolveLocalDependencyPkgPath(b, profilePkgPath, parsed);
    if (!pkgPath) {
      const dep = parsed?.dependencies?.[b] ?? parsed?.devDependencies?.[b] ?? parsed?.optionalDependencies?.[b];
      const depDesc = typeof dep === "string" ? `dependencies 为 ${dep}` : "dependencies 中无此包";
      // B1 建议 3：给出可执行的排查方向（独立 DSH_HOME 场景最常见的成因）
      bad.push(`${b}（找不到 package.json，无法确认类型；${depDesc}。请先用 dev_install_package 或先安装依赖再写 bundles；若为独立 DSH_HOME，请确认 profiles/node_modules 共享层存在——该层由 DSH 真实启动时的 healProfilesModuleFallback 自动建立）`);
      continue;
    }
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (!pkg?.dsh?.bundle) bad.push(`${b}（未声明 dsh.bundle）`);
    } catch {
      bad.push(`${b}（package.json 读取失败）`);
    }
  }
  return bad.length ? bad : null;
}

/** 若本次文件变更会写入 profile package.json 的 dsh.profile.bundles，返回其中非 bundle/无法确认的项 */
export function nonBundleInProfileBundles(name, args) {
  const p = pathTarget(args);
  if (!isProfilePackageJson(p)) return null;
  const content = resultingFileContent(name, args);
  if (!content) return null;
  return nonBundleInContent(content, p);
}

/** C1 修复（2026-09-10）：判定本次变更是否为「使装配声明趋于自洽」的修复动作。
 *  判据：变更**前** profile package.json 的 bundles 不自洽（存在解析不到的项），变更**后**自洽。
 *  用途：mount-audit 守卫的**收敛豁免**——解除「不一致态只能靠被拦动作修复」的死循环。
 *  保守边界：读不到原文件、或变更后仍不自洽 → 不豁免。 */
export function isConvergingBundleFix(name, args) {
  const p = pathTarget(args);
  if (!isProfilePackageJson(p)) return false;
  const after = resultingFileContent(name, args);
  if (!after) return false;
  let before = null;
  try { before = readFileSync(p, "utf8"); } catch { return false; }
  const beforeBad = nonBundleInContent(before, p);
  const afterBad = nonBundleInContent(after, p);
  return Array.isArray(beforeBad) && beforeBad.length > 0 && (!afterBad || afterBad.length === 0);
}

/** 任务契约守卫：仅在总开关开启且会话 armed 时硬拦；ask 场景交给 tools/pre-execute */
function taskContractGuardDecision(state, exec, session) {
  if (!state.taskContract?.taskContractEnabled) return null;
  const contract = session?.contract || defaultContract();
  if (!isArmed(contract, state.taskContract)) return null;
  const action = classifyAction(exec?.name, exec?.arguments);
  const dec = decideContractAction({ contract, action, config: state.taskContract });
  // 2026-08-25 预算双判防护：AGENT_BUDGET_EXHAUSTED 唯一裁决点 = tools/pre-execute 钩子（扣减前判定）；
  // guard 层可能在 pre-execute 扣减之后运行（收到已扣 contract），若在此重判会误拒“预算内”调用（允许 N 实际 N-1）。
  if (dec.reasonCode === "AGENT_BUDGET_EXHAUSTED") return null;
  if (dec.outcome === "deny") {
    return makeHit(
      { ruleId: "__task-contract", title: `任务契约：${dec.reasonCode}`, action: "deny" },
      `【硬拦截】${dec.reason}（${dec.reasonCode}｜任务契约｜放行：${dec.nextStep || "..."}｜ERR-${Math.random().toString(36).slice(2, 8).toUpperCase()}）`
    );
  }
  return null;
}

/**
 * 裁决一次工具调用。
 * @param {object} state createState 返回的运行时状态
 * @param {object} exec ToolExecution（至少 name/arguments）
 * @param {number} now
 * @returns {object|null}
 */
export function guardDecision(state, exec, now = Date.now(), opts = {}) {
  if (state.enabled === false) return null;
  if (state.bypassUntil > now) return null;
  maybeReloadIfChanged(state, now);
  const name = String(exec?.name || "");
  const args = exec?.arguments || {};
  const session = getSessionState(state, sessionIdOf(exec));
  const unlock = state.unlockUntil > now;
  const p = pathTarget(args);
  const cmd = commandText(args);

  // 只读操作无条件放行（read/grep/glob/read_image/str_replace_editor view）
  if (isReadOnlyTool(name, args)) return null;

  // 0.5.12（F2）：打标指纹放行——同指纹命令已被用户 /guard label incorrect 确认过 →
  // 直接放行并记 label-hits 审计（可查、可撤）。危险命令指纹为空 → 永不命中。
  // 只对规则层拒绝（rule22/13A 等）生效——官方审批层与 self-protect 不受影响。
  if (name === "pwsh" || name === "bash") {
    const fp = labelFingerprint(cmd);
    if (fp && labelsAllowFingerprint(state.labelRows || [], fp, now)) {
      opts?.audit?.({
        kind: "label-hits",
        rule: "__label-fingerprint",
        name: "打标指纹放行",
        event: "tool/guard",
        tool: name,
        args: { command: cmd },
        reason: `命令命中打标指纹（用户已确认 incorrect）：${fp.slice(0, 120)}`,
        session: sessionIdOf(exec)
      });
      return null;
    }
  }

  // 任务契约守卫（总开关关闭时不生效）
  const contractHit = taskContractGuardDecision(state, exec, session);
  if (contractHit) return contractHit;

  // ask_user_question 必须真正送达用户；已有授权不再吞弹窗（2026-08-24 修复：
  // __already-authorized 之前会把 ask 拦截成内部“已有授权”，导致用户收不到任何弹窗）
  if (name === "ask_user_question") {
    const qText = askQuestionText(args?.questions);
    if (qText) {
      // 弹窗消减（2026-08-24）：本回合 ask 已被拒 → 再次 ask 直接拦（提示改用普通文本）
      if (session.turn.askRejected) {
        return makeHit(
          { ruleId: "__ask-rejected", title: "本回合 ask 已被拒绝", action: "deny" },
          `【提示】本回合的 ask 已遭拒绝（规则 22 沟通直接性）。用户已明确答复，无需再次弹窗询问；用普通文本说明即可。`
        );
      }
      // 5 分钟内已有被拒的 ask 记录 → 拦（防连环弹窗 → not-pending 诱因链）
      // C3（2026-08-28）：节流池仅含"明确拒绝"（未响应不入池，见 index.js ask 结果处理）
      const recentReject = (state.askRejections || []).some((r) => r.sessionId === session.id && now - r.at < 5 * 60 * 1000);
      if (recentReject) {
        return makeHit(
          { ruleId: "__ask-throttle", title: "ask 请求过频", action: "deny" },
          `【提示】5 分钟内已有一次被明确拒绝的 ask（规则 22 沟通直接性）。再次弹窗可能无法送达；用普通文本说明即可。`
        );
      }
    }
  }

  // 内部自护：插件配置/理解产物/规则文件禁止模型直写（/guard unlock 可临时放行）
  if (!unlock && (name === "edit" || name === "write" || (name === "str_replace_editor" && args?.command !== "view")) && isProtectedConfigPath(p)) {
    return makeHit(
      { ruleId: "__self-protect", title: "规则引擎配置只读（需 /guard unlock）", action: "deny" },
      `【硬拦截】${p} 受规则引擎保护：需要用户输入 /guard unlock 放行（解锁范围含 rule-engine.json / rule-understanding.json / AGENTS.md，默认 10 分钟）。请停止并让用户在对话框输入 /guard unlock。`
    );
  }

  // 阶段 C：硬拦 pwsh/bash 绕过统一入口直接写受保护文件（规则 19⑧/21⑨ 的机器执行层）
  // 合法通道 = 整条命令仅调用统一入口脚本（无 ; | & 链式/换行，防注释文本伪造放行）
  // A2-2（0.6.0）：无 localIntegrations.entryScript 配置 = 守卫无对象（不激活）；protectedFiles 为通用基线之上的本机追加清单
  if (!unlock && (name === "pwsh" || name === "bash")) {
    const cmd = commandText(args) || "";
    const entryMarker = state.localIntegrations?.entryScript;
    if (entryMarker && cmd && isMutationCommand(cmd) && (PROTECTED_FILENAME_RE.test(cmd) || matchManualPath(cmd, state.localIntegrations?.protectedFiles || []))) {
      if (!isEntryChannelCommand(cmd, entryMarker)) {
        return makeHit(
          { ruleId: "__self-protect", title: "受保护文件禁止绕过统一入口直写", action: "deny" },
          `【硬拦截】受保护文件禁止通过 pwsh/bash 绕过统一入口直写；请使用 ${entryMarker}（整个命令只能调用该脚本，不得链式拼接其他写命令/重定向；或 /guard unlock 临时放行）。`
        );
      }
    } else if (!entryMarker && cmd && isMutationCommand(cmd) && (PROTECTED_FILENAME_RE.test(cmd) || matchManualPath(cmd, state.localIntegrations?.protectedFiles || []))) {
      // A2-2（0.6.0）：无 entryScript 配置 = 守卫无对象——登记 skipped 审计（验证"默认无"的留痕；不拦截）
      opts?.audit?.({ kind: "li-skipped", rule: "19", name: "本地集成未配置（守卫无对象）", event: "tool/guard", reason: "skipped: no localIntegrations.entryScript——该守卫在此环境不存在（0.6.0 默认无）", session: sessionIdOf(exec) });
    }
  }

  // 写前版本校验（建议③）：版本化文件（SKILL.md/AGENTS.md/CHANGELOG/README 等）在写入前
  // 用 old/new 模拟结果做校验，不合规直接拒绝——避免"先写后回滚"的副作用与假成功
  // 位置在自护之后：受保护文件需先 unlock（用户明确授权）再接受版本校验
  if ((name === "edit" || name === "write" || (name === "str_replace_editor" && args?.command !== "view")) && p && isVersionedFile(p)) {
    try {
      const current = readFileSync(p, "utf8");
      const simulated = resultingFileContent(name, args) ?? current;
      // 0.5.11（用户定稿）：单行整句重写放行需 old 唯一匹配——工具层已拒多处匹配；
      // 唯一时传给 validateEditedFile/append 作为放行前提（唯一 = 替换位置正确 = 语义编辑非覆盖）。
      const oldStr = args?.old_string ?? args?.old_str ?? "";
      const uniqueMatch = oldStr.length > 0 ? countOccurrences(current, oldStr) === 1 : false;
      const check = validateEditedFile(current, simulated, oldStr, args?.new_string ?? args?.new_str ?? "", uniqueMatch);
      if (!check.ok) {
        return makeHit(
          { ruleId: "__version-guard", title: "版本守卫：写入前校验", action: "deny" },
          `【硬拦截】${p} 是版本化文件，本次编辑未通过版本守卫（写前校验）：${check.errors.join("；")}。请修正 old_string/new_string（保留原文逐行或按行包含关系）后重试`
        );
      }
    } catch {
      // 文件不可读等异常不阻断（交给写后自检兜底）
    }
  }

  for (const cfg of state.configs) {
    if (cfg.disabled) continue;
    // 低置信规则不硬拦（保守不误拦，交给 /guard rules 人工复核）——批次 3：跳过必须留痕（N2 防御可观测）
    if (cfg.confidence === "low") {
      opts?.audit?.({
        kind: "n2-skip",
        rule: cfg.ruleId,
        name: "低置信规则跳过",
        event: "tool/guard",
        reason: `规则 ${cfg.ruleId} 理解低置信 → 跳过硬拦（保守不误拦；请在 /guard rules 对该规则复核）`,
        session: sessionIdOf(exec)
      });
      continue;
    }
    // 分级执行：只有 A 硬拦 / C 时序 / M 元规则才进入工具守卫
    const actions = cfg.actions || [];
    if (!actions.some((a) => a === "deny" || a === "ask" || a === "meta")) continue;
    const hit = matchRule(cfg, { name, args, p, cmd, session, unlock, state, now, audit: opts?.audit, exec });
    if (hit) return hit;
  }
  return null;
}

function matchRule(cfg, ctx) {
  const { name, args, p, cmd, session, unlock, state, now, audit, exec } = ctx;
  const id = String(cfg.ruleId);
  // 防热重载/事件顺序导致意图状态落后：若当前 turn.userText 与已缓存 intents.raw 不一致，
  // 或尚无 intents 但有用户文本，则以最新用户文本重新解析并回写，避免用旧状态误拦。
  // P0-3 根修（2026-08-24）：裁决基底只用“本回合”的真实用户文本（turn.userText），
  // 不再回退 lastUserText——上一轮残留文本（如含“为什么”的询问）不得裁决本轮。
  const currentText = session.turn.userText || "";
  let turnIntents = session.turn.intents;
  if (turnIntents && currentText && turnIntents.raw !== currentText) {
    turnIntents = parseUserIntents(currentText);
    session.turn.intents = turnIntents;
  } else if (!turnIntents && currentText) {
    turnIntents = parseUserIntents(currentText);
    session.turn.intents = turnIntents;
  }
  // 无用户消息回合（委派/ask 答复后/状态信号）不做规则 22 判定；敏感操作由 12A/13A 独立把关
  const denyMutation = turnIntents
    ? shouldDenyMutation(turnIntents, session.turn.askSeen && !session.turn.askRejected)
    : false;

  // 规则 22 机器化：无执行分点/存在歧义 → 本回合禁止变更类工具调用
  //（"你的执行方案难道没问题吗？"虽含"执行"仍是疑问句——同形词不构成指令，不豁免）
  if (kindOf(cfg.handler) === "intent-direct") {
    // B2（2026-08-28 阶段二）：委派/子代理回合不做"无执行分点"判定（规则 22④ 的识别层落地）——
    // 子代理任务书以 source.kind="user" 注入，会被当用户消息判"无执行分点"而误拦（ERR-L8QAXS 实弹）。
    if (isDelegatedSession(exec)) {
      audit?.({ kind: "delegated-skip", rule: cfg.ruleId, name: "委派回合豁免规则22", event: "tool/guard", reason: `委派会话（meta 判定）跳过"无执行分点"，敏感操作仍由 12A/13A 把关`, session: sessionIdOf(exec) });
      return null;
    }
    // 机制 B（2026-08-24）：工具分类制（纯函数，覆盖现有与未来插件注册的全部工具）——
    // analysis（只读分析放行）/ artifact（产物放行+审计）/ unknown（物理不拦，由 pre-execute
    // ask/deny 层首调处置，防新插件绕过）；mutating 维持原有严格逻辑。0.5.9 单真源：唯一分类表。
    const cls = toolClass(name, args);
    // 0.5.10 分析通道（用户多次提出：只读分析需要写临时脚本/输出——解压副本/聚合日志等）：
    // 严格只读 ∪ 分析临时区写 ∪ 分析脚本区调用 → 任何回合放行 + 审计留痕。
    // 红线：工作区外路径命中临时区段（如 C:\xxx\logs\）不豁免——落入常规变更判定。
    if (isAnalysisOp(name, args)) {
      const scratch = extractAnalysisScratchPaths(commandText(args) || "");
      const outside = scratch.filter((p) => isOutsideWorkspace(p, sessionIdOf(exec)));
      if (outside.length === 0) {
        audit?.({ kind: "analysis-scratch", rule: cfg.ruleId, name: "分析通道放行", tool: name, reason: `分析类操作（只读/临时区/分析脚本区）放行：${describeOp(operationOf(name, args))}`, session: sessionIdOf(exec) });
        return null;
      }
    }
    if (cls === "analysis") return null;
    if (cls === "artifact") {
      audit?.({ kind: "allow", rule: cfg.ruleId, name: "产物类工具放行", tool: name, reason: `分类 artifact（低风险产物写入，留痕可对账）：${describeOp(operationOf(name, args))}`, session: sessionIdOf(exec) });
      return null;
    }
    if (cls === "unknown") return null; // 物理不拦；pre-execute ask 层首调询问
    if (denyMutation) {
      // A 方案（2026-08-28 用户拍板）：方案/调研回合（无执行分点）写工作区正式路径 = 落盘/产出动作
      // → 拦 + "确认后落盘"文案（不静默放行——原 isLowRiskWorkspaceNew 在此静默放行，属越权）。
      // 方案性指令不构成落盘授权（规则 22 自证③）；分析通道/临时区在 isAnalysisOp 已放行（工具不拦）；
      // _inbox 按分类文本定位=暂存待归位的产物，同正式路径（拦）；工作区外由下方"询问"分支统一兜底。
      if ((name === "edit" || name === "write" || (name === "str_replace_editor" && args?.command !== "view")) && !isAnalysisOp(name, args) && !isOutsideWorkspace(p, sessionIdOf(exec))) {
        return makeHit(cfg, `【硬拦截】本回合是方案/调研指令，写工作区文件属于"落盘/产出"动作——方案性指令不构成落盘授权（规则 22 自证③）。落盘需你明确确认：请回复"落盘"或"确认后保存"（或对产出位置确认）`);
      }
      // LLM 意图兜底（方案 A，2026-08-24）：词表判拦 + LLM 高/低置信判 execute → 放行
      //（非对称：LLM 只解救不收紧；审计在预取时已记 intent-llm）
      const verdict = verdictForDeny(session.turn, state.llmIntentCfg || {});
      if (!verdict.mutationDenied) return null;
      if (isReadOnlyTool(name, args)) return null; // 只读 → 豁免
      const llmNote = verdict.source === "llm-low" ? "（LLM 低置信未能挽救）" : "";
      return makeHit(cfg, `【硬拦截】用户消息是询问/没有明确执行分点（规则 22）${llmNote}：请先回答/展示方案，待用户明确授权后再执行（放行：存在执行分点，或 ask_user_question 授权答复）`);
    }
    // 规则 22 粒度升级（2026-08-24，用户点名治本项）：
    // 存在执行分点时不再"同回合一词放行"，而是逐项比对本次变更是否落在
    // 本回合 execute 子句或 ask 授权的「工具类别 + 路径前缀」范围内；未覆盖 → 拦。
    // 无用户消息/状态信号/ask 答复后回合仍不做规则 22 判定（由 12A/13A 把关）。
    if (!turnIntents || !turnIntents.hasExecute) return null;
    if (isReadOnlyTool(name, args)) return null;
    if (cls === "mutating" || looksLikeFileMutation(name, args)) {} else return null;
    const op = operationOf(name, args);
    // v0.5.7 P0-1（用户拍板 2026-08-26）：验证类命令伴生放行——本回合已有 write/any/command
    // 授权（用户已批"修改/执行"）时，运行测试/冷加载/审计/语法检查属于该变更的验证闭环，
    // 不再被 write vs command 类型不匹配误拦（今天实弹连卡 4 次）。
    if ((name === "pwsh" || name === "bash") && isVerificationCommand(cmd)) {
      const verScopes = Array.isArray(session.turn.scopes) && session.turn.scopes.length > 0
        ? session.turn.scopes
        : scopesFromIntents(turnIntents);
      if (verScopes.some((s) => s.type === "write" || s.type === "any" || s.type === "command")) {
        audit?.({ kind: "allow", rule: cfg.ruleId, name: "验证命令伴生放行", tool: name, reason: `本回合已有 ${describeScopes(verScopes)} 授权 → 验证命令伴生（${describeOp(op)}）`, session: sessionIdOf(exec) });
        return null;
      }
    }
    // 保护性备份豁免（2026-08-26，backup 口径修复）：规则 12A 豁免③ / 13A ⑦ 均豁免
    // 复制到 .backups/.bak 的保护性备份——与 13A 分支口径一致，backup 类型不再被 22 粒度误拦。
    if (op.type === "backup") return null;
    // 本回合 scopes（execute 子句 + 本回合 ask 授权已由 handleSessionEvent 写入 turn.scopes）
    // C1（2026-08-28 阶段一）：并入 session.authorizations 中【带 TTL 且未过期】的授权——规则 22
    // 粒度与 12A/13A 同口径（findMatchingAuth 均考虑 TTL）。修复"12D 已记录授权、下一回合操作
    // 仍被 22 粒度拦"的授权分裂（2026-08-28 实弹：ask 授权后读取仍被拒）。
    // 安全边界：只并入显式 TTL 授权（=同任务窗口）；无 expiresAt 的长期授权不放宽本轮粒度
    // （2026-08-24 旧语义"历史授权不得放宽本轮"对永久授权仍成立——防上轮授权越权本轮跨操作）。
    const turnScopes = Array.isArray(session.turn.scopes) && session.turn.scopes.length > 0
      ? session.turn.scopes
      : scopesFromIntents(turnIntents);
    const ttlAuths = Array.isArray(session.authorizations)
      ? session.authorizations.filter((a) => a && typeof a.expiresAt === "number" && a.expiresAt > now)
      : [];
    const scopes = [...turnScopes, ...ttlAuths];
    if (!scopes.some((scope) => authMatches(scope, op))) {
      return makeHit(cfg, `【硬拦截】本次变更操作不在本回合执行分点/授权范围内（规则 22）：已授权范围 [${describeScopes(scopes)}]；本次操作 [${describeOp(op)}]。请补充明确授权（可用 ask_user_question）后再执行`);
    }
    // 可观测性（阶段 0，2026-08-24）：规则 22 粒度放行是最高频放行路径，必须留痕可查
    audit?.({ kind: "allow", rule: cfg.ruleId, name: "授权命中放行", tool: name, reason: `由授权放行（规则 22 粒度命中）：${describeScopes(scopes)} 覆盖 ${describeOp(op)}`, session: sessionIdOf(exec) });
    return null;
  }

  // 规则 1：同工具同参数连续失败 ≥2 次后拦第 3 次（失败计数由 tool/result 更新）
  if (kindOf(cfg.handler) === "retry") {
    const key = `${name}:${JSON.stringify(args || {})}`;
    const count = state.retryCounts.get(key) || 0;
    const userText = session.turn.userText || session.lastUserText || "";
    if (count >= 2 && /(?:重试|再试一次|再来一次|继续试|再试)/.test(userText)) {
      return null; // 用户明确要求重试 → 豁免
    }
    if (count >= 2) {
      return makeHit(cfg, `【硬拦截】同一工具调用已连续失败 ${count} 次，按规则 1 禁止第 ${count + 1} 次重试`);
    }
    return null;
  }

  // 规则 9：内联命令 / BOM 写配置（PS7 语义：仅拦显式 utf8BOM）
  if (kindOf(cfg.handler) === "inline-command") {
    if ((name === "pwsh" || name === "bash") && cmd) {
      if (INLINE_CMD.test(cmd)) {
        return makeHit(cfg, "【硬拦截】禁止内联命令（node -e / pwsh -c / node -p 等），请先写脚本文件再执行");
      }
      if (BOM_WRITE.test(cmd)) {
        return makeHit(cfg, "【硬拦截】禁止用 Set-Content/Out-File -Encoding utf8BOM 写 .json/.yaml（PS7 显式带 BOM）（放行：去掉 -Encoding utf8BOM——PS7 默认就是 UTF-8 无 BOM；或改用本机配置的统一入口脚本）");
      }
    }
    return null;
  }

  // 规则 18：DSH 任务首次工具调用前必须已读手册
  if (kindOf(cfg.handler) === "manual-first") {
    const userText = session.turn.userText || session.lastUserText || "";
    const firstTool = session.turn.toolCount === 0;
    if (firstTool && !session.manualReadSeen && dshKeywordsRe().test(userText) && !isManualReadTool(name, args, state.localIntegrations?.manualExempt?.paths || [])) {
      return makeHit(cfg, "【硬拦截】任务涉及 DSH，首次工具调用前需先 grep/read 本机手册（路径经 localIntegrations 配置）");
    }
    return null;
  }

  // 规则 13A：删除/覆盖/高风险写前需有“目标路径对应备份”证据
  if (kindOf(cfg.handler) === "backup") {
    // 统一入口命令豁免：入口脚本每次写入前自身执行备份（backup() 保留 5 份），
    // 引擎静态扫描看不到脚本内部动作（已知盲区）；入口命令也已被 __self-protect 限定为唯一写通道。
    if ((name === "pwsh" || name === "bash") && isEntryChannelCommand(cmd, state.localIntegrations?.entryScript)) return null;
    const destructive = (name === "pwsh" || name === "bash") && cmd && (DESTRUCTIVE_CMD.test(cmd) || (isSensitiveToolCall(name, args, sessionIdOf(exec)) && !/git\s+(push|commit)/i.test(cmd)));
    const highRiskWrite = (name === "edit" || name === "write" || (name === "str_replace_editor" && args?.command !== "view")) && isProtectedConfigPath(p);
    if (highRiskWrite && unlock && !isHighRiskEntryFile(p)) return null;
    if (destructive || highRiskWrite) {
      const op = operationOf(name, args);
      // 备份动作本身（复制到 .bak/.backups/trash-）不需要再“先备份”
      if (op.type === "backup") return null;
      const targetPath = highRiskWrite ? p : op.pathPrefix;
      // 含 shell 变量（$var / %var%）的路径无法可靠解析 → 跳过机械备份检查（P0-2，防变量路径误拦）
      if (targetPath && isVariablePath(targetPath)) return null;
      // 已获 12A/12D 授权的操作 = 用户已明确确认本次操作 → 跳过 13A 机械备份（P1-2，一次授权覆盖全规则）
      // 但高风险运行入口文件除外：即使已授权也必须有备份证据或明确提示
      const auth13 = findMatchingAuth([...(session.authorizations || []), ...(state.globalAuthorizations || [])], op);
      if (auth13 && !isHighRiskEntryFile(targetPath)) {
        audit?.({ kind: "allow", rule: cfg.ruleId, name: "授权命中放行", tool: name, reason: `由授权放行（13A 跳过备份）：${describeAuth(auth13)}`, session: sessionIdOf(exec) });
        return null;
      }
      // 复制/新建到“尚不存在”的目标文件：属于创建新文件，不适用 13A 覆盖备份要求
      const isCreateNewTarget = !highRiskWrite && cmd && /copy-item|new-item/i.test(cmd) && targetPath && !existsSync(targetPath);
      if (!isCreateNewTarget) {
        const backup = findBackupForPath(state, session.id, targetPath);
        if (!backup) {
          const existing = session.backups.map((b) => `${b.targetPath} -> ${b.backupPath}`).join("；") || "无";
          const highRiskNote = isHighRiskEntryFile(targetPath) ? "（该文件不在自动备份范围，请先手动备份）" : "";
          return makeHit(cfg, `【硬拦截】目标路径缺少对应备份（规则 13A）${highRiskNote}：已有备份 [${existing}]；本次目标 [${targetPath}]`);
        }
        if (!existsSync(backup.backupPath)) {
          return makeHit(cfg, `【硬拦截】备份记录存在但备份文件不存在（规则 13A）：${backup.backupPath}`);
        }
      }
    }
    return null;
  }

  // 规则 12B：技能调用四步时序（关键词→授权→调用；豁免技能除外）
  // 2026-08-24 修复：旧条件 `handler==='rule12b-skill' || hints.includes('skill')` 会把
  // hints 含 "skill" 的其它规则 cfg（如 12A：hints=["ask","skill","sensitive",...]）截胡——
  // 非 skill 工具时 return null，导致 12A 敏感授权检查静默失效（C-2 实测 Move-Item 放行）。
  // 现在：hints 兜底仅在「name === 'skill'」时进入；handler 明确为 rule12b-skill 时维持原语义。
  if (kindOf(cfg.handler) === "skill-auth") {
    if (name === "skill") {
      const skillName = typeof args?.name === "string" ? args.name : "";
      if ((state.localIntegrations?.manualExempt?.skills || []).includes(skillName)) return null;
      // 技能目录实时联动：已加载目录且该技能不存在/被禁用时，规则不激活
      if (state.skillNames && state.skillNames.size > 0 && !state.skillNames.has(skillName)) return null;
      if (denyMutation) {
        return makeHit(cfg, `【硬拦截】当前用户消息是询问/没有明确执行分点，技能 ${skillName} 未获授权`);
      }
      const op = { type: "skill", pathPrefix: "" };
      const auth = findMatchingAuth([...(session.authorizations || []), ...(state.globalAuthorizations || [])], op);
      if (!auth) {
        const existing = session.authorizations.map(describeAuth).join("；") || "无";
        return makeHit(cfg, `【硬拦截】技能调用缺少匹配授权：${skillName}（已有授权：${existing}；本次范围：${describeOp(op)}）`);
      }
      audit?.({ kind: "allow", rule: cfg.ruleId, name: "授权命中放行", tool: name, reason: `由授权放行（技能 ${skillName}）：${describeAuth(auth)}`, session: sessionIdOf(exec) });
      return null;
    }
    return null;
  }
  if ((cfg.hints || []).includes("skill") && name === "skill") {
    // hints 兜底：理解器未分配 handler 但 hints 含 skill 的 cfg——仅 skill 工具时参与，不截胡其它规则
    const skillName = typeof args?.name === "string" ? args.name : "";
    if ((state.localIntegrations?.manualExempt?.skills || []).includes(skillName)) return null;
    if (state.skillNames && state.skillNames.size > 0 && !state.skillNames.has(skillName)) return null;
    const op = { type: "skill", pathPrefix: "" };
    const auth = findMatchingAuth([...(session.authorizations || []), ...(state.globalAuthorizations || [])], op);
    if (!auth) {
      const existing = session.authorizations.map(describeAuth).join("；") || "无";
      return makeHit(cfg, `【硬拦截】技能调用缺少匹配授权：${skillName}（已有授权：${existing}；本次范围：${describeOp(op)}）`);
    }
    return null;
  }

  // 规则 12A：敏感操作需要匹配授权证据
  if (kindOf(cfg.handler) === "approval") {
    if (isSensitiveToolCall(name, args, sessionIdOf(exec))) {
      // 0.5.11（用户定稿）：12A 与 22-7 判据同源——分析通道/低风险新建豁免在两条分支
      // 使用同一组判据（isAnalysisOp/isLowRiskWorkspaceNew），不再各写一套（此前 22-7 放行、
      // 12A 仍要求授权的不一致）。红线不变：工作区外（isOutsideWorkspace）不豁免。
      if (isAnalysisOp(name, args)) {
        const scratch = extractAnalysisScratchPaths(commandText(args) || "");
        const outside = scratch.filter((p) => isOutsideWorkspace(p, sessionIdOf(exec)));
        if (outside.length === 0) {
          audit?.({ kind: "analysis-scratch", rule: cfg.ruleId, name: "分析通道放行", tool: name, reason: `分析类操作放行（12A 判据同源）：${describeOp(operationOf(name, args))}`, session: sessionIdOf(exec) });
          return null;
        }
      }
      if (isLowRiskWorkspaceNew(name, args)) {
        audit?.({ kind: "allow", rule: cfg.ruleId, name: "低风险新建豁免（12A 判据同源）", tool: name, reason: `工作区内低风险新建（12A 判据同源）：${describeOp(operationOf(name, args))}`, session: sessionIdOf(exec) });
        return null;
      }
      // 规则 19：本机手册正文更新免逐次确认（仅手册本身；路径经配置）
      if (p && (matchManualPath(p, state.localIntegrations?.manualExempt?.paths))) return null;
      // /guard unlock 本身即用户对受保护配置的授权
      if (unlock && isProtectedConfigPath(p)) return null;
      const op = operationOf(name, args);
      // 规则 12A 正文豁免：保护性备份（创建/复制/移动文件到 .backups/ 或 .backups/trash-<时间戳>/）免询问
      if (op.type === "backup") return null;
      if (denyMutation) {
        return makeHit(cfg, `【硬拦截】当前用户消息是询问/没有明确执行分点，未构成授权证据（本次操作：${describeOp(op)}）`);
      }
      const auth = findMatchingAuth([...(session.authorizations || []), ...(state.globalAuthorizations || [])], op);
      if (!auth) {
        const existing = session.authorizations.map(describeAuth).join("；") || "无";
        return makeHit(cfg, `【硬拦截】敏感操作缺少匹配授权：已有授权范围 [${existing}]；本次操作范围 [${describeOp(op)}]`);
      }
      audit?.({ kind: "allow", rule: cfg.ruleId, name: "授权命中放行", tool: name, reason: `由授权放行（12A 敏感操作）：${describeAuth(auth)}`, session: sessionIdOf(exec) });
      return null;
    }
    return null;
  }

  // 规则 21：规则/配置文件变更需 unlock（元规则）
  if (kindOf(cfg.handler) === "meta") {
    if ((name === "edit" || name === "write" || (name === "str_replace_editor" && args?.command !== "view")) && isProtectedConfigPath(p) && !unlock) {
      return makeHit(cfg, "【硬拦截】规则/配置文件受保护：修改需用户先执行 /guard unlock");
    }
    return null;
  }

  // 规则 24：插件装配类型确认（A 硬拦）+ 变更类工具统一覆盖（原规则 25 语义，检查④）
  if (kindOf(cfg.handler) === "assembly") {
    if (name === "dev_install_package") {
      const dir = args?.dir;
      if (dir) {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
          if (!pkg?.dsh?.bundle) {
            return makeHit(cfg, `【硬拦截】插件 ${dir} 未声明 dsh.bundle，不能加入 dsh.profile.bundles（规则 24）`);
          }
        } catch {
          return makeHit(cfg, `【硬拦截】无法读取插件 package.json：${dir}（规则 24）`);
        }
      }
    }
    // 手工编辑 profile package.json 的 dsh.profile.bundles 时同样做类型检查
    const badBundles = nonBundleInProfileBundles(name, args);
    if (badBundles && badBundles.length) {
      return makeHit(cfg, `【硬拦截】${p} 的 dsh.profile.bundles 包含非 bundle/无法确认类型：${badBundles.join("；")}（规则 24）`);
    }
    // 规则 24④：所有能产生文件写入/删除/移动效果的工具都必须纳入统一守卫——
    // 0.5.9 单真源：已分类（tool-catalog 唯一表）= 已纳入守卫，放行；未分类且疑似变更 = 运行时拒绝
    // （防"改个新工具就绕过守卫"；与工具覆盖门禁 K-01/K-06 互补）
    if (isReadOnlyTool(name, args)) return null;
    const cls24 = toolClass(name, args);
    if (cls24 !== "unknown") return null;
    if (looksLikeFileMutation(name, args)) {
      return makeHit(cfg, `【硬拦截】未覆盖的变更类工具 ${name}，违反规则 24④：请先纳入统一守卫覆盖`);
    }
    return null;
  }

  // 规则 27：装配变更后必须先通过全量审计，才能继续装配（C 时序；全局变更 + 本会话审计证据）
  if (kindOf(cfg.handler) === "mount-audit") {
    if (isAssemblyMutationTool(name, args)) {
      const currentSig = computeMountSignature(profileNameFromArgs(args));
      state.mountSignature = currentSig;
      const auditedSig = session.mountAuditSignature || "";
      const needsAudit = auditedSig
        ? currentSig !== auditedSig
        : (state.mountRevision > (session.mountAuditRevision || 0));
      if (needsAudit) {
        // C1 修复（2026-09-10）：**收敛豁免**——允许"使装配趋于自洽"的变更，解除不一致态的死循环。
        //   背景（独立 DSH_HOME 试点）：改 dependencies → 通过；改 bundles 补齐 → 被拦；
        //   试图回滚 dependencies → **同样被拦** → 审计失败项（bundles-missing）恰恰只能靠被拦的动作修复
        //   → 无法收敛（试点靠用户手工写文件才解开）。
        //   ① 回滚豁免：变更后签名回到"审计通过时的签名"
        //   ② 修复豁免：变更前声明不自洽（bundles 有解析不到的项）而变更后自洽
        if (auditedSig && currentSig === auditedSig) return null; // ① 回到已审计状态
        if (isConvergingBundleFix(name, args)) return null;        // ② 修复审计点名的缺失/非法项
        const why = auditedSig
          ? `装配内容已变化（装配状态哈希 ${currentSig.slice(0, 8)} ≠ 审计通过时 ${auditedSig.slice(0, 8)}）`
          : `插件装配已变更（mountRevision=${state.mountRevision}）且本会话未通过全量审计`;
        return makeHit(cfg, `[BLOCKED] ${why} — ${getMessage("pitfall.mount-audit")}`);
      }
    }
    return null;
  }

  // 兜底：从理解产物里的 hints 泛化匹配
  const hints = cfg.hints || [];
  if (hints.includes("inline-command") && (name === "pwsh" || name === "bash") && cmd && INLINE_CMD.test(cmd)) {
    return makeHit(cfg, `【硬拦截】${cfg.title}`);
  }
  if (hints.includes("bom-write") && (name === "pwsh" || name === "bash") && cmd && BOM_WRITE.test(cmd)) {
    return makeHit(cfg, `【硬拦截】${cfg.title}`);
  }
  if (hints.includes("manual") && session.turn.toolCount === 0 && !session.manualReadSeen && !isManualReadTool(name, args, state.localIntegrations?.manualExempt?.paths || [])) {
    return makeHit(cfg, `【硬拦截】${cfg.title}`);
  }
  if (hints.includes("sensitive") && isSensitiveToolCall(name, args, sessionIdOf(exec))) {
    if (p && (matchManualPath(p, state.localIntegrations?.manualExempt?.paths))) return null;
    if (unlock && isProtectedConfigPath(p)) return null;
    const op = operationOf(name, args);
    if (denyMutation) {
      return makeHit(cfg, `【硬拦截】当前用户消息是询问/没有明确执行分点（本次操作：${describeOp(op)}）`);
    }
    const auth = findMatchingAuth([...(session.authorizations || []), ...(state.globalAuthorizations || [])], op);
    if (!auth) {
      const existing = session.authorizations.map(describeAuth).join("；") || "无";
      return makeHit(cfg, `【硬拦截】${cfg.title}：缺少匹配授权（已有：${existing}；本次：${describeOp(op)}）`);
    }
    audit?.({ kind: "allow", rule: cfg.ruleId, name: "授权命中放行", tool: name, reason: `由授权放行（${cfg.title}）：${describeAuth(auth)}`, session: sessionIdOf(exec) });
  }
  return null;
}

/** 供测试/调试：手动更新备份状态（并创建真实备份文件以满足存在性校验） */
export function markBackupSeen(state, sessionId, targetPath) {
  const s = getSessionState(state, sessionId);
  s.turn.backupSeen = true;
  if (targetPath) {
    const dir = mkdtempSync(join(tmpdir(), "dsh-rule-engine-bak-"));
    const backupPath = join(dir, "backup.bak");
    writeFileSync(backupPath, "backup", "utf8");
    const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();
    s.backups.push({
      targetPath: norm(targetPath),
      backupPath,
      at: Date.now()
    });
  }
}

export function markAskSeen(state, sessionId) {
  const s = getSessionState(state, sessionId);
  s.turn.askSeen = true;
  s.authorizations.push({ at: Date.now(), type: "any", pathPrefix: "", source: "test" });
}

export function markManualRead(state, sessionId) {
  getSessionState(state, sessionId).manualReadSeen = true;
}

export { isBackupTool, isManualReadTool };
