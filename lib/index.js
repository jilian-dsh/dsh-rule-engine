// dsh-rule-engine —— DSH 规则执行引擎 v3（host 插件，纯 Node）
// 容器：解析 AGENTS.md → 理解器 → 匹配机 → 执行框架。
// 执行框架：ctx.tools.guard() 硬拦 + session/event 文本纠察 + 审计台账 + /guard 命令。
import { readFileSync, watch, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { audit, readAuditLog } from "./core/audit.js";
import { loadPluginConfig } from "./core/config.js";
import { guardDecision } from "./core/guard-core.js";
import { computeBaselineGap, loadBaselineFile, BASELINE_COMPLETE_RE } from "./core/baseline.js";
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
  isReadOnlyTool,
  needsApprovalReminder,
  PRIVATE_NETWORK_RE,
  setWorkspaceRoot,
  setWorkspaceRoots,
  setSessionWorkspaceRoot
} from "./core/patterns.js";
import {
  askQuestionCoreText,
  askQuestionText,
  askResultApproved,
  askResultSelectedText,
  inferPathPrefixFromText,
  inferTypeFromText,
  isAuthMessage,
  isDirectiveMessage,
  isQuestionMessage,
  isSessionWideAskText,
  scopesFromIntents
} from "./core/authorization.js";
import { isEngineInjectedMessage, isInjectedContextMessage, isKnownSystemInjection, parseUserIntents, stripInjectedContext } from "./core/intent.js";
import { enrichIntentWithLlm } from "./core/llm-intent.js";
import {
  applyTaskContractConfig,
  clearAuthorizations,
  getSessionState,
  maybeReloadIfChanged,
  recordAuthorization,
  recordBackup,
  reloadRules,
  resetTurn
} from "./core/state.js";
import { SAFE_UNCOVERED_TOOLS } from "./core/guard-core.js";
import { toolClass } from "./core/tool-catalog.js";
import { state } from "./core/runtime.js";
import { detectViolations, extractAssistantText } from "./core/text-detect.js";
import { shouldDetectTurn, shouldDeliver } from "./core/semantic.js";
import { judgeViolation } from "./core/judge.js";
import {
  applyContract,
  contractSummary,
  decideContractAction,
  consumeDelegateBudget,
  defaultContract,
  isArmed,
  isObserving,
  naturalMode,
  parseBudgetCommand,
  parseModeCommand
} from "./core/contract.js";
import {
  classifyAction,
  detectOverengineeringText,
  isRepeatedTaskAction,
  recordAction
} from "./core/overengineering.js";
import { writeUnderstanding } from "./core/understanding-store.js";
import { agentsFilePath, auditFilePath, verifyFilePath, toolsWhitelistFilePath } from "./core/paths.js";
import { isVersionedFile, validateEditedFile } from "./core/version-guard.js";
import { computeMountSignature, profileNameFromArgs } from "./core/mount-signature.js";
import { detectSilentError, extractToolOutput } from "./core/silent-error.js";
import { enrichRulesWithLlm } from "./core/llm-understander.js";
import { analyzeCoverage } from "./core/understander.js";

export const name = "dsh-rule-engine";
export const inject = ["tools", "commands", "agents", "workspaceRegistry", "skills", "llm"];

const pluginConfig = loadPluginConfig();
state.enabled = pluginConfig.enabled;
applyTaskContractConfig(state, pluginConfig);
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

function sessionIdOfExec(exec) {
  const agent = exec?.agent;
  if (!agent) return "global";
  if (typeof agent.session === "object" && agent.session?.id) return agent.session.id;
  if (typeof agent.session === "string") return agent.session;
  return "global";
}

/**
 * 从 user/message 事件提取用户文本。
 * 2026-08-24 根因修复：官方结构（@deepseek-ai/dsh-session/surface）中
 * event.data 就是消息对象本身（deriveEventMessage case 'user/message' 返回 event.data），
 * 并非 data.message——旧代码取 d.message 导致永远提取空文本：
 *   旧行为 → 空文本 parseUserIntents("") 非空对象 → 规则 22 无故全拦；
 *   中间版 → if (!text) return 跳过 → 全放行（漏拦）；
 * 正解 = 取对字段；兼容 data 与 data.message 两种历史形态。
 */
export function extractUserText(message) {
  if (!message) return "";
  if (typeof message === "string") return message;
  const obj = typeof message === "object" && !Array.isArray(message)
    ? (message.content !== undefined ? message : message.message)
    : message;
  const content = obj?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && b.type === "text" ? b.text : ""))
      .join("\n");
  }
  return "";
}

// ── session/event 处理 ──────────────────────────────────────────────────────

// O1 注入通道修复（2026-08-24，批次 6）：
// 根因——maybeInject 在 session/event 观察回调内同步调用 agent.inject，而 inject 底层是
// 同步 session.append("agent/inbox/spliced")；dsh-session 对同一 session 的 append 有
// 同步重入保护（entry.appending → "session append cannot reenter while another append
// is being published"），观察回调正处在 append 发布边界内 → 必然抛错（README 局限 6 记录：
// 注入从未到达模型/界面，仅审计留痕）。
// 修复——投递延迟到当前 append 发布边界之后（宏任务 setTimeout 0），语义不变
// （inject 官方语义本就是 "queue context for the next pre-step, without waking"）；
// 插件卸载/热重载时统一清理 pending 定时器。
const pendingInjectTimers = new Set();

function maybeInject(ctx, sessionId, violation) {
  if (!pluginConfig.correctInject) return;
  const key = `${sessionId}:${violation.ruleId}`;
  // v0.5.7 投递资格闸（用户拍板"提醒一次并记住 + 会话每小时 3 条预算"，2026-08-26）：
  // 同规则同会话仅投递一次（__self-cert 聚合除外），会话每小时至多 3 条。
  // 被拦的违规仍写审计（inject-skip）——只有"弹进对话"被省掉，审计完整性不降级。
  const gate = shouldDeliver({
    now: Date.now(),
    ruleId: violation.ruleId,
    firstAt: state.injectAt.get(key) ?? null,
    budgetTimes: state.injectBudget.get(sessionId) || []
  });
  if (!gate.ok) {
    audit({
      kind: "inject-skip",
      rule: violation.ruleId,
      name: "投递资格拦截",
      event: "inject",
      reason: `未投递（${gate.reason}）：${String(violation.reason || "").slice(0, 80)}`,
      session: sessionId
    });
    return;
  }
  state.injectAt.set(key, Date.now());
  const budgetArr = state.injectBudget.get(sessionId) || [];
  budgetArr.push(Date.now());
  state.injectBudget.set(sessionId, budgetArr.slice(-20));
  const count = state.injectCounts.get(key) || 0;
  state.injectCounts.set(key, count + 1);
  // C2 统计：注入（injected）计数（实际投递尝试，上限内）
  {
    const sStat = getSessionState(state, sessionId);
    const st = (sStat.ruleStats ||= {});
    const k = (st[violation.ruleId] ||= { detected: 0, suppressed: 0, injected: 0 });
    k.injected++;
  }
  const timer = setTimeout(() => {
    pendingInjectTimers.delete(timer);
    try {
      const agent = ctx.agents.get(sessionId);
      if (agent && typeof agent.inject === "function") {
        // 2026-08-24 批次 6 收尾（O1 实弹观测）：注入消息必须具备官方身份（id+role）——
        // dsh-llm 官方 createUserMessage 生成 { id: randomUUID(), role: "user", content, source }；
        // 无 id 时 Inbox.validate 用 undefined 作身份，同批第二条起抛
        // `message "undefined" is already pending`（实弹 17:56:37 八连发观测）。
        agent.inject({
          id: `re-${randomUUID()}`,
          role: "user",
          content: [
            {
              type: "text",
              text: `[规则引擎] ${violation.reason}（规则 ${violation.ruleId}，已记入 /guard log；下次回复请自证/纠正）`
            }
          ],
          source: { kind: "plugin", plugin: name }
        });
        audit({ kind: "inject", rule: violation.ruleId, name: "纠正注入", event: "inject", reason: `注入已投递（agent=${sessionId}）：${String(violation.reason || "").slice(0, 120)}`, session: sessionId });
      } else {
        audit({ kind: "inject", rule: violation.ruleId, name: "纠正注入", event: "inject", reason: `注入未投递：agents.get(${sessionId}) 无可用 agent.inject`, session: sessionId });
      }
    } catch (error) {
      audit({ kind: "inject", rule: violation.ruleId, name: "纠正注入", event: "inject", reason: `注入异常：${error instanceof Error ? error.message : String(error)}`, session: sessionId });
    }
  }, 0);
  pendingInjectTimers.add(timer);
}

/**
 * v0.5.7：D 级嫌疑异步裁决并投递（用户拍板"只有错误的行为才值得被提醒"）。
 * 裁决函数可注入（state.judgeFn，测试用 stub；生产 = judge.js 的 LLM 实现）。
 * 结果审计：judge-pass（确认违规→投递）/ judge-false（合规声明/引述→不投）/
 * judge-unavailable（失败/超时/预算满→fail-closed 不投）——三类全部留 /guard log 可对质。
 */
async function deliverSuspects(ctx, sessionId, suspects, text) {
  const judgeFn = state.judgeFn || judgeViolation;
  const results = await Promise.all(suspects.map(async (v) => {
    try {
      const verdict = await judgeFn(ctx, state, sessionId, v, text);
      const kind = verdict.action === "deliver" ? "judge-pass"
        : verdict.action === "suppress" ? "judge-false"
        : "judge-unavailable";
      audit({
        kind,
        rule: v.ruleId,
        name: "违规裁决",
        event: "assistant/message",
        reason: `${verdict.action}：${verdict.note || ""}${verdict.model ? `（model=${verdict.model}）` : ""}`,
        session: sessionId
      });
      return verdict.action === "deliver" ? v : null;
    } catch (error) {
      audit({
        kind: "judge-unavailable",
        rule: v.ruleId,
        name: "裁决异常",
        event: "assistant/message",
        reason: `未投递：${error instanceof Error ? error.message : String(error)}`,
        session: sessionId
      });
      return null;
    }
  }));
  const deliver = results.filter(Boolean);
  if (deliver.length > 1) {
    const briefs = deliver.map((v) => `规则 ${v.ruleId}（${String(v.reason || "").slice(0, 60)}）`).join("；");
    maybeInject(ctx, sessionId, {
      ruleId: "__self-cert",
      reason: `裁决通过 ${deliver.length} 项：${briefs}——请按 /guard log 明细应对`
    });
  } else if (deliver.length === 1) {
    maybeInject(ctx, sessionId, deliver[0]);
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

/** v0.5.7 P0-4：验证通过记录持久化（文件损坏/写失败不阻断运行时） */
function persistVerifyPass(state) {
  try {
    writeFileSync(verifyFilePath(), JSON.stringify((state.verifyPass || []).slice(-100)), "utf8");
  } catch {
    // 持久化失败仅降级（内存态仍有效），不阻断
  }
}

/** v0.5.7 后续（用户批准）：unknown 工具白名单持久化（~/.dsh/rule-engine-tools.json——"允许使用 X"重启/热重载不丢） */
function persistToolWhitelist(state) {
  try {
    writeFileSync(toolsWhitelistFilePath(), JSON.stringify([...(state.unknownToolApproved || [])]), "utf8");
  } catch {
    // 持久化失败仅降级（内存态仍有效），不阻断
  }
}

export function handleSessionEvent(ctx, session, event) {
  maybeReloadIfChanged(state);
  const sid = session?.id || "global";
  const s = getSessionState(state, sid);
  const d = event.data || {};
  if (event.type === "turn/start") {
    resetTurn(state, sid, d.turn);
    return;
  }
  if (event.type === "turn/end") {
    // M8 双通道机制：本回合用 example-manual-write 落盘手册/AGENTS 后，必须同轮 engram_store 沉淀记忆；
    // 缺失 → 审计 + 注入纠正（用户明确要求机制化，2026-08-24）
    if (s.turn.manualWriteSeen && !s.turn.engramStoreSeen) {
      audit({
        kind: "engram-gap",
        rule: "__engram-gap",
        name: "双通道记忆缺失",
        event: "turn/end",
        reason: "本回合 example-manual-write 落盘了手册/AGENTS，但未同轮调用 engram_store；按规则 19/77/M8 应在同一回合完成记忆沉淀",
        session: sid
      });
      maybeInject(ctx, sid, {
        ruleId: "__engram-gap",
        reason: "规则 19/M8：手册/AGENTS 落盘后必须在同一回合补 engram_store，否则记忆机制断链——请立即补写并说明"
      });
    }
    return;
  }
  if (event.type === "user/message") {
    // 机制 A（2026-08-24）：source.kind 主判——非 user 来源（官方 agent-instructions/skill-catalog、
    // 插件自定义 kind）一律不进授权池、不覆盖回合状态；审计留痕可对账（source-skip）。
    const srcKind = d?.source?.kind;
    if (typeof srcKind === "string" && srcKind !== "user") {
      const preview = extractUserText(d).slice(0, 80);
      audit({
        kind: "source-skip",
        rule: "__source-skip",
        name: "非用户来源消息跳过",
        event: "user/message",
        reason: `source.kind=${srcKind}：${preview}`,
        session: sid
      });
      return;
    }
    // 系统注入剥离（2026-08-24 v2）：注入与真实用户消息合并为同一事件
    //（官方注入机制将 <system-reminder> 烤进 content；剥离后剩余文本 = 用户消息）。
    // 2026-08-24 根因修复：event.data 即消息对象（官方 surface 结构），不再取 d.message。
    const text = stripInjectedContext(extractUserText(d));
    if (!text) return;
    // 引擎自身注入的 [规则引擎] 提示不是用户消息，跳过——否则其中的“请直接执行”会被记录成授权（自我续授权漏洞）
    if (isEngineInjectedMessage(text)) return;
    // 模板兜底（对 kind=user 同样生效，防"标 user 的注入"——example-injector createUserMessage 同类风险）：
    // runtime context 快照 / 子代理完成通知 / vision-router 挂载提醒等已知注入模板 → 整体跳过
    if (isKnownSystemInjection(text)) {
      audit({
        kind: "source-skip",
        rule: "__source-skip",
        name: "已知系统注入模板跳过",
        event: "user/message",
        reason: `文本模板命中：${text.slice(0, 80)}`,
        session: sid
      });
      return;
    }
    // 批次 3（2026-08-24）：用户明确"允许使用 X"→ 未归类工具会话白名（unknown→deny 的唯一批准路径）
    if (!state.unknownToolApproved) state.unknownToolApproved = new Set();
    for (const hit of text.matchAll(/(?:允许|批准|同意)\s*(?:使用|调用|用|启用|放行)\s*([A-Za-z_][A-Za-z0-9_:.-]*)/g)) {
      const toolName = hit[1];
      if (toolClass(toolName, {}) !== "unknown") continue; // 只对未归类工具有意义（已知工具不走 unknown 分支）
      const isNew = !state.unknownToolApproved.has(toolName);
      state.unknownToolApproved.add(toolName);
      persistToolWhitelist(state); // v0.5.7 后续：白名单持久化（重启/热重载不丢——用户批准"这句不用每次发"）
      audit({
        kind: "unknown-tool-whitelist",
        rule: "__unknown-tool",
        name: "用户批准未归类工具",
        event: "user/message",
        reason: `用户明确允许使用 ${toolName}${isNew ? "" : "（重复，忽略）"} → 会话白名`,
        session: sid
      });
    }
    s.lastUserText = text;
    s.turn.userText = text;
    s.turn.realUserSeen = true; // v0.5.7：真实用户在场（注入轮不检测的依据——乒乓根治）
    s.turn.questionOnly = isQuestionMessage(text);
    s.turn.intents = parseUserIntents(text);
    // 规则 22 粒度升级（2026-08-24）：本回合授权范围 = 各 execute 子句推导出的 type+path 范围
    s.turn.scopes = scopesFromIntents(s.turn.intents);
    // LLM 意图兜底（方案 A）：低置信/歧义消息异步预取，不阻塞事件流；失败自动降级词表
    if (pluginConfig.llmIntent?.enabled) {
      void enrichIntentWithLlm(ctx, state, sid, text, pluginConfig.llmIntent);
    }
    if (state.taskContract?.taskContractEnabled) {
      const patch = naturalMode(text, s.contract);
      if (patch) {
        const res = applyContract(s.contract, patch);
        if (res.changed) {
          s.contract = res.contract;
          audit({
            kind: "task-contract",
            rule: "__task-contract",
            name: "任务契约更新",
            event: "user/message",
            reason: `${patch.source}: ${contractSummary(s.contract)}`,
            session: sid
          });
        }
      }
    }
    const intents = s.turn.intents;
    let recordedAuth = false;
    if (intents?.clauses?.some((c) => c.type === "execute")) {
      // 与规则 22 粒度保持一致：按 scopesFromIntents 的多 type×多 path 逐条记录 12A 授权，
      // 避免“规则 22 放行、12A 却因只记了单 type/单路径而拦截”的不一致（2026-08-24 第二轮修复）
      const execScopes = s.turn.scopes && s.turn.scopes.length > 0 ? s.turn.scopes : scopesFromIntents(intents);
      for (const scope of execScopes) {
        recordAuthorization(state, sid, {
          type: scope.type,
          pathPrefix: scope.pathPrefix,
          source: "user-message-clause",
          clauseId: scope.clauseId
        });
      }
      recordedAuth = true;
      audit({ kind: "auth", rule: "12D", name: "用户消息执行子句授权", event: "user/message", reason: `记录执行分点授权：${text.slice(0, 120)}`, session: sid });
    } else if (isAuthMessage(text) || isDirectiveMessage(text)) {
      recordAuthorization(state, sid, {
        type: inferTypeFromText(text),
        pathPrefix: inferPathPrefixFromText(text),
        source: "user-message"
      });
      recordedAuth = true;
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
      // workdir 校验提示（机制批 M6）：命令含显式相对路径（./ 或 ../）但未声明 workdir → 审计提示（不拦）
      if (cmd && /(?:^|\s)(?:\.{1,2}[\\/])/.test(cmd) && !args?.workdir) {
        audit({
          kind: "workdir-hint",
          rule: "__workdir-hint",
          name: "workdir 提示",
          event: "tool/call",
          tool: toolName,
          reason: "命令含相对路径但未显式声明 workdir——易与当前目录错配（机制批 M6），pws 请显式 workdir",
          session: sid
        });
      }
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
    if (state.taskContract?.taskContractEnabled) {
      recordAction(s, toolName, args);
      if (isObserving(s.contract, state.taskContract)) {
        const action = classifyAction(toolName, args);
        const problems = [];
        if (action.hashIntent && s.contract.hashPolicy !== "allow") problems.push("hash 未授权");
        if (action.dependencyIntent && s.contract.dependencyPolicy !== "allow") problems.push("依赖未授权");
        if (isRepeatedTaskAction(s, toolName, args)) problems.push("重复动作打转");
        if (problems.length) {
          audit({
            kind: "task-observe",
            rule: "__task-contract",
            name: "任务契约观察",
            event: "tool/call",
            tool: toolName,
            args: summarizeArgs(args),
            reason: `[观察] ${problems.join("；")}`,
            session: sid
          });
        }
      }
    }
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
        // 规则 1 计数解耦（P1-7，2026-08-24）：引擎 deny 来源的失败不计入“同工具连续失败”
        if (!((state.deniedKeys || new Set()).has(key))) {
          state.retryCounts.set(key, (state.retryCounts.get(key) || 0) + 1);
        } else {
          state.retryCounts.delete(key);
        }
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

    // M8 双通道机制（2026-08-24）：example-manual-write 落盘成功 → 标记；同轮 engram_store 成功 → 标记
    if (!isError && pendingCall) {
      const cmd = pendingCall.args?.command || pendingCall.args?.code || "";
      if ((pendingCall.name === "pwsh" || pendingCall.name === "bash") && /\bexample-manual-write\.mjs/.test(cmd)) {
        s.turn.manualWriteSeen = true;
      }
      if (pendingCall.name === "engram_store") {
        s.turn.engramStoreSeen = true;
      }
    }

    // 任务契约：委托预算扣减已移至 pre-execute 启动即计（批次 5.5；原 tool/result 路径因
    // subagent 无 pendingCall 从未执行——本块删除防双重扣减）

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

    // 交付闸门采集（机制批 M3）：测试/冷加载探针通过输出 → verify-pass 记录（供规则 23④ 声明核对）
    // 2026-08-25 鲁棒化（实弹观测）：旧条件依赖 pendingCall（tool/call→result 的 callId 匹配），
    // RC.2 下疑似失配导致采集从未执行——23④ 每次声明都 verify-gap；改为只看输出文本，不依赖
    // pendingToolCalls 状态（what 降级记录），verify-pass 语义不变（输出即证据）。
    if (!isError) {
      const output = extractToolOutput(d);
      if (/\bALL TESTS PASSED\b|RESULT:\s*PASS|\bVERIFY ALL OK\b/.test(output)) {
        if (!state.verifyPass) state.verifyPass = [];
        state.verifyPass.push({ at: Date.now(), sessionId: sid, what: pendingCall?.name || "tool-result" });
        if (state.verifyPass.length > 100) state.verifyPass.splice(0, state.verifyPass.length - 100);
        persistVerifyPass(state); // v0.5.7 P0-4：持久化（热重载/重启不丢）
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
        s.turn.realUserSeen = true; // v0.5.7：ask 弹窗答复也算"真实用户在场"
        const qText = askQuestionText(pending.questions);
        const selectedText = askResultSelectedText(result);
        // 授权范围只取“问题核心 + 用户实际选择”，不再把全部选项描述纳入；
        // 避免“仅会话内说明/不跨会话保留”等选项说明把一次小授权放大成全局 12h（2026-08-24 修复）
        const scopeText = `${askQuestionCoreText(pending.questions)} ${selectedText}`.trim();
        const pathPrefix = inferPathPrefixFromText(scopeText || qText);
        // ask 问题文本措辞不可靠，授权记录为宽泛类型 any + 路径前缀，避免类型错位
        // 无路径的全局 any 授权缩短 TTL，降低安全边界风险
        const authRecord = {
          type: "any",
          pathPrefix,
          source: "ask"
        };
        const sessionWide = isSessionWideAskText(scopeText) || isSessionWideAskText(selectedText);
        if (sessionWide) authRecord.expiresAt = Date.now() + 12 * 60 * 60 * 1000;
        else if (!pathPrefix) authRecord.expiresAt = Date.now() + 2 * 60 * 1000;
        recordAuthorization(state, sid, authRecord);
        // 2026-08-25 修复（用户授权）：ask 答复也是用户明确允许——若答复文本含"允许使用 X"模式，
        // 同步写入 unknown 工具会话白名单（与 user/message 分支同一判定；此前只有用户消息文本可写白名，
        // ask 弹窗授权后 web_fetch 等仍被 unknown deny 拦——机制缺口，本修复关闭）
        const whtText = `${qText} ${selectedText}`;
        for (const hit of whtText.matchAll(/(?:允许|批准|同意)\s*(?:使用|调用|用|启用|放行)\s*([A-Za-z_][A-Za-z0-9_:.-]*)/g)) {
          const wname = hit[1];
          if (toolClass(wname, {}) !== "unknown") continue;
          if (!state.unknownToolApproved) state.unknownToolApproved = new Set();
          const isNew = !state.unknownToolApproved.has(wname);
          state.unknownToolApproved.add(wname);
          persistToolWhitelist(state); // v0.5.7 后续：白名单持久化（见上）
          audit({
            kind: "unknown-tool-whitelist",
            rule: "__unknown-tool",
            name: "用户批准未归类工具（ask 答复）",
            event: "tool/result",
            reason: `ask 答复含"允许使用 ${wname}" → 会话白名${isNew ? "" : "（重复，忽略）"}（来源=ask 选择文本）`,
            session: sid
          });
        }
        if (!s.turn.scopes) s.turn.scopes = [];
        s.turn.scopes.push(authRecord);
        audit({
          kind: "auth",
          rule: "12D",
          name: "ask_user_question 授权",
          event: "tool/result",
          reason: `记录授权范围：${qText.slice(0, 120)}`,
          session: sid
        });
      } else {
        // 弹窗消减（2026-08-24）：本回合 ask 被拒 → 标记 + 全局记录（5 分钟内再 ask 会被 __ask-throttle 拦）
        s.turn.askRejected = true;
        if (!state.askRejections) state.askRejections = [];
        state.askRejections.push({ sessionId: sid, at: Date.now() });
        if (state.askRejections.length > 200) state.askRejections.splice(0, state.askRejections.length - 200);
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
    // v0.5.7 第 0 站：注入轮（无真实用户消息）不检测不投递——这是乒乓循环的根治：
    // 引擎自己的注入 → 我的回复 → 再检测 的燃料被掐断（实测 2026-08-26 12:37 六圈即此循环）。
    if (!shouldDetectTurn({ realUserSeen: s.turn.realUserSeen })) return;
    // 交付声明机器闸门（机制批 M3，规则 23④）：完成类声明 → 核对同会话 30 分钟内 verify-pass 记录，缺失注入纠正
    if (/完成|已通过|已修复|搞定|验证通过|全部通过|修复完成|落盘完成/.test(text)) {
      const windowStart = Date.now() - 30 * 60 * 1000;
      const hasPass = (state.verifyPass || []).some((v) => v.sessionId === sid && v.at > windowStart);
      if (!hasPass) {
        audit({
          kind: "verify-gap",
          rule: "23",
          name: "交付声明缺验证闸门记录",
          event: "assistant/message",
          reason: "交付/完成类声明缺少同会话近期 verify-pass（ALL TESTS PASSED / example-plugin-load RESULT: PASS）记录",
          session: sid
        });
        // v0.5.7 后续（用户拍板"暗示型统一裁决"）：23④ 词面命中只是嫌疑——"完成"≠交付声明
        //（"完成社区检索"类误触的修复）：送 LLM 裁决，确认违规才投递。
        void deliverSuspects(ctx, sid, [{
          ruleId: "23",
          title: "变更与交付验证（执行等级：D 强）",
          kind: "self-certify",
          awaitingJudge: true,
          reason: "规则 23④：完成/通过类声明需同会话近期验证记录（测试全绿或冷加载 PASS），缺失已记审计"
        }], text);
      }
    }
    // 需求基线覆盖核查（RB-09，2026-08-24）：方案/重构/整体完成类声明 → 基线仍存在 planned 需求 → 审计纠正（fail-closed）
    if (BASELINE_COMPLETE_RE.test(text)) {
      const bl = loadBaselineFile();
      if (bl.ok) {
        const gap = computeBaselineGap(text, bl.items);
        if (gap) {
          audit({
            kind: "baseline-gap",
            rule: "__baseline-gap",
            name: "需求基线未覆盖",
            event: "assistant/message",
            reason: `完成类声明但需求基线仍有 ${gap.count} 条未落地（${gap.pending.join("、")}）——先完成或更新基线再宣布完成`,
            session: sid
          });
          maybeInject(ctx, sid, {
            ruleId: "__baseline-gap",
            reason: `需求基线仍有 ${gap.count} 条未落地（${gap.pending.join("、")}），请先完成或更新基线再宣布整体完成`
          });
        }
      } else {
        audit({
          kind: "baseline-unreadable",
          rule: "__baseline-gap",
          name: "需求基线不可读",
          event: "assistant/message",
          reason: `完成类声明但需求基线文件无法读取（${bl.error || "未知"}）——fail-closed，无法核查覆盖`,
          session: sid
        });
      }
    }
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
    }
    // v0.5.7 分流水线：B 级机器型（correct，词表=确定证据）立即投递；
    // D 级语义型命中 = 嫌疑（awaitingJudge）→ 先裁决，只有裁决=违规的才投递
    // （用户拍板："只有错误的行为才值得被提醒"——词表只产嫌疑，不再定罪）。
    const immediate = violations.filter((v) => v.kind !== "self-certify");
    const suspects = violations.filter((v) => v.awaitingJudge === true);
    if (immediate.length > 1) {
      const briefs = immediate
        .map((v) => `规则 ${v.ruleId}（${String(v.reason || "").slice(0, 60)}）`)
        .join("；");
      maybeInject(ctx, sid, {
        ruleId: "__self-cert",
        reason: `本轮检出 ${immediate.length} 项：${briefs}——请按 /guard log 明细应对`
      });
    } else if (immediate.length === 1) {
      maybeInject(ctx, sid, immediate[0]);
    }
    if (suspects.length > 0) {
      void deliverSuspects(ctx, sid, suspects, text);
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
  "  /guard mode <模式>     设置任务契约模式（review/answer/change/monitor/watch/off）",
  "  /guard budget ...      设置预算（agents=N files=... deps=allow hash=allow）",
  "  /guard contract        查看当前任务契约",
  "  /guard label <id> <label>  给审计记录打标（correct/incorrect/inconclusive）",
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
  if (/^mode\b/i.test(text)) {
    const parsed = parseModeCommand(text);
    if (parsed) return { kind: "mode", ...parsed };
  }
  if (/^budget\b/i.test(text)) {
    const parsed = parseBudgetCommand(text);
    if (parsed) return { kind: "budget", patch: parsed };
  }
  if (/^contract$/i.test(text)) return { kind: "contract" };
  m = text.match(/^label\s+(\S+)\s+(correct|incorrect|inconclusive)$/i);
  if (m) return { kind: "label", eventId: m[1], label: m[2].toLowerCase() };
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
      // 覆盖自省（一致性预防）：dead = 映射有但规则无；uncovered = 硬等级规则但无 handler
      const { dead, uncovered } = analyzeCoverage(state.configs);
      const parts = [
        "【规则引擎状态】",
        `  总开关：${state.enabled ? "开启" : "已关闭"}`,
        `  任务契约：${state.taskContract?.taskContractEnabled ? `开启（模式 ${state.taskContract.taskContractMode}｜ask ${state.taskContract.askEnabled ? "开" : "关"}）` : "关闭"}`,
        `  规则容器：${state.configOk ? `正常（${state.configs.length} 条规则）` : "⚠ " + state.configError}`,
        `  理解置信度：high ${high} / medium ${medium} / low ${low}`,
        `  覆盖自省：${dead.size === 0 && uncovered.length === 0 ? "无缺口" : (dead.size > 0 ? `死映射 ${[...dead.keys()].join("、")}（引擎映射存在但规则已删除，建议清理）` : "") + (uncovered.length > 0 ? `；未覆盖 ${uncovered.map((u) => u.ruleId).join("、")}（${uncovered.map((u) => u.actions.join("+")).join("；")} 但无 handler，规则声明强制但引擎不执行，建议降 D 级或补实现）` : "")}`,
        `  配置加载：${conf.ok ? "正常" : "⚠ " + conf.error}`,
        `  解锁剩余：${fmtRemain(remainMs(state.unlockUntil))}（配置写保护豁免）`,
        `  放行剩余：${fmtRemain(remainMs(state.bypassUntil))}（全部守卫暂停）`,
        `  授权存储：内存态（重启失效）`,
        `  审计日志：${auditFilePath()}`,
        `  LLM 意图判定：${state.llmIntentCfg?.enabled ? `开启（今日 ${[...(state.llmIntentBudget?.values() || [])].reduce((a, b) => a + b, 0)} 次/${pluginConfig.llmIntent?.dailyLimitPerSession ?? 50}，缓存命中 ${state.llmIntentHits || 0}，缓存 ${state.llmIntentCache?.size || 0} 条${state.llmIntentLast ? `；最近：${state.llmIntentLast.text} → ${state.llmIntentLast.source}${state.llmIntentLast.verdict ? `（conf=${state.llmIntentLast.verdict.confidence}）` : "【降级词表】"}` : ""}）` : "关闭"}`,
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
        parts.push(`      等级 ${c.level || "?"}｜动作 ${actions}｜置信 ${c.confidence}｜handler ${c.handler || "（无——规则声明强制但引擎不执行，建议降 D 级或补实现）"}`);
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
      // 逃生门请求审计（机制批 M1）：用途留痕，供规则 1⑤ 事前说明核对
      audit({ kind: "guard-command", rule: "__escape-gate", name: "逃生门请求", event: "command", reason: `/guard unlock ${minutes} 分钟（配置写保护）`, session: invocation?.session?.id || "global" });
      return {
        kind: "success",
        text: `已解锁「配置写保护」${minutes} 分钟。现在可以让助手修改 rule-engine.json / rule-understanding.json / AGENTS.md；改完请执行 /guard lock 或等待自动恢复。`
      };
    }
    case "bypass": {
      const minutes = Math.min(Math.max(1, command.minutes), 60);
      state.bypassUntil = Date.now() + minutes * 60000;
      // 逃生门请求审计（机制批 M1）
      audit({ kind: "guard-command", rule: "__escape-gate", name: "逃生门请求", event: "command", reason: `/guard bypass ${minutes} 分钟（全部守卫）`, session: invocation?.session?.id || "global" });
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
      // R1.3（2026-08-24）：全清——session.authorizations + turn.scopes + globalAuthorizations + askRejections
      const count = clearAuthorizations(state);
      // 可观测性（阶段 0 + 机制 C，2026-08-24）：revoke 事件必须留痕，否则撤销无法复核（B4 实证）
      audit({
        kind: "guard-command",
        rule: "__revoke",
        name: "撤销全部授权",
        event: "command",
        reason: `撤销 ${count} 条授权/范围（session + turn.scopes + global + askRejections 全清）`,
        session: invocation?.session?.id || "global"
      });
      return { kind: "success", text: `已撤销全部授权与范围（共 ${count} 条，含全局池与 ask 拒绝记录；不再有残留）。` };
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
        parts.push(`  [${t}] ${e.kind || "?"}｜规则 ${e.rule || "?"}｜${e.name || ""}${e.eventId ? `（${e.eventId}）` : ""}`);
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
    case "mode": {
      if (!state.taskContract?.taskContractEnabled) return { kind: "error", text: "任务契约未启用：请先在规则引擎设置页开启总开关。" };
      const sid = invocation?.session?.id || "global";
      const s = getSessionState(state, sid);
      const res = applyContract(s.contract, { mode: command.mode, level: command.level, source: "guard-command" });
      if (res.changed) {
        s.contract = res.contract;
        audit({ kind: "task-contract", rule: "__task-contract", name: "任务契约更新", event: "command", reason: `/guard mode: ${contractSummary(s.contract)}`, session: sid });
      }
      return { kind: "success", text: `任务契约：${contractSummary(s.contract)}` };
    }
    case "budget": {
      if (!state.taskContract?.taskContractEnabled) return { kind: "error", text: "任务契约未启用：请先在规则引擎设置页开启总开关。" };
      const sid = invocation?.session?.id || "global";
      const s = getSessionState(state, sid);
      const res = applyContract(s.contract, { ...command.patch, source: "guard-command" });
      if (res.changed) {
        s.contract = res.contract;
        audit({ kind: "task-contract", rule: "__task-contract", name: "任务预算更新", event: "command", reason: `/guard budget: ${contractSummary(s.contract)}`, session: sid });
      }
      return { kind: "success", text: `任务契约：${contractSummary(s.contract)}` };
    }
    case "contract": {
      const sid = invocation?.session?.id || "global";
      const s = getSessionState(state, sid);
      const enabled = state.taskContract?.taskContractEnabled ? "开启" : "关闭（总开关未开启，命令不生效）";
      return { kind: "success", text: `任务契约（总开关：${enabled}）\n${contractSummary(s.contract)}` };
    }
    case "label": {
      const entries = readAuditLog(500);
      const found = entries.find((e) => e.eventId === command.eventId);
      if (!found) return { kind: "error", text: `未找到审计事件：${command.eventId}` };
      state.labels.set(command.eventId, command.label);
      audit({ kind: "task-label", rule: "__task-contract", name: "审计人工标注", event: "command", reason: `${command.eventId} = ${command.label}`, session: invocation?.session?.id || "global" });
      return { kind: "success", text: `已标注 ${command.eventId} = ${command.label}` };
    }
    default:
      return { kind: "error", text: USAGE };
  }
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

export function apply(ctx) {
  // 0. v0.5.7 P0-3：注册全部工作区根（多工作区环境；精确层=会话级，在 guard 回调按会话同步）
  try {
    const list = ctx.workspaceRegistry?.list?.() || [];
    setWorkspaceRoots(list.map((e) => e && (e.path || e.record?.path)).filter(Boolean));
  } catch {
    setWorkspaceRoots([]);
  }

  // v0.5.7 P0-4：加载持久化验证记录（热重载/重启后规则 23④ 证据链不丢；仅保留 30 分钟内）
  try {
    const raw = readFileSync(verifyFilePath(), "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      state.verifyPass = arr
        .filter((v) => v && v.at && Date.now() - Number(v.at) < 30 * 60 * 1000)
        .slice(-100);
    }
  } catch {
    // 首次运行/文件缺失：无历史记录，正常
  }

  // v0.5.7 后续（用户批准）：加载白名单持久化（"允许使用 X"重启/热重载不丢）
  try {
    const wlRaw = readFileSync(toolsWhitelistFilePath(), "utf8");
    const wlArr = JSON.parse(wlRaw);
    if (Array.isArray(wlArr)) {
      state.unknownToolApproved = new Set(wlArr.filter((n) => typeof n === "string"));
    }
  } catch {
    // 首次运行/无文件：空白名单
  }

  // 0.0.1 LLM 意图兜底配置（guardDecision 为纯函数，经 state 传入）
  state.llmIntentCfg = pluginConfig.llmIntent || {};

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

  // 0.3.1 注入延迟投递定时器清理（O1 批次 6）：卸载/热重载时取消全部 pending inject
  ctx.effect(
    function* () {
      yield () => {
        for (const t of pendingInjectTimers) clearTimeout(t);
        pendingInjectTimers.clear();
      };
    },
    "dsh-rule-engine inject timers"
  );

  // 1. 单调守卫：工具调用先裁决，命中即物理拒绝
  ctx.effect(
    function* () {
      yield ctx.tools.guard((exec) => {
        // v0.5.7 P0-3：多工作区正确模型——根随会话走。每个工具调用前按当前会话同步其工作区根
        //（官方 workspaceRegistry.sessionPath 提供会话→工作区映射；新工作区零维护自动识别）。
        try {
          const gsid = sessionIdOfExec(exec);
          if (gsid && gsid !== "global" && ctx.workspaceRegistry?.sessionPath) {
            const root = ctx.workspaceRegistry.sessionPath(gsid);
            if (root) setSessionWorkspaceRoot(gsid, root);
          }
        } catch {
          // 会话未映射时安静走全局兜底，不阻塞裁决
        }
        // 落盘授权粒度提醒（机制批 M7，2026-08-24）：受保护文件统一入口调用 + 本回合用户消息为方案性指令
        //（调整/补充/评估/建议且无落盘词）→ approval-gap 审计 + 注入提醒（规则 22 自证③：方案性指令 ≠ 落盘授权）
        {
          const cmd = exec?.arguments?.command || exec?.arguments?.code || "";
          if ((exec?.name === "pwsh" || exec?.name === "bash") && /\bexample-manual-write\.mjs/.test(cmd)) {
            const s7 = getSessionState(state, sessionIdOfExec(exec));
            if (needsApprovalReminder(s7.turn.userText || "")) {
              audit({
                kind: "approval-gap",
                rule: "__approval-gap",
                name: "落盘授权粒度提醒",
                event: "tool/guard",
                tool: exec?.name,
                args: summarizeArgs(exec?.arguments),
                reason: "本回合用户消息为方案性指令（调整/补充/评估/建议等），不构成落盘授权（规则 22 自证③）——落盘前应先展示→用户确认",
                session: sessionIdOfExec(exec)
              });
              maybeInject(ctx, sessionIdOfExec(exec), {
                ruleId: "__approval-gap",
                reason: "规则 22 自证③：方案性指令不构成落盘授权——受保护文件落盘需先展示改动→用户明确确认→再执行（机制批 M7）"
              });
            }
          }
        }
        // 逃生门窗口打标（机制批 M2）：bypass 生效期间一切变更类调用记 bypass-action 审计（用途留痕，供规则 1⑤ 核对）
        if (state.bypassUntil > Date.now() && !isReadOnlyTool(exec?.name, exec?.arguments)) {
          audit({
            kind: "bypass-action",
            rule: "__escape-gate",
            name: "逃生门窗口变更",
            event: "tool/guard",
            tool: exec?.name,
            args: summarizeArgs(exec?.arguments),
            reason: "窗口内变更（逃生门用途：引擎/规则/手册修复，规则 1⑤ 范围核对）",
            session: sessionIdOfExec(exec)
          });
        }
        const hit = guardDecision(state, exec, Date.now(), { audit });
        if (hit) {
          audit({
            kind: "deny",
            rule: hit.ruleId,
            name: hit.title,
            event: "tool/guard",
            tool: exec?.name,
            args: summarizeArgs(exec?.arguments),
            reason: hit.reason,
            session: sessionIdOfExec(exec) // P0-4：deny 审计补 session（2026-08-24 事故复盘：归属会话靠猜）
          });
          state.lastActive = [{ ruleId: hit.ruleId, title: hit.title, reason: hit.reason }];
          // 规则 1 计数解耦（2026-08-24，P1-7）：引擎 deny 不计入“同工具连续失败”
          const dkey = `${exec?.name}:${JSON.stringify(exec?.arguments || {})}`;
          if (!state.deniedKeys) state.deniedKeys = new Set();
          state.deniedKeys.add(dkey);
          if (state.deniedKeys.size > 500) {
            const oldest = state.deniedKeys.keys().next().value;
            if (oldest !== undefined) state.deniedKeys.delete(oldest);
          }
          // 弹窗消减（2026-08-24）：E3/ask 节流命中后注入纠正，提示改用普通文本，勿连环弹窗
          if (hit.ruleId === "__already-authorized" || hit.ruleId === "__ask-rejected" || hit.ruleId === "__ask-throttle") {
            maybeInject(ctx, sessionIdOfExec(exec), {
              ruleId: hit.ruleId,
              reason: `${hit.title}：已有授权或询问被拒时请直接执行、或用普通文本说明，不要再弹窗 ask。`
            });
          }
          return hit.reason;
        }
        return undefined;
      });
    },
    "dsh-rule-engine guard"
  );

  // 1.0 规则 12C B 级留痕：命令文本含回环/内网地址时记录审计，不拦截
  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      const cmd = exec?.arguments?.command || exec?.arguments?.code || "";
      if (typeof cmd === "string" && cmd.length > 0 && (exec?.name === "pwsh" || exec?.name === "bash") && PRIVATE_NETWORK_RE.test(cmd)) {
        audit({
          kind: "network-flag",
          rule: "12C",
          name: "内网/回环地址访问留痕",
          event: "tools/pre-execute",
          tool: exec?.name,
          reason: `命令文本含回环/内网地址模式：${cmd.slice(0, 160)}`,
          session: sessionIdOfExec(exec)
        });
      }
    } catch {
      // 留痕失败不阻断
    }
    return next();
  });

  // 0.9 机制 B（2026-08-24）：未归类工具（新插件/新工具）首调 deny——fail-closed，防"approval 层自动放行 ask"的洞。
  // 批次 3（2026-08-24 用户拍板分支 A）：实测未知工具首调 ask 被 DSH approval 层自动放行（无弹窗直接执行），
  // 因此 unknown → 物理 deny；批准路径 = 用户明确"允许使用 X"（handleSessionEvent 写入会话白名），本会话内放行。
  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      if (SAFE_UNCOVERED_TOOLS.has(exec?.name)) return next(); // 控制类不进 unknown 判定（避免 ask 自身被 ask）
      if (toolClass(exec?.name, exec?.arguments || {}) !== "unknown") return next();
      if ((state.unknownToolApproved || new Set()).has(exec.name)) return next(); // 会话内用户已批准
      audit({
        kind: "unknown-tool",
        rule: "__unknown-tool",
        name: "未归类工具拦截",
        event: "tools/pre-execute",
        tool: exec?.name,
        args: summarizeArgs(exec?.arguments),
        reason: `工具 ${exec.name} 不在规则引擎分类表（可能是新装的插件）：已拦截（unknown→deny）。批准路径：用户明确"允许使用 ${exec.name}"后本会话放行；长期规则请补充工具分类表`,
        session: sessionIdOfExec(exec)
      });
      return {
        kind: "deny",
        reason: `工具 ${exec.name} 尚未归类（新装插件？）：已拦截。如需使用请向用户说明用途并获取其"允许使用 ${exec.name}"的明确答复后重试（批准后本会话内放行）。`
      };
    } catch (error) {
      ctx.logger?.warn?.("[dsh-rule-engine] unknown-tool deny error", error);
      return next();
    }
  });

  // 1.1 任务契约裁决钩子：deny 物理拒绝 + ask 通道 + 委托预算启动即计。
  // 2026-08-25 修复（预算语义偏差，实弹：第 2 个子代理被误拒——允许 N 实际 N-1）：
  // 根因 = 扣减（本钩子）先于 guard 层的 decideContractAction（L1138 用已扣 contract 重判 → 2+1>2 → 误拒）。
  // 修复 = 本钩子成为契约唯一裁决点（deny 在扣减**前**判定并物理拒绝），guard 层跳过预算类 deny（防双判）。
  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      if (!state.taskContract?.taskContractEnabled) return next();
      const sid = sessionIdOfExec(exec);
      const s = getSessionState(state, sid);
      if (!isArmed(s.contract, state.taskContract)) return next();
      const action = classifyAction(exec?.name, exec?.arguments);
      const dec = decideContractAction({ contract: s.contract, action, config: state.taskContract });
      // deny（在扣减前判定，语义=本次调用发生时点）
      if (dec.outcome === "deny") {
        audit({
          kind: "task-contract-deny",
          rule: "__task-contract",
          name: `任务契约拒绝：${dec.reasonCode}`,
          event: "tools/pre-execute",
          tool: exec?.name,
          args: summarizeArgs(exec?.arguments),
          reason: dec.reason,
          session: sid
        });
        return { kind: "deny", reason: `【硬拦截】${dec.reason}（${dec.reasonCode}｜任务契约｜放行：${dec.nextStep || "请调整契约"}）` };
      }
      // 批次 5.5（2026-08-24）：委托启动即计预算——原 tool/result 扣减因 subagent 无 pendingCall 从未执行（agents 恒 0）
      if (dec.outcome === "allow" && action.mutability === "delegate" && action.delegationCount > 0) {
        s.contract = consumeDelegateBudget(s.contract, action.delegationCount);
        audit({
          kind: "task-budget",
          rule: "__task-contract",
          name: "子代理预算扣减",
          event: "tools/pre-execute",
          tool: exec?.name,
          reason: `已用 ${s.contract.agentsUsed}/${s.contract.agentBudget}`,
          session: sid
        });
      }
      if (dec.outcome === "ask") {
        audit({
          kind: "task-ask",
          rule: "__task-contract",
          name: "任务契约询问",
          event: "tools/pre-execute",
          tool: exec?.name,
          args: summarizeArgs(exec?.arguments),
          reason: dec.reason,
          session: sid
        });
        return { kind: "ask", reason: `${dec.reason}（任务契约｜${dec.nextStep || "请确认或使用放行词"}）` };
      }
      // 可观测性（阶段 0，2026-08-24）：armed 下 deny/allow 裁决也留痕，CI 澄清"契约 deny 有无真实拦截路径"
      if (dec.outcome === "deny" || dec.outcome === "allow") {
        audit({
          kind: "contract-decision",
          rule: "__task-contract",
          name: "任务契约裁决",
          event: "tools/pre-execute",
          tool: exec?.name,
          args: summarizeArgs(exec?.arguments),
          reason: `裁决 ${dec.outcome}｜${dec.reasonCode}｜${dec.reason}`,
          session: sid
        });
      }
      // 批次 4（2026-08-24）：契约 deny 真实物理拦截（原仅审计 + next()——armed 下出界写/
      // 无界委托/预算超/模式禁止变更均无实际效力）
      if (dec.outcome === "deny") {
        return { kind: "deny", reason: `${dec.reason}（任务契约｜${dec.nextStep || "请调整契约或停止该操作"}）` };
      }
      return next();
    } catch (error) {
      ctx.logger?.warn?.("[dsh-rule-engine] tools/pre-execute error", error);
      return next();
    }
  });

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
