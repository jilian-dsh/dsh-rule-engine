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
  pathTarget
} from "./patterns.js";
import { describeAuth, describeOp, findMatchingAuth, operationOf, askQuestionText, inferPathPrefixFromText, inferTypeFromText } from "./authorization.js";
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
  "12D": "先 ask_user_question 获取匹配授权",
  "13A": "先对目标路径执行备份（复制到 .bak/.backups/trash-）",
  "18": "先读取 ~/.dsh/skills/dsh-usage-manual/SKILL.md",
  "21": "按规则 21 分级确认后再落盘",
  "24": "确认插件 dsh.bundle 类型或改用正确挂载",
  "25": "将该工具纳入统一守卫覆盖",
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

const COVERED_MUTATION_TOOLS = new Set([
  "edit", "write", "str_replace_editor", "pwsh", "bash",
  "dev_stage_add", "dev_stage_call", "dev_stage_promote", "dev_stage_demote"
]);
const SAFE_UNCOVERED_TOOLS = new Set([
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
export function guardDecision(state, exec, now = Date.now()) {
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

  // E3：已有匹配授权时，拦截重复 ask_user_question，避免 AI 反复询问已授权事项
  if (name === "ask_user_question") {
    const qText = askQuestionText(args?.questions);
    if (qText) {
      const op = { type: inferTypeFromText(qText), pathPrefix: inferPathPrefixFromText(qText) };
      const auth = findMatchingAuth([...(session.authorizations || []), ...(state.globalAuthorizations || [])], op);
      if (auth) {
        return makeHit(
          { ruleId: "__already-authorized", title: "已有授权，无需重复询问", action: "deny" },
          `【提示】本次询问范围 ${describeOp(op)} 已有匹配授权：${describeAuth(auth)}。无需重复 ask，请继续执行。`
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
    // 低置信规则不硬拦（保守不误拦，交给 /guard rules 人工复核）
    if (cfg.confidence === "low") continue;
    // 分级执行：只有 A 硬拦 / C 时序 / M 元规则才进入工具守卫
    const actions = cfg.actions || [];
    if (!actions.some((a) => a === "deny" || a === "ask" || a === "meta")) continue;
    const hit = matchRule(cfg, { name, args, p, cmd, session, unlock, state, now });
    if (hit) return hit;
  }
  return null;
}

function matchRule(cfg, ctx) {
  const { name, args, p, cmd, session, unlock, state, now } = ctx;
  const id = String(cfg.ruleId);

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
      return makeHit(cfg, "【硬拦截】任务涉及 DSH，首次工具调用前需先 grep/read 手册（~/.dsh/skills/dsh-usage-manual/SKILL.md）");
    }
    return null;
  }

  // 规则 13A：删除/覆盖/高风险写前需有“目标路径对应备份”证据
  if (cfg.handler === "rule13a-backup") {
    const destructive = (name === "pwsh" || name === "bash") && cmd && (DESTRUCTIVE_CMD.test(cmd) || (isSensitiveToolCall(name, args) && !/git\s+(push|commit)/i.test(cmd)));
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
      if (findMatchingAuth([...(session.authorizations || []), ...(state.globalAuthorizations || [])], op) && !isHighRiskEntryFile(targetPath)) return null;
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
  if (cfg.handler === "rule12b-skill" || (cfg.hints || []).includes("skill")) {
    if (name === "skill") {
      const skillName = typeof args?.name === "string" ? args.name : "";
      if (SKILL_EXEMPT.has(skillName)) return null;
      // 技能目录实时联动：已加载目录且该技能不存在/被禁用时，规则不激活
      if (state.skillNames && state.skillNames.size > 0 && !state.skillNames.has(skillName)) return null;
      if (session.turn.questionOnly) {
        return makeHit(cfg, `【硬拦截】当前用户消息是询问而非授权，技能 ${skillName} 未获授权`);
      }
      const op = { type: "skill", pathPrefix: "" };
      const auth = findMatchingAuth([...(session.authorizations || []), ...(state.globalAuthorizations || [])], op);
      if (!auth) {
        const existing = session.authorizations.map(describeAuth).join("；") || "无";
        return makeHit(cfg, `【硬拦截】技能调用缺少匹配授权：${skillName}（已有授权：${existing}；本次范围：${describeOp(op)}）`);
      }
    }
    return null;
  }

  // 规则 12A/12D：敏感操作需要匹配授权证据
  if (cfg.handler === "rule12a-approval" || cfg.handler === "rule12d-sensitive") {
    if (isSensitiveToolCall(name, args)) {
      // 规则 19：dsh-usage-manual/SKILL.md 正文更新免逐次确认（仅手册本身）
      if (p && MANUAL_PATH_RE.test(p)) return null;
      // /guard unlock 本身即用户对受保护配置的授权
      if (unlock && isProtectedConfigPath(p)) return null;
      const op = operationOf(name, args);
      if (session.turn.questionOnly) {
        return makeHit(cfg, `【硬拦截】当前用户消息是询问而非授权，未构成授权证据（本次操作：${describeOp(op)}）`);
      }
      const auth = findMatchingAuth([...(session.authorizations || []), ...(state.globalAuthorizations || [])], op);
      if (!auth) {
        const existing = session.authorizations.map(describeAuth).join("；") || "无";
        return makeHit(cfg, `【硬拦截】敏感操作缺少匹配授权：已有授权范围 [${existing}]；本次操作范围 [${describeOp(op)}]`);
      }
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

  // 规则 24：插件装配类型确认（A 硬拦）
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
    return null;
  }

  // 规则 25：插件变更类工具统一守卫覆盖（A 硬拦；未覆盖的变更工具拒绝）
  if (cfg.handler === "rule25-tool-coverage") {
    if (isReadOnlyTool(name, args)) return null;
    if (COVERED_MUTATION_TOOLS.has(name)) return null;
    if (SAFE_UNCOVERED_TOOLS.has(name)) return null;
    if (looksLikeFileMutation(name, args)) {
      return makeHit(cfg, `【硬拦截】未覆盖的变更类工具 ${name}，违反规则 25：请先纳入统一守卫覆盖`);
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
  if (hints.includes("sensitive") && isSensitiveToolCall(name, args)) {
    if (p && MANUAL_PATH_RE.test(p)) return null;
    if (unlock && isProtectedConfigPath(p)) return null;
    const op = operationOf(name, args);
    if (session.turn.questionOnly) {
      return makeHit(cfg, `【硬拦截】当前用户消息是询问而非授权（本次操作：${describeOp(op)}）`);
    }
    const auth = findMatchingAuth([...(session.authorizations || []), ...(state.globalAuthorizations || [])], op);
    if (!auth) {
      const existing = session.authorizations.map(describeAuth).join("；") || "无";
      return makeHit(cfg, `【硬拦截】${cfg.title}：缺少匹配授权（已有：${existing}；本次：${describeOp(op)}）`);
    }
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
