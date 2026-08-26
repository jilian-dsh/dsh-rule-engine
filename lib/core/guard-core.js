// guard-core.js - 工具守卫裁决（纯函数，可独立测试）。
// 被 index.js 的 ctx.tools.guard() 调用；返回 reason 即物理拒绝。
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  BOM_WRITE,
  DESTRUCTIVE_CMD,
  DSH_KEYWORDS_RE,
  INLINE_CMD,
  MANUAL_PATH_RE,
  PROTECTED_FILENAME_RE,
  SKILL_EXEMPT,
  commandText,
  isAssemblyMutationTool,
  isBackupTool,
  isHighRiskEntryFile,
  isManualReadTool,
  isProtectedConfigPath,
  isReadOnlyTool,
  isSensitiveToolCall,
  isVariablePath,
  isVerificationCommand,
  isLowRiskWorkspaceNew,
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
import { classifyAction } from "./overengineering.js";

function sessionIdOf(exec) {
  const agent = exec?.agent;
  if (!agent) return "global";
  if (typeof agent.session === "object" && agent.session?.id) return agent.session.id;
  if (typeof agent.session === "string") return agent.session;
  return "global";
}

const RULE_HINTS = {
  "1": "先分析根因，确认问题后再继续",
  "9": "改用脚本文件或显式 UTF-8 BOM 流程",
  "12A": "先 ask_user_question 获取匹配授权",
  "13A": "先对目标路径执行备份（复制到 .bak/.backups/trash-）",
  "18": "先读取 ~/.dsh/skills/example-usage-manual/SKILL.md",
  "21": "按规则 21 分级确认后再落盘",
  "22": "先回答/展示方案，或补充明确执行分点（工具类别+路径范围）；已授权变更必须落在本回合执行分点/ask 授权范围内",
  "24": "确认插件 dsh.bundle 类型或改用正确挂载",
  "27": "先运行 node scripts/audit-mount-consistency.mjs --profile web"
};

function makeHit(cfg, reason) {
  const errId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const hint = RULE_HINTS[String(cfg.ruleId)] || "见 /guard rules";
  return {
    ruleId: cfg.ruleId,
    title: cfg.title,
    action: "deny",
    reason: `${reason}（规则 ${cfg.ruleId}｜放行：${hint}｜ERR-${errId}）`
  };
}

export const COVERED_MUTATION_TOOLS = new Set([
  "edit", "write", "str_replace_editor", "pwsh", "bash",
  "dev_stage_add", "dev_stage_call", "dev_stage_promote", "dev_stage_demote"
]);
export const SAFE_UNCOVERED_TOOLS = new Set([
  "ask_user_question", "todo_write", "subagent", "workflow", "visualize", "skill",
  "read", "grep", "glob", "read_image", "job_list", "job_output", "list_agents",
  "get_goal", "dev_plugin_status", "dev_reload_package", "dev_injected_list",
  "dev_stage_list", "dev_router_status", "dev_self_test"
]);

function looksLikeFileMutation(name, args) {
  const a = args || {};
  return Boolean(a.file_path || a.path || a.command || a.code || a.execute || a.script || a.fn);
}

export function isProfilePackageJson(p) {
  return typeof p === "string" && /profiles[\\/][^\\/]+[\\/]package\.json$/i.test(p);
}

/** 判定命令是否"整条命令仅调用统一入口 example-manual-write.mjs"（无 ; | & 链式/换行） */
function isEntryChannelCommand(cmd) {
  return typeof cmd === "string" && /^[^\n;|&]*example-manual-write\.mjs[^\n;|&]*$/i.test(cmd);
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

/** 若本次文件变更会写入 profile package.json 的 dsh.profile.bundles，返回其中非 bundle/无法确认的项 */
export function nonBundleInProfileBundles(name, args) {
  const p = pathTarget(args);
  if (!isProfilePackageJson(p)) return null;
  const content = resultingFileContent(name, args);
  if (!content) return null;
  let parsed;
  try { parsed = JSON.parse(content); } catch { return null; }
  const bundles = parsed?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return null;
  const bad = [];
  for (const b of bundles) {
    const pkgPath = resolveBundlePkgPath(b, p) || resolveLocalDependencyPkgPath(b, p, parsed);
    if (!pkgPath) {
      const dep = parsed?.dependencies?.[b] ?? parsed?.devDependencies?.[b] ?? parsed?.optionalDependencies?.[b];
      const depDesc = typeof dep === "string" ? `dependencies 为 ${dep}` : "dependencies 中无此包";
      bad.push(`${b}（找不到 package.json，无法确认类型；${depDesc}。请先用 dev_install_package 或先安装依赖再写 bundles）`);
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
          `【提示】本回合的 ask 已遭拒绝，请勿再次弹窗询问；改用普通文本说明即可（规则 22 沟通直接性）。`
        );
      }
      // 5 分钟内已有被拒的 ask 记录 → 拦（防连环弹窗 → not-pending 诱因链）
      const recentReject = (state.askRejections || []).some((r) => r.sessionId === session.id && now - r.at < 5 * 60 * 1000);
      if (recentReject) {
        return makeHit(
          { ruleId: "__ask-throttle", title: "ask 请求过频", action: "deny" },
          `【提示】5 分钟内已发起过 ask 且遭拒绝，请改用普通文本说明，勿连环弹窗询问。`
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
  // 合法通道 = 整条命令仅调用 example-manual-write.mjs（无 ; | & 链式/换行，防注释文本伪造放行）
  if (!unlock && (name === "pwsh" || name === "bash")) {
    const cmd = commandText(args) || "";
    if (cmd && /(?:set-content|out-file|add-content|write|copy-item|move-item|rename-item|writefilesync|fs\.writefilesync)/i.test(cmd) && PROTECTED_FILENAME_RE.test(cmd)) {
      if (!isEntryChannelCommand(cmd)) {
        return makeHit(
          { ruleId: "__self-protect", title: "受保护文件禁止绕过统一入口直写", action: "deny" },
          `【硬拦截】受保护文件禁止通过 pwsh/bash 绕过统一入口直写；请使用 scripts/example-manual-write.mjs（整个命令只能调用该脚本，不得链式拼接其他写命令；或 /guard unlock 临时放行）。`
        );
      }
    }
  }

  // 写前版本校验（建议③）：版本化文件（SKILL.md/AGENTS.md/CHANGELOG/README 等）在写入前
  // 用 old/new 模拟结果做校验，不合规直接拒绝——避免"先写后回滚"的副作用与假成功
  // 位置在自护之后：受保护文件需先 unlock（用户明确授权）再接受版本校验
  if ((name === "edit" || name === "write" || (name === "str_replace_editor" && args?.command !== "view")) && p && isVersionedFile(p)) {
    try {
      const current = readFileSync(p, "utf8");
      const simulated = resultingFileContent(name, args) ?? current;
      const check = validateEditedFile(current, simulated, args?.old_string ?? args?.old_str ?? "", args?.new_string ?? args?.new_str ?? "");
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
  if (cfg.handler === "rule22-7-direct") {
    // 机制 B（2026-08-24）：工具分类制（纯函数，覆盖现有与未来插件注册的全部工具）——
    // control（SAFE 无条件放行）/ analysis（只读分析放行）/ artifact（产物放行+审计）/
    // unknown（物理不拦，由 pre-execute ask 层首调询问，防新插件绕过）；mutating 维持原有严格逻辑。
    if (SAFE_UNCOVERED_TOOLS.has(name)) return null; // 授权/委托/技能/查询展示类 → 无条件放行
    const cls = toolClass(name, args);
    if (cls === "analysis") return null;
    if (cls === "artifact") {
      audit?.({ kind: "allow", rule: cfg.ruleId, name: "产物类工具放行", tool: name, reason: `分类 artifact（低风险产物写入，留痕可对账）：${describeOp(operationOf(name, args))}`, session: sessionIdOf(exec) });
      return null;
    }
    if (cls === "unknown") return null; // 物理不拦；pre-execute ask 层首调询问
    if (denyMutation) {
      // v0.5.7 后续（用户拍板）：工作区内低风险变更豁免——12A 正文豁免的机器实现
      //（只读诊断脚本被拦的最终修复：此前 --profile 模板/多根/验证伴生已修，本项补齐）
      if (isLowRiskWorkspaceNew(name, args)) {
        audit?.({ kind: "allow", rule: cfg.ruleId, name: "低风险新建豁免", tool: name, reason: `工作区内低风险变更（12A 正文豁免）：${describeOp(operationOf(name, args))}`, session: sessionIdOf(exec) });
        return null;
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
    if (!COVERED_MUTATION_TOOLS.has(name) && !looksLikeFileMutation(name, args)) return null;
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
    // 只使用本回合的 scopes（execute 子句 + 本回合 ask 授权已由 handleSessionEvent 写入 turn.scopes）；
    // 不再把 session.authorizations 里历史 ask 授权拉进来，避免上一轮授权放宽本轮。
    const scopes = Array.isArray(session.turn.scopes) && session.turn.scopes.length > 0
      ? session.turn.scopes
      : scopesFromIntents(turnIntents);
    if (!scopes.some((scope) => authMatches(scope, op))) {
      return makeHit(cfg, `【硬拦截】本次变更操作不在本回合执行分点/授权范围内（规则 22）：已授权范围 [${describeScopes(scopes)}]；本次操作 [${describeOp(op)}]。请补充明确授权（可用 ask_user_question）后再执行`);
    }
    // 可观测性（阶段 0，2026-08-24）：规则 22 粒度放行是最高频放行路径，必须留痕可查
    audit?.({ kind: "allow", rule: cfg.ruleId, name: "授权命中放行", tool: name, reason: `由授权放行（规则 22 粒度命中）：${describeScopes(scopes)} 覆盖 ${describeOp(op)}`, session: sessionIdOf(exec) });
    return null;
  }

  // 规则 1：同工具同参数连续失败 ≥2 次后拦第 3 次（失败计数由 tool/result 更新）
  if (cfg.handler === "rule1-retry") {
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
  if (cfg.handler === "rule9-inline-bom") {
    if ((name === "pwsh" || name === "bash") && cmd) {
      if (INLINE_CMD.test(cmd)) {
        return makeHit(cfg, "【硬拦截】禁止内联命令（node -e / pwsh -c / node -p 等），请先写脚本文件再执行");
      }
      if (BOM_WRITE.test(cmd)) {
        return makeHit(cfg, "【硬拦截】禁止用 Set-Content/Out-File -Encoding utf8BOM 写 .json/.yaml（PS7 显式带 BOM）");
      }
    }
    return null;
  }

  // 规则 18：DSH 任务首次工具调用前必须已读手册
  if (cfg.handler === "rule18-manual-first") {
    const userText = session.turn.userText || session.lastUserText || "";
    const firstTool = session.turn.toolCount === 0;
    if (firstTool && !session.manualReadSeen && DSH_KEYWORDS_RE.test(userText) && !isManualReadTool(name, args)) {
      return makeHit(cfg, "【硬拦截】任务涉及 DSH，首次工具调用前需先 grep/read 手册（~/.dsh/skills/example-usage-manual/SKILL.md）");
    }
    return null;
  }

  // 规则 13A：删除/覆盖/高风险写前需有“目标路径对应备份”证据
  if (cfg.handler === "rule13a-backup") {
    // 统一入口命令豁免：example-manual-write.mjs 每次写入前自身执行备份（backup() 保留 5 份），
    // 引擎静态扫描看不到脚本内部动作（已知盲区）；入口命令也已被 __self-protect 限定为唯一写通道。
    if ((name === "pwsh" || name === "bash") && isEntryChannelCommand(cmd)) return null;
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
  if (cfg.handler === "rule12b-skill") {
    if (name === "skill") {
      const skillName = typeof args?.name === "string" ? args.name : "";
      if (SKILL_EXEMPT.has(skillName)) return null;
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
    if (SKILL_EXEMPT.has(skillName)) return null;
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
  if (cfg.handler === "rule12a-approval") {
    if (isSensitiveToolCall(name, args, sessionIdOf(exec))) {
      // 规则 19：example-usage-manual/SKILL.md 正文更新免逐次确认（仅手册本身）
      if (p && MANUAL_PATH_RE.test(p)) return null;
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
  if (cfg.handler === "rule21-meta") {
    if ((name === "edit" || name === "write" || (name === "str_replace_editor" && args?.command !== "view")) && isProtectedConfigPath(p) && !unlock) {
      return makeHit(cfg, "【硬拦截】规则/配置文件受保护：修改需用户先执行 /guard unlock");
    }
    return null;
  }

  // 规则 24：插件装配类型确认（A 硬拦）+ 变更类工具统一覆盖（原规则 25 语义，检查④）
  if (cfg.handler === "rule24-assembly-type") {
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
    // 未覆盖的变更类工具运行时直接拒绝（防"改个新工具就绕过守卫"）
    if (isReadOnlyTool(name, args)) return null;
    if (COVERED_MUTATION_TOOLS.has(name)) return null;
    if (SAFE_UNCOVERED_TOOLS.has(name)) return null;
    if (looksLikeFileMutation(name, args)) {
      return makeHit(cfg, `【硬拦截】未覆盖的变更类工具 ${name}，违反规则 24④：请先纳入统一守卫覆盖`);
    }
    return null;
  }

  // 规则 27：装配变更后必须先通过全量审计，才能继续装配（C 时序；全局变更 + 本会话审计证据）
  if (cfg.handler === "rule27-mount-audit") {
    if (isAssemblyMutationTool(name, args)) {
      const currentSig = computeMountSignature(profileNameFromArgs(args));
      state.mountSignature = currentSig;
      const auditedSig = session.mountAuditSignature || "";
      const needsAudit = auditedSig
        ? currentSig !== auditedSig
        : (state.mountRevision > (session.mountAuditRevision || 0));
      if (needsAudit) {
        const why = auditedSig
          ? `装配内容已变化（装配状态哈希 ${currentSig.slice(0, 8)} ≠ 审计通过时 ${auditedSig.slice(0, 8)}）`
          : `插件装配已变更（mountRevision=${state.mountRevision}）且本会话未通过全量审计`;
        return makeHit(cfg, `【硬拦截】${why}，请先运行 node scripts/audit-mount-consistency.mjs --profile <p> 并通过后再继续装配`);
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
  if (hints.includes("manual") && session.turn.toolCount === 0 && !session.manualReadSeen && !isManualReadTool(name, args)) {
    return makeHit(cfg, `【硬拦截】${cfg.title}`);
  }
  if (hints.includes("sensitive") && isSensitiveToolCall(name, args, sessionIdOf(exec))) {
    if (p && MANUAL_PATH_RE.test(p)) return null;
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
