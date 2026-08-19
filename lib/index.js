// dsh-rule-engine —— DSH 规则执行引擎 v3（host 插件，纯 Node）
// 容器：解析 AGENTS.md → 理解器 → 匹配机 → 执行框架。
// 执行框架：ctx.tools.guard() 硬拦 + session/event 文本纠察 + 审计台账 + /guard 命令。
import { readFileSync, watch, writeFileSync } from "node:fs";
import { audit, readAuditLog } from "./core/audit.js";
import { loadPluginConfig } from "./core/config.js";
import { guardDecision } from "./core/guard-core.js";
import {
  activateForAssistant,
  activateForToolCall,
  activateForUserMessage
} from "./core/matcher.js";
import {
  auditOutputFailed,
  auditOutputPassed,
  backupPathsFromTool,
  isAssemblyMutationTool,
  isAuditCommand,
  isBackupCommand,
  isBackupTool,
  isGetDateCommand,
  isManualReadTool,
  setWorkspaceRoot
} from "./core/patterns.js";
import {
  askQuestionText,
  askResultApproved,
  inferPathPrefixFromText,
  inferTypeFromText,
  isAuthMessage,
  isDirectiveMessage,
  isQuestionMessage
} from "./core/authorization.js";
import {
  getSessionState,
  maybeReloadIfChanged,
  recordAuthorization,
  recordBackup,
  reloadRules,
  resetTurn
} from "./core/state.js";
import { state } from "./core/runtime.js";
import { detectViolations, extractAssistantText } from "./core/text-detect.js";
import { writeUnderstanding } from "./core/understanding-store.js";
import { agentsFilePath, auditFilePath } from "./core/paths.js";
import { isVersionedFile, validateEditedFile } from "./core/version-guard.js";
import { computeMountSignature, profileNameFromArgs } from "./core/mount-signature.js";
import { detectSilentError, extractToolOutput } from "./core/silent-error.js";
import { enrichRulesWithLlm } from "./core/llm-understander.js";

export const name = "dsh-rule-engine";
export const inject = ["tools", "commands", "agents", "workspaceRegistry", "skills", "llm"];

const pluginConfig = loadPluginConfig();
state.enabled = pluginConfig.enabled;
// reloadRules 内部已统一刷新理解产物（P0-3），此处不再重复写
reloadRules(state);

// ── 工具函数 ────────────────────────────────────────────────────────────────

function summarizeArgs(args) {
  try {
    const s = JSON.stringify(args ?? {});
    return s.length > 300 ? s.slice(0, 300) + "..." : s;
  } catch {
    return String(args);
  }
}

function remainMs(until) {
  return Math.max(0, until - Date.now());
}

function fmtRemain(ms) {
  if (ms <= 0) return "无";
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return min > 0 ? `${min} 分 ${sec} 秒` : `${sec} 秒`;
}

function parseArgs(raw) {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }
  return raw || {};
}

function extractUserText(message) {
  if (!message) return "";
  if (typeof message === "string") return message;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && b.type === "text" ? b.text : ""))
      .join("\n");
  }
  return "";
}

// ── session/event 处理 ──────────────────────────────────────────────────────

function maybeInject(ctx, sessionId, violation) {
  if (!pluginConfig.correctInject) return;
  const key = `${sessionId}:${violation.ruleId}`;
  const count = state.injectCounts.get(key) || 0;
  if (count >= pluginConfig.injectLimitPerRulePerSession) return;
  state.injectCounts.set(key, count + 1);
  try {
    const agent = ctx.agents.get(sessionId);
    if (agent && typeof agent.inject === "function") {
      agent.inject({
        content: [
          {
            type: "text",
            text: `[规则引擎] ${violation.reason}（规则 ${violation.ruleId}，已记入 /guard log；下次回复请自证/纠正）`
          }
        ],
        source: { kind: "plugin", plugin: name }
      });
    }
  } catch {
    // 注入失败不影响审计
  }
}

async function refreshSkills(ctx) {
  try {
    const list = await ctx.skills.list();
    state.skillNames = new Set((list || []).map((s) => s && s.name).filter(Boolean));
  } catch {
    // 技能目录不可用时保留旧缓存，不阻断
  }
}

function handleSessionEvent(ctx, session, event) {
  maybeReloadIfChanged(state);
  const sid = session?.id || "global";
  const s = getSessionState(state, sid);
  const d = event.data || {};
  if (event.type === "turn/start") {
    resetTurn(state, sid, d.turn);
    return;
  }
  if (event.type === "user/message") {
    const text = extractUserText(d.message);
    s.lastUserText = text;
    s.turn.userText = text;
    s.turn.questionOnly = isQuestionMessage(text);
    if (isAuthMessage(text) || isDirectiveMessage(text)) {
      recordAuthorization(state, sid, {
        type: inferTypeFromText(text),
        pathPrefix: inferPathPrefixFromText(text),
        source: "user-message"
      });
      audit({ kind: "auth", rule: "12D", name: "用户消息授权", event: "user/message", reason: `记录用户消息授权：${text.slice(0, 120)}`, session: sid });
    }
    const active = activateForUserMessage(state.configs, text);
    if (active.length) state.lastActive = active.map((c) => ({ ruleId: c.ruleId, title: c.title, reason: "用户消息命中触发词" }));
    return;
  }
  if (event.type === "tool/call") {
    const toolName = String(d.name || "");
    const args = parseArgs(d.arguments);
    s.turn.toolCount++;
    if (s.turn.toolCount === 1) s.turn.firstToolName = toolName;
    if (toolName === "ask_user_question") {
      s.turn.askSeen = true;
      s.turn.pendingAsk = { callId: d.callId, questions: args?.questions || [] };
    }
    const pendingCall = { name: toolName, args };
    const targetPath = args?.file_path ?? args?.path;
    if ((toolName === "edit" || toolName === "write" || (toolName === "str_replace_editor" && args?.command !== "view")) && targetPath && isVersionedFile(targetPath)) {
      try {
        pendingCall.originalContent = readFileSync(targetPath, "utf8");
      } catch {
        pendingCall.originalContent = null;
      }
    }
    s.turn.pendingToolCalls.set(d.callId, pendingCall);
    if (toolName === "pwsh" || toolName === "bash") {
      const cmd = args?.command || args?.code || "";
      if (isGetDateCommand(cmd)) s.turn.getDateSeen = true;
      const bp = backupPathsFromTool(toolName, args);
      if (bp) {
        if (!pendingCall.backupPaths) pendingCall.backupPaths = [];
        pendingCall.backupPaths.push(bp);
      }
    }
    if (toolName !== "pwsh" && toolName !== "bash") {
      const bpTool = backupPathsFromTool(toolName, args);
      if (bpTool) {
        if (!pendingCall.backupPaths) pendingCall.backupPaths = [];
        pendingCall.backupPaths.push(bpTool);
      }
    }
    if (isManualReadTool(toolName, args)) s.manualReadSeen = true;
    if (toolName === "skill" && args?.name) s.turn.skillNames.push(args.name);
    s.turn.toolNames.push(toolName);
    const active = activateForToolCall(state.configs, toolName, args);
    if (active.length) state.lastActive = active.map((c) => ({ ruleId: c.ruleId, title: c.title, reason: `工具 ${toolName} 命中` }));
    return;
  }
  if (event.type === "tool/result") {
    const resultBlock = Array.isArray(d.message?.content)
      ? d.message.content.find((b) => b && b.type === "tool-result")
      : null;
    const callId = resultBlock?.toolCallId ?? d.callId;
    const isError = Boolean(d.error) || resultBlock?.isError === true;
    const pendingCall = s.turn.pendingToolCalls.get(callId);
    if (pendingCall) {
      const key = `${pendingCall.name}:${JSON.stringify(pendingCall.args || {})}`;
      if (isError) {
        state.retryCounts.set(key, (state.retryCounts.get(key) || 0) + 1);
      } else {
        state.retryCounts.delete(key);
      }
      s.turn.pendingToolCalls.delete(callId);
    }

    // 备份证据只在工具调用成功后才记录；被拦截/失败的调用不产生备份记录
    if (!isError && pendingCall?.backupPaths?.length) {
      for (const bp of pendingCall.backupPaths) {
        recordBackup(state, sid, bp.targetPath, bp.backupPath);
      }
    }

    // 规则 27：装配变更成功后全局 revision +1；审计命令输出通过/失败后更新本会话审计 revision
    if (pendingCall) {
      if (!isError && isAssemblyMutationTool(pendingCall.name, pendingCall.args)) {
        state.mountRevision += 1;
        state.mountSignature = computeMountSignature(profileNameFromArgs(pendingCall.args));
        audit({
          kind: "mount-dirty",
          rule: "27",
          name: "插件装配变更",
          event: "tool/result",
          reason: `装配已变更（mountRevision=${state.mountRevision}，哈希=${state.mountSignature.slice(0, 8)}），继续装配/重启前需先跑全量审计`,
          session: sid,
          tool: pendingCall.name,
          args: summarizeArgs(pendingCall.args)
        });
      }
      const auditCmd = pendingCall.args?.command || pendingCall.args?.code || "";
      if (isAuditCommand(auditCmd)) {
        const output = extractToolOutput(d);
        if (isError || auditOutputFailed(output)) {
          audit({
            kind: "mount-audit-fail",
            rule: "27",
            name: "全量审计未通过",
            event: "tool/result",
            reason: isError ? "审计脚本执行失败" : "审计脚本发现 DUPLICATES FOUND",
            session: sid,
            tool: pendingCall.name
          });
          maybeInject(ctx, sid, { ruleId: "27", reason: "规则 27：全量审计未通过，先移除多余挂载再重跑审计" });
        } else if (auditOutputPassed(output)) {
          s.mountAuditRevision = state.mountRevision;
          s.mountAuditSignature = computeMountSignature(profileNameFromArgs(pendingCall.args));
          audit({
            kind: "mount-audit-pass",
            rule: "27",
            name: "全量审计通过",
            event: "tool/result",
            reason: `audit-mount-consistency 输出 MOUNT CONSISTENT（mountRevision=${state.mountRevision}，装配哈希=${s.mountAuditSignature.slice(0, 8)}）`,
            session: sid,
            tool: pendingCall.name
          });
        }
      }
    }

    // 版本文件写后自检：失败自动回滚 + 审计
    const versionTarget = pendingCall?.args?.file_path ?? pendingCall?.args?.path;
    if (!isError && pendingCall && pendingCall.originalContent != null && versionTarget && isVersionedFile(versionTarget)) {
      try {
        const current = readFileSync(versionTarget, "utf8");
        const check = validateEditedFile(
          pendingCall.originalContent,
          current,
          pendingCall.args.old_string || "",
          pendingCall.args.new_string || ""
        );
        if (!check.ok) {
          writeFileSync(versionTarget, pendingCall.originalContent, "utf8");
          const reason = `edit 工具显示成功，但内容已被 version-guard 回滚：${check.errors.join("；")}`;
          audit({
            kind: "rollback",
            rule: "__version-guard",
            name: "版本文件写后自检",
            event: "tool/result",
            reason,
            session: sid,
            file: versionTarget
          });
          maybeInject(ctx, sid, { ruleId: "__version-guard", reason });
        }
      } catch (error) {
        audit({
          kind: "rollback-error",
          rule: "__version-guard",
          name: "版本文件写后自检",
          event: "tool/result",
          reason: error instanceof Error ? error.message : String(error),
          session: sid
        });
      }
    }

    // 命令输出静默错误检测（不阻断，只审计 + 注入提醒）
    if (!isError && pendingCall && (pendingCall.name === "pwsh" || pendingCall.name === "bash")) {
      const output = extractToolOutput(d);
      const det = detectSilentError(output, s.lastCommandOutput);
      if (det.suspicious) {
        audit({
          kind: "silent-error",
          rule: "__silent-error",
          name: "命令输出静默错误",
          event: "tool/result",
          reason: det.reason,
          session: sid,
          tool: pendingCall.name
        });
        maybeInject(ctx, sid, { ruleId: "__silent-error", reason: det.reason });
      }
      if (output) s.lastCommandOutput = output;
    }

    const pending = s.turn.pendingAsk;
    if (pending) {
      const result = d.result ?? d.value ?? d;
      if (askResultApproved(result)) {
        const qText = askQuestionText(pending.questions);
        const pathPrefix = inferPathPrefixFromText(qText);
        // ask 问题文本措辞不可靠，授权记录为宽泛类型 any + 路径前缀，避免类型错位
        // 无路径的全局 any 授权缩短 TTL，降低安全边界风险
        const authRecord = {
          type: "any",
          pathPrefix,
          source: "ask"
        };
        const sessionWide = /本会话|剩余|全部|会话内/i.test(qText);
        if (sessionWide) authRecord.expiresAt = Date.now() + 12 * 60 * 60 * 1000;
        else if (!pathPrefix) authRecord.expiresAt = Date.now() + 2 * 60 * 1000;
        recordAuthorization(state, sid, authRecord);
        audit({
          kind: "auth",
          rule: "12D",
          name: "ask_user_question 授权",
          event: "tool/result",
          reason: `记录授权范围：${qText.slice(0, 120)}`,
          session: sid
        });
      } else {
        audit({
          kind: "auth-reject",
          rule: "12D",
          name: "ask_user_question 未授权",
          event: "tool/result",
          reason: "用户未批准该授权请求",
          session: sid
        });
      }
      s.turn.pendingAsk = null;
    }
    return;
  }
  if (event.type === "assistant/chunk") {
    const chunk = d.chunk;
    if (chunk && chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
      s.turn.reasoningText += chunk.text;
    }
    return;
  }
  if (event.type === "assistant/message") {
    const text = extractAssistantText(d.message);
    const violations = detectViolations({ configs: state.configs, session: s, text, reasoningText: s.turn.reasoningText, mountRevision: state.mountRevision });
    for (const v of violations) {
      audit({
        kind: v.kind,
        rule: v.ruleId,
        name: v.title,
        event: "assistant/message",
        reason: v.reason,
        session: sid
      });
      maybeInject(ctx, sid, v);
    }
    if (violations.length) {
      state.lastActive = violations.map((v) => ({ ruleId: v.ruleId, title: v.title, reason: v.reason }));
    } else {
      const active = activateForAssistant(state.configs, text);
      if (active.length) state.lastActive = active.map((c) => ({ ruleId: c.ruleId, title: c.title, reason: "assistant 文本进入 B/D 检测" }));
    }
    return;
  }
}

// ── /guard 命令 ─────────────────────────────────────────────────────────────

const USAGE = [
  "用法：",
  "  /guard status          引擎状态",
  "  /guard rules           规则清单 + 理解产物",
  "  /guard active          最近激活的规则",
  "  /guard log [N]         最近 N 条审计（默认 10）",
  "  /guard unlock [N]      解锁配置写保护 N 分钟（默认 10，仅用户）",
  "  /guard bypass [N]      临时整体放行 N 分钟（默认 5，仅用户）",
  "  /guard lock            立即恢复全部守卫（取消解锁/放行）",
  "  /guard revoke          撤销全部授权记录",
  "  /guard reload          强制重解析 AGENTS.md",
  "",
  "说明：",
  "  - 守卫 = 硬拦截：违反规则的工具调用直接拒绝，模型无法自行绕过；",
  "  - 解锁/放行只能由你（用户）在对话框输入命令执行，助手无法代替；",
  "  - 每次拦截/纠察都会记录到 " + auditFilePath() + "（/guard log 可查）。"
].join("\n");

function parseCommand(rawInput) {
  const text = (rawInput || "").trim();
  if (!text || /^(status|state)$/i.test(text)) return { kind: "status" };
  if (/^(rules|list|ls)$/i.test(text)) return { kind: "rules" };
  if (/^(active)$/i.test(text)) return { kind: "active" };
  if (/^(help|\?)$/i.test(text)) return { kind: "help" };
  let m = text.match(/^unlock\s*(\d+)?$/i);
  if (m) return { kind: "unlock", minutes: m[1] ? Number(m[1]) : 10 };
  m = text.match(/^bypass\s*(\d+)?$/i);
  if (m) return { kind: "bypass", minutes: m[1] ? Number(m[1]) : 5 };
  if (/^lock$/i.test(text)) return { kind: "lock" };
  if (/^revoke$/i.test(text)) return { kind: "revoke" };
  m = text.match(/^log\s*(\d+)?$/i);
  if (m) return { kind: "log", n: m[1] ? Number(m[1]) : 10 };
  if (/^reload$/i.test(text)) return { kind: "reload" };
  return { kind: "invalid" };
}

async function executeGuard(ctx, invocation) {
  const command = parseCommand(invocation.rawInput);
  switch (command.kind) {
    case "help":
      return { kind: "success", text: USAGE };
    case "status": {
      const conf = loadPluginConfig();
      state.enabled = conf.enabled;
      const high = state.configs.filter((c) => c.confidence === "high").length;
      const medium = state.configs.filter((c) => c.confidence === "medium").length;
      const low = state.configs.filter((c) => c.confidence === "low").length;
      const parts = [
        "【规则引擎状态】",
        `  总开关：${state.enabled ? "开启" : "已关闭"}`,
        `  规则容器：${state.configOk ? `正常（${state.configs.length} 条规则）` : "⚠ " + state.configError}`,
        `  理解置信度：high ${high} / medium ${medium} / low ${low}`,
        `  配置加载：${conf.ok ? "正常" : "⚠ " + conf.error}`,
        `  解锁剩余：${fmtRemain(remainMs(state.unlockUntil))}（配置写保护豁免）`,
        `  放行剩余：${fmtRemain(remainMs(state.bypassUntil))}（全部守卫暂停）`,
        `  授权存储：内存态（重启失效）`,
        `  审计日志：${auditFilePath()}`,
        `  最近激活：${state.lastActive.length ? state.lastActive.map((a) => a.ruleId).join("、") : "无"}`,
        `  提示：审批策略 never 只关系统审批弹窗，不影响对话内 ask_user_question 授权；规则 12A 仍会硬拦需要授权的操作。`
      ];
      return { kind: "success", text: parts.join("\n") };
    }
    case "rules": {
      if (state.configs.length === 0) return { kind: "success", text: "当前没有可执行规则（AGENTS.md 为空或缺失）。" };
      const parts = [`共 ${state.configs.length} 条规则：`, ""];
      for (const c of state.configs) {
        const flag = c.disabled ? "（已禁用）" : "";
        const actions = (c.actions || []).join("/");
        parts.push(`  [${c.ruleId}] ${c.title} ${flag}`);
        parts.push(`      等级 ${c.level || "?"}｜动作 ${actions}｜置信 ${c.confidence}｜handler ${c.handler || "generic"}`);
      }
      return { kind: "success", text: parts.join("\n") };
    }
    case "active": {
      if (state.lastActive.length === 0) return { kind: "success", text: "暂无激活规则。" };
      const parts = ["最近激活规则：", ""];
      for (const a of state.lastActive) {
        parts.push(`  [${a.ruleId}] ${a.title}`);
        if (a.reason) parts.push(`      原因：${a.reason}`);
      }
      return { kind: "success", text: parts.join("\n") };
    }
    case "unlock": {
      const minutes = Math.min(Math.max(1, command.minutes), 60);
      state.unlockUntil = Date.now() + minutes * 60000;
      return {
        kind: "success",
        text: `已解锁「配置写保护」${minutes} 分钟。现在可以让助手修改 rule-engine.json / rule-understanding.json / AGENTS.md；改完请执行 /guard lock 或等待自动恢复。`
      };
    }
    case "bypass": {
      const minutes = Math.min(Math.max(1, command.minutes), 60);
      state.bypassUntil = Date.now() + minutes * 60000;
      return {
        kind: "success",
        text: `已临时放行全部守卫 ${minutes} 分钟。到期自动恢复，也可 /guard reload 后立即恢复。`
      };
    }
    case "lock": {
      state.unlockUntil = 0;
      state.bypassUntil = 0;
      return { kind: "success", text: "守卫已全部恢复：解锁与放行均已取消。" };
    }
    case "revoke": {
      let count = 0;
      for (const s of state.sessions.values()) {
        count += s.authorizations.length;
        s.authorizations = [];
      }
      return { kind: "success", text: `已撤销全部授权记录（共 ${count} 条）。` };
    }
    case "log": {
      const n = Math.min(Math.max(1, command.n), 200);
      const entries = readAuditLog(n);
      if (entries.length === 0) return { kind: "success", text: "暂无审计记录。" };
      const parts = [`最近 ${entries.length} 条审计：`, ""];
      for (const e of entries) {
        if (e.raw) {
          parts.push(`  ${e.raw}`);
          continue;
        }
        const t = (e.ts || "").replace("T", " ").slice(0, 19);
        parts.push(`  [${t}] ${e.kind || "?"}｜规则 ${e.rule || "?"}｜${e.name || ""}`);
        if (e.reason) parts.push(`      原因：${e.reason}`);
        if (e.tool) parts.push(`      工具：${e.tool}｜参数：${e.args || ""}`);
      }
      return { kind: "success", text: parts.join("\n") };
    }
    case "reload": {
      reloadRules(state);
      const saved = writeUnderstanding(state.configs);
      return {
        kind: "success",
        text: `已重解析 AGENTS.md：${state.configOk ? `正常（${state.configs.length} 条规则）` : "⚠ " + state.configError}` +
          (saved.ok ? `\n理解产物已写入：${saved.path}` : `\n理解产物写入失败：${saved.error}`)
      };
    }
    default:
      return { kind: "error", text: USAGE };
  }
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

export function apply(ctx) {
  // 0. 从 workspaceRegistry 获取真实工作区根目录，避免 process.cwd() 误判
  try {
    const ws = ctx.workspaceRegistry?.list?.()?.[0]?.path;
    setWorkspaceRoot(ws || process.env.DSH_WORKSPACE || "");
  } catch {
    setWorkspaceRoot(process.env.DSH_WORKSPACE || "");
  }

  // 0.1 技能目录实时联动
  refreshSkills(ctx);
  ctx.on("skills/change", () => {
    refreshSkills(ctx);
  });

  // 0.2 LLM 增量理解（非 high 置信规则，失败自动回退模式库）
  enrichRulesWithLlm(ctx, state);

  // 0.3 AGENTS.md 文件监听（fs.watch 即时触发，stat 轮询保留为兜底）
  ctx.effect(
    function* () {
      let timer = null;
      let watcher = null;
      try {
        watcher = watch(agentsFilePath(), { persistent: false }, () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            reloadRules(state);
            // 规则变化后补一次 LLM 增量理解（有 ruleId@mtime 去重，不会重复烧 token；P1-6）
            void enrichRulesWithLlm(ctx, state);
          }, 200);
        });
      } catch {
        // 文件暂不可监听时由 stat 轮询兜底
      }
      yield () => {
        if (timer) clearTimeout(timer);
        if (watcher) watcher.close();
      };
    },
    "dsh-rule-engine watch"
  );

  // 1. 单调守卫：工具调用先裁决，命中即物理拒绝
  ctx.effect(
    function* () {
      yield ctx.tools.guard((exec) => {
        const hit = guardDecision(state, exec, Date.now());
        if (hit) {
          audit({
            kind: "deny",
            rule: hit.ruleId,
            name: hit.title,
            event: "tool/guard",
            tool: exec?.name,
            args: summarizeArgs(exec?.arguments),
            reason: hit.reason
          });
          state.lastActive = [{ ruleId: hit.ruleId, title: hit.title, reason: hit.reason }];
          return hit.reason;
        }
        return undefined;
      });
    },
    "dsh-rule-engine guard"
  );

  // 2. session/event 监听：文本纠察 + 时序状态
  ctx.on("session/event", (session, event) => {
    try {
      handleSessionEvent(ctx, session, event);
    } catch (error) {
      ctx.logger?.warn?.("[dsh-rule-engine] session/event handler error", error);
    }
  });

  // 3. /guard 命令（仅用户可执行；模型无命令工具）
  ctx.effect(
    function* () {
      yield ctx.commands.register({
        name: "guard",
        description: "规则执行引擎：查看状态/规则/激活/审计，解锁配置修改，临时放行，强制重载",
        input: { hint: "[status|rules|active|log <N>|unlock <分钟>|bypass <分钟>|reload]" },
        handler: async (invocation) => {
          try {
            return await executeGuard(ctx, invocation);
          } catch (error) {
            return {
              kind: "error",
              text: `执行出错：${error instanceof Error ? error.message : String(error)}`
            };
          }
        }
      });
    },
    "dsh-rule-engine commands"
  );

  ctx.logger?.info?.("[dsh-rule-engine] 已加载，AGENTS.md 规则数：" + state.configs.length);
}
