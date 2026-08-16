// guard-core.js - 工具守卫裁决（纯函数，可独立测试）。
// 被 index.js 的 ctx.tools.guard() 调用；返回 reason 即物理拒绝。
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BOM_WRITE,
  DESTRUCTIVE_CMD,
  DSH_KEYWORDS_RE,
  INLINE_CMD,
  SKILL_EXEMPT,
  commandText,
  isAssemblyMutationTool,
  isBackupTool,
  isChinesePs1Violation,
  isManualReadTool,
  isProtectedConfigPath,
  isReadOnlyTool,
  isSensitiveToolCall,
  pathTarget
} from "./patterns.js";
import { describeAuth, describeOp, findMatchingAuth, operationOf } from "./authorization.js";
import { findBackupForPath, getSessionState, maybeReloadIfChanged } from "./state.js";

function sessionIdOf(exec) {
  const agent = exec?.agent;
  if (!agent) return "global";
  if (typeof agent.session === "object" && agent.session?.id) return agent.session.id;
  if (typeof agent.session === "string") return agent.session;
  return "global";
}

function makeHit(cfg, reason) {
  return {
    ruleId: cfg.ruleId,
    title: cfg.title,
    action: "deny",
    reason
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
    const pkgPath = resolveBundlePkgPath(b, p);
    if (!pkgPath) { bad.push(`${b}（找不到 package.json，无法确认类型）`); continue; }
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (!pkg?.dsh?.bundle) bad.push(`${b}（未声明 dsh.bundle）`);
    } catch {
      bad.push(`${b}（package.json 读取失败）`);
    }
  }
  return bad.length ? bad : null;
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

  // 内部自护：插件配置/理解产物/规则文件禁止模型直写（/guard unlock 可临时放行）
  if (!unlock && (name === "edit" || name === "write" || (name === "str_replace_editor" && args?.command !== "view")) && isProtectedConfigPath(p)) {
    return makeHit(
      { ruleId: "__self-protect", title: "规则引擎配置只读（需 /guard unlock）", action: "deny" },
      `【硬拦截】${p} 受规则引擎保护：修改需用户先执行 /guard unlock`
    );
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

  // 规则 9：内联命令 / BOM 写配置
  if (cfg.handler === "rule9-inline-bom") {
    if ((name === "pwsh" || name === "bash") && cmd) {
      if (INLINE_CMD.test(cmd)) {
        return makeHit(cfg, "【硬拦截】禁止内联命令（node -e / pwsh -c / node -p 等），请先写脚本文件再执行");
      }
      if (BOM_WRITE.test(cmd)) {
        return makeHit(cfg, "【硬拦截】禁止用 Set-Content/Out-File -Encoding UTF8 写 .json/.yaml（会带 BOM）");
      }
    }
    if (isChinesePs1Violation(name, args)) {
      return makeHit(cfg, "【硬拦截】含中文的 .ps1 必须 UTF-8 带 BOM；当前写入方式可能无 BOM，请改用纯 ASCII 或显式 BOM 流程");
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
    if (highRiskWrite && unlock) return null;
    if (destructive || highRiskWrite) {
      const op = operationOf(name, args);
      // 备份动作本身（复制到 .bak/.backups/trash-）不需要再“先备份”
      if (op.type === "backup") return null;
      const targetPath = highRiskWrite ? p : op.pathPrefix;
      // 复制/新建到“尚不存在”的目标文件：属于创建新文件，不适用 13A 覆盖备份要求
      const isCreateNewTarget = !highRiskWrite && cmd && /copy-item|new-item/i.test(cmd) && targetPath && !existsSync(targetPath);
      if (!isCreateNewTarget) {
        const backup = findBackupForPath(state, session.id, targetPath);
        if (!backup) {
          const existing = session.backups.map((b) => `${b.targetPath} -> ${b.backupPath}`).join("；") || "无";
          return makeHit(cfg, `【硬拦截】目标路径缺少对应备份（规则 13A）：已有备份 [${existing}]；本次目标 [${targetPath}]`);
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
      const auth = findMatchingAuth(session.authorizations, op);
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
      // /guard unlock 本身即用户对受保护配置的授权
      if (unlock && isProtectedConfigPath(p)) return null;
      const op = operationOf(name, args);
      if (session.turn.questionOnly) {
        return makeHit(cfg, `【硬拦截】当前用户消息是询问而非授权，未构成授权证据（本次操作：${describeOp(op)}）`);
      }
      const auth = findMatchingAuth(session.authorizations, op);
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
      if (state.mountRevision > (session.mountAuditRevision || 0)) {
        return makeHit(cfg, `【硬拦截】检测到插件装配已变更但本会话未通过全量审计（规则 27，mountRevision=${state.mountRevision}）：请先运行 node scripts/audit-mount-consistency.mjs --profile <p> 并通过后再继续装配`);
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
    if (unlock && isProtectedConfigPath(p)) return null;
    const op = operationOf(name, args);
    if (session.turn.questionOnly) {
      return makeHit(cfg, `【硬拦截】当前用户消息是询问而非授权（本次操作：${describeOp(op)}）`);
    }
    const auth = findMatchingAuth(session.authorizations, op);
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
