// dsh-rule-engine —— DSH 规则执行引擎 v3（host 插件，纯 Node）
// 容器：解析 AGENTS.md → 理解器 → 匹配机 → 执行框架。
// 执行框架：ctx.tools.guard() 硬拦 + session/event 文本纠察 + 审计台账 + /guard 命令。
import { readFileSync, watch, writeFileSync, existsSync } from "node:fs";
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
  matchKnownPitfall,
  needsApprovalReminder,
  PRIVATE_NETWORK_RE,
  setWorkspaceRoot,
  setWorkspaceRoots,
  setSessionWorkspaceRoot,
  setPatterns
} from "./core/patterns.js";
import {
  askQuestionCoreText,
  askQuestionText,
  askResultApproved,
  askResultRejected,
  askResultSelectedText,
  classifyAskScopeType,
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
  resetTurn,
  saveTurnCardsToDisk
} from "./core/state.js";
import { toolClass } from "./core/tool-catalog.js";
import { parseWhitelist, mergeWhitelist, serializeWhitelist } from "./core/whitelist.js";
import { state } from "./core/runtime.js";
import { APPROVE_TYPES, normalizePath, setTypeHints } from "./core/authorization.js";
import { setLexicons } from "./core/lexicon.js";
import { BLIND_SPOTS, FREEDOM_SURFACE } from "./core/guard-core.js";
import { detectLang, getLang, getLangSource, pickLang } from "./core/lang.js";
import { DELIVERY_RE, detectViolations, extractAssistantText, hasExplicitExecWord, setCriticismPersonal } from "./core/text-detect.js";
import { buildTurnCard } from "./core/turn-card.js";
import { shouldDetectTurn, shouldDeliver } from "./core/semantic.js";
import { judgeViolation, judgeViolationsBatch } from "./core/judge.js";
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
  parseModeCommand,
  categoryOfCommand
} from "./core/contract.js";
// 0.5.12（F5 批次 3）：契约完成信号判定——install/build 类成功即使命达成
function isNonDestructiveAndComplete(cat) {
  return cat === "install" || cat === "build";
}
import {
  classifyAction,
  detectOverengineeringText,
  isRepeatedTaskAction,
  recordAction
} from "./core/overengineering.js";
import { writeUnderstanding } from "./core/understanding-store.js";
import { labelFingerprint, labelEntry, labelsFilePath, saveLabelsToDisk, upsertLabel } from "./core/label-fingerprint.js";
import { agentsFilePath, auditFilePath, verifyFilePath, toolsWhitelistFilePath, dshHome } from "./core/paths.js";
import { isVersionedFile, validateEditedFile } from "./core/version-guard.js";
import { computeMountSignature, profileNameFromArgs } from "./core/mount-signature.js";
import { detectSilentError, extractToolOutput } from "./core/silent-error.js";
import { enrichRulesWithLlm } from "./core/llm-understander.js";
import { analyzeCoverage } from "./core/understander.js";

export const name = "dsh-rule-engine";
export const inject = ["tools", "commands", "agents", "workspaceRegistry", "skills", "llm"];

const pluginConfig = loadPluginConfig();
// §1.3 行为闸判定（纯函数，2026-09-08 第二批 A″）：批评疑似回合冻结写类工具——返回拒绝原因或 null
export function criticismFreezeDecision(session, toolName, args) {
  if (!session?.turn?.criticismFrozen) return null;
  if (toolClass(toolName, args || {}) !== "mutating") return null;
  return "本回合命中批评/指错疑似信号——写类工具已冻结（A″ 行为闸）。请按四段模板回应：① 停止；② 归因四问；③ 三件套（事实/原因/方案）；④ 等指令。只读操作不受限。";
}
// C4：启动时合并配置层 typeHints（本机扩展授权类型；默认空=仅内置 8+archive 类）
setTypeHints(pluginConfig.typeHints);
// P8 小批 A（2026-09-08）：行为词表配置层注入（rule-engine.json 的 lexicons 键）——
// null/缺省 = 用内置通用最小集；非空 = 按键完全替换（Override 模式，同 setTypeHints）。
// 非法键/非法正则被拒绝并记审计（不静默半套生效）。
{
  const lexRes = setLexicons(pluginConfig.lexicons);
  if (lexRes.rejected.length > 0) {
    audit({
      kind: "lexicon-config-rejected",
      rule: "__lexicon-config",
      name: "词表配置注入：部分键被拒绝",
      event: "startup",
      reason: `lexicons 配置被拒绝的键：${lexRes.rejected.map((r) => `${r.key}(${r.reason})`).join(", ")}；生效键：${lexRes.applied.join(", ") || "无"}`,
      session: "global"
    });
  }
  // P8 小批 B（2026-09-08）：检测正则配置层注入（rule-engine.json 的 patterns 键）——同 Override 语义。
  // 仅覆盖「文本健康检测」类正则（规则 2/5/7/11/16 与 M7 提醒）；命令/路径守卫类正则恒在机制层。
  const patRes = setPatterns(pluginConfig.patterns);
  if (patRes.rejected.length > 0) {
    audit({
      kind: "pattern-config-rejected",
      rule: "__pattern-config",
      name: "检测正则配置注入：部分键被拒绝",
      event: "startup",
      reason: `patterns 配置被拒绝的键：${patRes.rejected.map((r) => `${r.key}(${r.reason})`).join(", ")}；生效键：${patRes.applied.join(", ") || "无"}`,
      session: "global"
    });
  }
}
// §1.3（2026-09-08 第二批）：本机辱骂词表注入（通用发布面恒空——语言无关形态检测恒在）
setCriticismPersonal(pluginConfig.criticismPersonal);
state.enabled = pluginConfig.enabled;
applyTaskContractConfig(state, pluginConfig);
// T3 通用化（2026-08-31）：声明式绑定覆盖表注入（rule-engine.json 可选键 handlerOverrides；缺省 {}）
state.handlerOverrides = pluginConfig?.handlerOverrides || {};
// 残余1 剥离（2026-08-31）：本机默认偏好表注入（rule-engine.json 可选键 handlerDefaultMap；
// 通用部署=空表——代码零本机编号，本机偏好不随包走、升级不丢）
state.handlerDefaultMap = pluginConfig?.handlerDefaultMap || {};
// P2（2026-09-04）：本机集成参数化层（localIntegrations）——默认空=通用行为不变；
// 本机专属约定（统一入口脚本名/M8 双通道/手册路径豁免扩展）由配置注入，代码零本机字面量
state.localIntegrations = pluginConfig?.localIntegrations || {};
// A-8（0.6.0，启动自检硬验收）：localIntegrations 存在但 entryScript 指向的脚本文件在磁盘不存在
// → 启动即审计告警（失败不阻断加载，但留下可观测证据——无声守卫消失风险的对策）
// 0.6.0 修正：裸文件名（无路径段）视为脚本名——可能在工作区/全局 PATH，
// 不告警（防误报）；仅当 entryScript 含明确路径段（\ / 盘符）且文件不存在时才告警。
{
  const li = state.localIntegrations;
  const script = li?.entryScript;
  const isBareName = typeof script === "string" && /^[A-Za-z0-9._-]+$/.test(script.replace(/\\/g, "/"));
  if (typeof script === "string" && script && !isBareName) {
    let found = false;
    try { found = existsSync(script); } catch { found = false; }
    if (!found) {
      audit({
        kind: "entry-script-missing",
        rule: "__entry-script-missing",
        name: "启动自检：统一入口脚本不存在",
        event: "startup",
        reason: `localIntegrations.entryScript 指向的脚本（${script}）在磁盘不存在——本机守卫仍按配置工作，但入口通道可能失效；请检查配置或部署该脚本`,
        session: "global"
      });
    }
  }
}
// li-skipped（0.6.0 A2-2 补充）：无 localIntegrations.entryScript → 启动登记一次 skipped 审计
// （验证"默认无"留痕；登录于启动/配置加载时，而非每次工具调用——修正此前写类分支被 12A 前置拦截的缺陷）
if (!state.localIntegrations?.entryScript) {
  audit({
    kind: "li-skipped",
    rule: "19",
    name: "本地集成未配置（守卫无对象）",
    event: "startup",
    reason: "skipped: no localIntegrations.entryScript——该守卫在此环境不存在（0.6.0 默认无）",
    session: "global"
  });
}
// reloadRules 内部已统一刷新理解产物（P0-3），此处不再重复写
reloadRules(state);
// 第三批第 1 波 §4：首启语言探测——读规则集文本（AGENTS.md 解析结果），含 CJK → zh-CN。
// 仅内存缓存、每次启动重探、不落盘（无配置文件副作用）。影响：报错/提示/自由面/盲区展示语言。
detectLang(state.configs.map((c) => `${c.ruleId} ${c.title}`).join(" "));

// ── 工具函数 ────────────────────────────────────────────────────────────────

/** 统计 substring 出现次数（0.5.11 唯一性前提；与 guard-core countOccurrences 同语义） */
function countOccurrencesStr(text, sub) {
  if (typeof text !== "string" || typeof sub !== "string" || sub.length === 0) return 0;
  let count = 0;
  let idx = text.indexOf(sub);
  while (idx !== -1) {
    count++;
    idx = text.indexOf(sub, idx + sub.length);
  }
  return count;
}

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
 * 从 /guard 命令 invocation 取会话 id（2026-08-31 会话寻址修复）。
 * 官方 CommandInvocation 无 session 字段（只有 commandId/agent/rawInput/attachments/signal），
 * 旧代码 invocation?.session?.id 恒为 undefined → 永远落到 "global"（仅模板），而当前会话的
 * contract 在创建时已快照、不随 global 变化 —— 这是"/guard mode change 放行无效"的根因。
 * 官方类型：Agent.id 与 session.id 是同一身份（"The single identity shared with session"），
 * 收到命令的代理 = 命令发起的会话；裁决侧 sessionIdOfExec 取 exec.agent.session.id —— 两者对齐。
 */
export function sessionIdOfInvocation(invocation) {
  const agent = invocation?.agent;
  if (!agent) return "global";
  if (typeof agent.id === "string" && agent.id) return agent.id;
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
  // D1（2026-08-28 阶段三）：注入文案命令词静态检查——[规则引擎] 注入若含"请直接执行/不要再…
  // 请立即…"类命令式短语，会驱动模型越过用户直接行动（实弹：节流注入后模型跳过用户回复）；
  // 注入只许陈述事实。命中 = 拒绝投递 + 审计留痕（防本次修复被下次改文案时回潮）。
  const INJECT_COMMAND_RE = /请直接执行|请立即|不要再|勿再|请马上|现在就做|立刻执行|直接执行/;
  if (INJECT_COMMAND_RE.test(String(violation?.reason || ""))) {
    audit({
      kind: "inject-command-gated",
      rule: violation.ruleId,
      name: "注入文案命令词拦截（D1）",
      event: "inject",
      reason: `注入文案含命令式短语，已拒绝投递（只许陈述事实）：${String(violation.reason || "").slice(0, 100)}`,
      session: sessionId
    });
    return;
  }
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
        // D2（2026-08-28 阶段三）：不可投递 agent（子代理/已销毁会话）——仅审计降噪留痕，
        // reason 注明"预期降噪"便于 /guard log 区分真实失败；不再产生可见投递噪音。
        audit({ kind: "inject", rule: violation.ruleId, name: "纠正注入", event: "inject", reason: `注入未投递（D2 预期降噪）：agents.get(${sessionId}) 无可用 agent.inject——仅审计留痕`, session: sessionId });
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
  // 0.5.11（用户定稿，预算打穿修复）：一次回复的全部嫌疑 = 一次批量裁决（一次 LLM/一条预算）
  // 此前逐条 judgeViolation（每条一次调用/一条预算）导致 50/日早上耗尽（unavailable 89 条实证）。
  const judgeFn = state.judgeFn || judgeViolation;
  // 注入版/单条路径保持兼容：state.judgeFn（测试 stub）或仅 1 条嫌疑 → 单项路径
  if (suspects.length <= 1 || state.judgeFn) {
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
          session: sessionId,
          verdictSource: "judge"
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
    return;
  }
  // 批量路径：一次 judgeViolationsBatch（一次调用/一次预算/逐条判定）
  const batch = await judgeViolationsBatch(ctx, state, sessionId, suspects, text);
  const deliver = [];
  for (const { violation: v, verdict } of batch) {
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
    if (verdict.action === "deliver") deliver.push(v);
  }
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

/** v0.5.7 后续（用户批准）：unknown 工具白名单持久化（~/.dsh/rule-engine-tools.json——"允许使用 X"重启/热重载不丢）
 *  0.5.9 升级：存储格式 v2 带元数据 [{name,time,session}]——可视化"谁、何时、哪个会话放行"；
 *  旧格式（字符串数组）兼容读取；持久化时合并既有 meta（历史条目不丢时间/来源）。 */
function persistToolWhitelist(state, sid) {
  try {
    const names = [...(state.unknownToolApproved || [])];
    const prev = readWhitelistMeta();
    const rows = mergeWhitelist([...prev.values()], names, sid);
    writeFileSync(toolsWhitelistFilePath(), serializeWhitelist(rows), "utf8");
  } catch {
    // 持久化失败仅降级（内存态仍有效），不阻断
  }
}

/** 读取白名单文件并按元数据归 Map（v1 字符串数组 → {name,time:null,session:null}；v2 对象数组原样） */
function readWhitelistMeta() {
  const m = new Map();
  let raw = null;
  try { raw = readFileSync(toolsWhitelistFilePath(), "utf8"); } catch {}
  for (const row of parseWhitelist(raw || "")) m.set(row.name, row);
  return m;
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
    // M8 双通道机制：本回合用统一入口落盘手册/AGENTS 后，必须同轮 engram_store 沉淀记忆；
    // 缺失 → 审计 + 注入纠正（用户明确要求机制化，2026-08-24）
    // A3-1（0.6.0）：默认关闭 → 显式 enabled:true + 配置 entryMarker 才生效（无配置 = M8 机制整体不存在）
    const m8Cfg = state.localIntegrations?.m8 || {};
    const m8Marker = m8Cfg.entryMarker;
    if (m8Cfg.enabled === true && m8Marker && s.turn.manualWriteSeen && !s.turn.engramStoreSeen) {
      audit({
        kind: "engram-gap",
        rule: "__engram-gap",
        name: "双通道记忆缺失",
        event: "turn/end",
        reason: "本回合经本机配置的统一入口落盘了手册/AGENTS，但未同轮调用 engram_store；按规则 19/77/M8 应在同一回合完成记忆沉淀",
        session: sid
      });
      maybeInject(ctx, sid, {
        ruleId: "__engram-gap",
        reason: "规则 19/M8：手册/AGENTS 落盘后应在同一回合补 engram_store，否则记忆机制断链（已记审计）"
      });
    }
    // F1（2026-08-28 阶段三）：规则 2 时序竞态修复——assistant/message 检测到时间词违规时
    // 不立即投递（Get-Date 工具常在本回合后续步骤才执行，事故实弹：correct 早于 Get-Date 放行），
    // 标记 pendingRule2，turn/end 复核：getDateSeen 已定案——若本回合最终调用过 Get-Date，撤销（不投递）。
    const p2 = s.turn.pendingRule2;
    if (p2) {
      if (s.turn.getDateSeen) {
        audit({
          kind: "rule2-resolved",
          rule: "2",
          name: "规则2回合末复核（已核对）",
          event: "turn/end",
          reason: "回合内最终已调用 Get-Date（getDateSeen=true）——assistant/message 时误报撤销，不投递",
          session: sid
        });
      } else {
        audit({
          kind: "correct",
          rule: "2",
          name: "时间信息须真实（执行等级：B + D）",
          event: "turn/end",
          reason: p2
        });
        maybeInject(ctx, sid, { ruleId: "2", reason: p2 });
      }
      s.turn.pendingRule2 = null;
    }
    // 0.5.15：回合末裁决摘要（卡片后端；生成失败不影响主流程——卡片非硬依赖）
    try {
      s.lastCard = buildTurnCard(s.turn);
      // 0.5.15：登记 closing assistant messageId → 卡片（client assistant-actions 按消息倒查）
      // 2026-09-02：登记即落盘（判例是教学数据，重启不丢）
      const mid = s.turn.lastAssistantMessageId;
      if (mid && s.lastCard) {
        state.cardByMessage.set(mid, { ...s.lastCard, messageId: mid, sessionId: sid });
        if (state.cardByMessage.size > 500) {
          // 防泄漏：仅保留最近 500 条索引（历史太久远的卡片回放无意义）
          const oldest = state.cardByMessage.keys().next().value;
          if (oldest !== undefined) state.cardByMessage.delete(oldest);
        }
        saveTurnCardsToDisk(state);
      }
    } catch {
      // 摘要失败静默（卡片是展示层增强，不阻断回合主流程）
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
      if (isNew) {
        if (!state.unknownToolSessionAdded) state.unknownToolSessionAdded = new Set();
        state.unknownToolSessionAdded.add(toolName); // /guard tools 区分"本会话新增"
      }
      persistToolWhitelist(state, sid); // v0.5.7 后续：白名单持久化（重启/热重载不丢——用户批准"这句不用每次发"）
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
    // A2（阶段一）：promise 记录到 turn——pre-execute 拦截点可同步等待，防"预取未回就按词表拦"竞态
    if (pluginConfig.llmIntent?.enabled) {
      const p = enrichIntentWithLlm(ctx, state, sid, text, pluginConfig.llmIntent);
      s.turn.llmIntentPromise = p;
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
    if (isManualReadTool(toolName, args, state.localIntegrations?.manualExempt?.paths || [])) s.manualReadSeen = true;
    // 规则 5/31 扩展（2026-09-01）：查询类工具调用记下回合号（"近 3 回合有据"判定）
    if (isReadOnlyTool(toolName, args)) s.lastQueryTurn = s.turn.number;
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

    // 0.5.12（F5 批次 3）：任务契约完成自动降级——契约内命令成功（exit 0）且为
    // install/build 完成类 → 契约自动降为 watch（普通判定，不再按契约放行；TTL 不再续期）。
    // 防"契约开着、任务已完、命令还能放行"窗口（最坏情况缓解）。
    try {
      if (state.taskContract?.taskContractEnabled && s.contract && s.contract.mode !== "unconfirmed" && !isError && pendingCall?.name === "pwsh") {
        const cmdText = String(pendingCall.args?.command || "");
        const cat = categoryOfCommand(cmdText);
        if (isNonDestructiveAndComplete(cat)) {
          if (s.contract.mode !== "watch") {
            const prevMode = s.contract.mode;
            s.contract = applyContract(s.contract, { mode: "watch", level: "guard", source: "auto-complete" }).contract;
            audit({
              kind: "task-contract",
              rule: "__task-contract",
              name: "任务契约完成自动降级",
              event: "tool/result",
              reason: `契约内 ${cat} 命令成功（exit 0）→ 自动降级 ${prevMode}→watch（任务完成，契约不再续期）`,
              session: sid
            });
          }
        }
      }
    } catch {
      // 降级失败不阻断主流程（保守：契约维持，TTL 兜底）
    }

    // 0.5.10 建议5（已知坑错误码召回）：错误结果文本命中特征表 → 审计 + 注入指向知识库的提示
    //（本轮去重；仍走 maybeInject 资格链——真实用户在场/预算内才投递，不违反注入噪音治理）
    if (isError) {
      const errText = String(
        resultBlock?.content?.map?.((c) => c?.text || "").join(" ") ||
        d?.message?.content?.map?.((c) => c?.text || "").join(" ") ||
        ""
      );
      const pit = matchKnownPitfall(errText);
      if (pit) {
        if (!s.turn.errorHints) s.turn.errorHints = new Set();
        if (!s.turn.errorHints.has(pit.key)) {
          s.turn.errorHints.add(pit.key);
          audit({
            kind: "error-hint",
            rule: "__error-hint",
            name: "已知坑召回",
            event: "tool/result",
            tool: pendingCall?.name || undefined,
            reason: `${pit.key} 命中特征表（建议5：错误码→知识库）`,
            session: sid
          });
          maybeInject(ctx, sid, { ruleId: "__error-hint", reason: pit.hint });
        }
      }
    }

    // M8 双通道机制（2026-08-24）：统一入口落盘成功 → 标记；同轮 engram_store 成功 → 标记
    // A3-1（0.6.0）：默认关闭 → 显式 enabled:true + 配置 entryMarker 才生效（无配置 = M8 机制整体不存在）
    if (!isError && pendingCall) {
      const cmd = pendingCall.args?.command || pendingCall.args?.code || "";
      const m8Cfg2 = state.localIntegrations?.m8 || {};
      const marker = m8Cfg2.entryMarker;
      if (m8Cfg2.enabled === true && marker && (pendingCall.name === "pwsh" || pendingCall.name === "bash") && cmd.includes(marker)) {
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
        if (auditOutputFailed(output)) {
          audit({
            kind: "mount-audit-fail",
            rule: "27",
            name: "全量审计未通过",
            event: "tool/result",
            reason: "审计脚本发现 DUPLICATES FOUND",
            session: sid,
            tool: pendingCall.name
          });
          maybeInject(ctx, sid, { ruleId: "27", reason: "规则 27：全量审计未通过，先移除多余挂载再重跑审计" });
        } else if (isError) {
          // 2026-08-29 A1：审计命令未执行成功（被规则 22 拦截/工具错误，无审计输出）≠ 审计发现 DUPLICATES——
          // 不注入"先移除多余挂载"（误导：审计根本没执行；历史误报曾引导模型误移除正确挂载）。
          // 保持 dirty（审计未跑成，不知道结果）；留痕 mount-audit-error 供 /guard log 排查。
          audit({
            kind: "mount-audit-error",
            rule: "27",
            name: "审计命令未执行成功",
            event: "tool/result",
            reason: "审计脚本被拦截或执行失败（无审计输出）；请先处理拦截原因后重跑审计",
            session: sid,
            tool: pendingCall.name
          });
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
        // 0.5.11：唯一性透传（与 guard-core 同口径——old 唯一匹配才算"单行重写"放行前提）
        const oldStr = pendingCall.args.old_string || pendingCall.args.old_str || "";
        const uniqueMatch = oldStr.length > 0 ? countOccurrencesStr(pendingCall.originalContent, oldStr) === 1 : false;
        const check = validateEditedFile(
          pendingCall.originalContent,
          current,
          oldStr,
          pendingCall.args.new_string || pendingCall.args.new_str || "",
          uniqueMatch
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
        s.turn.askApproved = true; // 2026-09-06 M7 修复：ask 授权答复 = 本回合已授权（M7 approval-gap 豁免）
        const qText = askQuestionText(pending.questions);
        const selectedText = askResultSelectedText(result);
        // 授权范围只取“问题核心 + 用户实际选择”，不再把全部选项描述纳入；
        // 避免“仅会话内说明/不跨会话保留”等选项说明把一次小授权放大成全局 12h（2026-08-24 修复）
        const scopeText = `${askQuestionCoreText(pending.questions)} ${selectedText}`.trim();
        const pathPrefix = inferPathPrefixFromText(scopeText || qText);
        // 0.5.10 建议1①：ask 答复结构化——操作类型从答复文本推断（write/command/any），不再一律 any
        // （修复"弹窗答复接不住真想操作"的粒度问题——V476AL 同族）
        const authRecord = {
          type: classifyAskScopeType(scopeText || qText),
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
          if (isNew) {
            if (!state.unknownToolSessionAdded) state.unknownToolSessionAdded = new Set();
            state.unknownToolSessionAdded.add(wname);
          }
          persistToolWhitelist(state, sid); // v0.5.7 后续：白名单持久化（见上）
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
      } else if (askResultRejected(result)) {
        // 弹窗消减（2026-08-24）：本回合 ask 被【明确拒绝】（用户点了拒绝/否定词）→ 标记 + 全局记录
        // C3（2026-08-28 阶段二）：未响应/超时/无选择不再记为拒绝——"用户没时间回复"不是拒绝，
        // 旧逻辑把任何未批准都入 askRejections 池 → 5 分钟内再 ask 被节流，用户在忙时反而被烧掉
        // 授权通道（实弹：用户"你也没给我时间回复啊"）。敏感操作仍由 12A 授权证据把关（不降级）。
        s.turn.askRejected = true;
        if (!state.askRejections) state.askRejections = [];
        state.askRejections.push({ sessionId: sid, at: Date.now() });
        if (state.askRejections.length > 200) state.askRejections.splice(0, state.askRejections.length - 200);
        audit({
          kind: "auth-reject",
          rule: "12D",
          name: "ask_user_question 未授权",
          event: "tool/result",
          reason: "用户明确拒绝该授权请求（拒绝词命中，计入节流池）",
          session: sid
        });
      } else {
        // C3：未响应/超时/无明确选择 → 不置 askRejected、不入节流池（仅审计留痕）
        audit({
          kind: "auth-noanswer",
          rule: "12D",
          name: "ask_user_question 未响应",
          event: "tool/result",
          reason: "ask 无结果/未响应（用户可能未及回复）——不计入拒绝节流池；后续可再次询问",
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
    // 0.5.15：记录本回合最后一条 assistant 消息 id（回合末卡片索引锚点；
    // 对 turn/end 来说"最后一条"即 closing——无注入轮干扰，注入轮无卡片需求）
    if (typeof d.message?.id === "string" && d.message.id) {
      s.turn.lastAssistantMessageId = d.message.id;
    }
    // v0.5.7 第 0 站：注入轮（无真实用户消息）不检测不投递——这是乒乓循环的根治：
    // 引擎自己的注入 → 我的回复 → 再检测 的燃料被掐断（实测 2026-08-26 12:37 六圈即此循环）。
    if (!shouldDetectTurn({ realUserSeen: s.turn.realUserSeen })) return;
    // 交付声明机器闸门（机制批 M3，规则 23④）：完成类声明 → 核对同会话 30 分钟内 verify-pass 记录，缺失注入纠正
    // F2（2026-08-28 阶段三）：词面收紧——"完成"裸词太宽（"完成社区检索/尚未完成/正在完成"均误触），
    // 改为强完成声明模式且排除否定/进行态；仍由 LLM 裁决层兜底（deliverSuspects）。
    if (DELIVERY_RE().test(text)) {
      const windowStart = Date.now() - 30 * 60 * 1000;
      const hasPass = (state.verifyPass || []).some((v) => v.sessionId === sid && v.at > windowStart);
      if (!hasPass) {
        audit({
          kind: "verify-gap",
          rule: "23",
          name: "交付声明缺验证闸门记录",
          event: "assistant/message",
          reason: "交付/完成类声明缺少同会话近期 verify-pass（测试全绿或冷加载探针 RESULT: PASS）记录",
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
    // F1（2026-08-28 阶段三）：规则 2 违规不在此时投递——标记 pendingRule2，turn/end 复核（Get-Date 定案）①
    let violations = detectViolations({ configs: state.configs, session: s, text, reasoningText: s.turn.reasoningText, mountRevision: state.mountRevision, rule5Window: pluginConfig.rule5SourceWindow ?? 3 });
    // §1.3 行为闸标记（2026-09-08 第二批 A″）：批评/指错疑似 → 本回合冻结写类工具（turn 级，下回合自动解除）
    const critHit = violations.find((v) => v.mode === "criticism" && v.suspect);
    if (critHit) {
      s.turn.criticismSuspect = critHit.suspect;
      if (critHit.suspect === "strong") {
        s.turn.criticismFrozen = true;
      } else {
        // 弱信号（2026-09-09 第三批后果分级）：不冻结；含执行指令词则仅留痕不提示
        const execDirective = hasExplicitExecWord(s.turn.userText || "");
        if (!execDirective) {
          maybeInject(ctx, sid, {
            ruleId: "22",
            reason: "用户消息疑似批评/质问形态（规则 22②，待确认）：若确属批评——批评不构成任何授权，请先按归因四问产出三件套（事实/原因/方案）再等指令；若只是普通提问可忽略本条"
          });
        }
      }
      audit({
        kind: "criticism-suspect",
        rule: "22",
        name: "批评疑似信号（A″）",
        event: "assistant/message",
        reason: critHit.suspect === "strong" ? "信号=strong——本回合写类工具冻结（A″ 强信号闸）" : "信号=weak——不冻结（后果分级：留痕+提示）",
        session: sid
      });
    }
    const rule2s = violations.filter((v) => v.ruleId === "2");
    for (const v of rule2s) {
      if (!s.turn.pendingRule2) s.turn.pendingRule2 = v.reason;
      violations = violations.filter((x) => x !== v);
    }
    for (const v of violations) {
      audit({
        kind: v.kind,
        rule: v.ruleId,
        name: v.title,
        event: "assistant/message",
        reason: v.reason,
        session: sid,
        // B2（2026-09-03）：判定来源可溯源（判例回灌前置：区分词表直判与 LLM 裁决分流）
        verdictSource: v.awaitingJudge ? "judge" : "lexicon"
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

// ── /guard 子命令单一真源（0.5.13：hint 手写漏 tools 修复）──
// hint（输入框提示）与 USAGE（完整帮助）均由此派生：未来新增子命令只改这一个数组。
const COMMAND_SPECS = [
  { name: "status", args: "", desc: "引擎状态" },
  { name: "rules", args: "", desc: "规则清单 + 理解产物" },
  { name: "active", args: "", desc: "最近激活的规则" },
  { name: "log", args: "[N]", desc: "最近 N 条审计（默认 10）" },
  { name: "unlock", args: "[N]", desc: "解锁配置写保护 N 分钟（默认 10，仅用户）" },
  { name: "bypass", args: "[N]", desc: "临时整体放行 N 分钟（默认 5，仅用户）" },
  { name: "lock", args: "", desc: "立即恢复全部守卫（取消解锁/放行）" },
  { name: "revoke", args: "", desc: "撤销全部授权记录" },
  { name: "tools", args: "", desc: "工具放行白名单（永久+本会话，含时间/来源会话）" },
  { name: "tools revoke", args: "<工具名>", desc: "撤销白名单条目（持久化+会话集）" },
  { name: "reload", args: "", desc: "强制重解析 AGENTS.md" },
  { name: "mode", args: "<模式>", desc: "设置任务契约模式（review/answer/change/monitor/watch/off）" },
  { name: "budget", args: "...", desc: "设置预算（agents=N files=... deps=allow hash=allow）" },
  { name: "contract", args: "", desc: "查看当前任务契约" },
  { name: "contract categories", args: "...", desc: "设定契约类别白名单（0.5.12）" },
  { name: "label", args: "<id> <label>", desc: "给审计记录打标（correct/incorrect/inconclusive）" },
  { name: "approve", args: "<type> <路径> [min]", desc: "物理确认：授予指定类型+路径的临时授权（仅用户输入；默认 10 分钟）" },
  { name: "freedom", args: "", desc: "查看守卫自由面（不拦什么）与盲区（看不见/判不准什么）（第三批 P1-2）" }
];

const USAGE = [
  "用法：",
  ...COMMAND_SPECS.map((s) => `  /guard ${s.name}${s.args ? " " + s.args : ""}  ${s.desc}`),
  "",
  "说明：",
  "  - 守卫 = 硬拦截：违反规则的工具调用直接拒绝，模型无法自行绕过；",
  "  - 解锁/放行只能由你（用户）在对话框输入命令执行，助手无法代替；",
  "  - 每次拦截/纠察都会记录到 " + auditFilePath() + "（/guard log 可查）。"
].join("\n");

// 输入框提示：由子命令清单自动派生（顶层命令名去重，新子命令/别名自动同步）
// eslint-disable-next-line no-unused-vars
const GUARD_HINT = "[" + [...new Set(COMMAND_SPECS.map((s) => s.name.split(" ")[0]))].join("|") + "]";

function parseCommand(rawInput) {
  const text = (rawInput || "").trim();
  if (!text || /^(status|state)$/i.test(text)) return { kind: "status" };
  if (/^(rules|list|ls)$/i.test(text)) return { kind: "rules" };
  if (/^(active)$/i.test(text)) return { kind: "active" };
  // 第三批 P1-2：自由面/盲区查询（parseCommand 是白名单解析器——新子命令必须在此登记，否则落 invalid）
  if (/^(freedom|blindspots|free)$/i.test(text)) return { kind: "freedom" };
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
  if (/^tools$/i.test(text)) return { kind: "tools", action: "list" };
  m = text.match(/^tools revoke\s+([A-Za-z_][A-Za-z0-9_:.-]*)$/i);
  if (m) return { kind: "tools", action: "revoke", target: m[1] };
  if (/^mode\b/i.test(text)) {
    const parsed = parseModeCommand(text);
    if (parsed) return { kind: "mode", ...parsed };
  }
  if (/^budget\b/i.test(text)) {
    const parsed = parseBudgetCommand(text);
    if (parsed) return { kind: "budget", patch: parsed };
  }
  if (/^contract$/i.test(text)) return { kind: "contract" };
  // 0.5.12（F5 批次 3）：/guard contract categories <build,test,install,...> 设定类别白名单
  m = text.match(/^contract\s+categories\s+(.+)$/i);
  if (m) {
    const cats = m[1].split(/[,，\s]+/).map((c) => c.trim().toLowerCase()).filter(Boolean);
    return { kind: "contract-categories", categories: cats };
  }
  m = text.match(/^contract\s+categories\s*$/i);
  if (m) return { kind: "contract-categories", categories: [] };
  m = text.match(/^label\s+(\S+)\s+(correct|incorrect|inconclusive)$/i);
  if (m) return { kind: "label", eventId: m[1], label: m[2].toLowerCase() };
  m = text.match(/^label\s+clear\s+(.+)$/i);
  if (m) return { kind: "label-clear", fingerprint: m[1].trim() };
  // C4：/guard approve <type> <路径> [min]——物理确认（类型在 executeGuard 校验枚举）
  m = text.match(/^approve\s+([A-Za-z_][A-Za-z0-9_-]*)\s*("(?:[^"]*)"|'(?:[^']*)'|\S+)(?:\s+(\d+))?$/i);
  if (m) {
    const p = m[2];
    return {
      kind: "approve",
      type: m[1].toLowerCase(),
      path: p.replace(/^["']|["']$/g, ""),
      minutes: m[3] ? Number(m[3]) : 10
    };
  }
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
      const { dead, uncovered } = analyzeCoverage(state.configs, state.handlerDefaultMap || {});
      const parts = [
        "【规则引擎状态】",
        `  总开关：${state.enabled ? "开启" : "已关闭"}`,
        `  任务契约：${state.taskContract?.taskContractEnabled ? `开启（模式 ${state.taskContract.taskContractMode}｜ask ${state.taskContract.askEnabled ? "开" : "关"}）` : "关闭"}`,
        // 2026-08-31：本会话真实契约（mode/level/预算）——档位（面板）≠ 本会话模式，两者分开展示
        // （旧版只显示档位：用户 "armed" 误以为已放行，实际裁决按会话 mode 走）
        `  本会话契约：${state.taskContract?.taskContractEnabled ? `${contractSummary(getSessionState(state, sessionIdOfInvocation(invocation)).contract)}（会话 ${sessionIdOfInvocation(invocation)}）` : "关闭（总开关未开，命令不生效）"}`,
        `  规则容器：${state.configOk ? `正常（${state.configs.length} 条规则）` : "⚠ " + state.configError}`,
        `  理解置信度：high ${high} / medium ${medium} / low ${low}`,
        `  覆盖自省：${dead.size === 0 && uncovered.length === 0 ? "无缺口" : (dead.size > 0 ? `死映射 ${[...dead.keys()].join("、")}（引擎映射存在但规则已删除，建议清理）` : "") + (uncovered.length > 0 ? `；未覆盖 ${uncovered.map((u) => u.ruleId).join("、")}（${uncovered.map((u) => u.actions.join("+")).join("；")} 但无 handler，规则声明强制但引擎不执行，建议降 D 级或补实现）` : "")}`,
        `  配置加载：${conf.ok ? "正常" : "⚠ " + conf.error}`,
        `  解锁剩余：${fmtRemain(remainMs(state.unlockUntil))}（配置写保护豁免）`,
        `  放行剩余：${fmtRemain(remainMs(state.bypassUntil))}（全部守卫暂停）`,
        `  授权存储：内存态（重启失效）`,
        `  展示语言：${getLang()}（来源 ${getLangSource()}；启动时按 AGENTS.md 语言探测，不落盘）`,
        `  审计日志：${auditFilePath()}`,
        `  LLM 意图判定：${state.llmIntentCfg?.enabled ? `开启（今日 ${[...(state.llmIntentBudget?.values() || [])].reduce((a, b) => a + b, 0)} 次/${pluginConfig.llmIntent?.dailyLimitPerSession ?? 50}，缓存命中 ${state.llmIntentHits || 0}，缓存 ${state.llmIntentCache?.size || 0} 条${state.llmIntentLast ? `；最近：${state.llmIntentLast.text} → ${state.llmIntentLast.source}${state.llmIntentLast.verdict ? `（conf=${state.llmIntentLast.verdict.confidence}）` : "【降级词表】"}` : ""}）` : "关闭"}`,
        `  最近激活：${state.lastActive.length ? state.lastActive.map((a) => a.ruleId).join("、") : "无"}`,
        `  提示：审批策略 never 只关系统审批弹窗，不影响对话内 ask_user_question 授权；规则 12A 仍会硬拦需要授权的操作。`
      ];
      return { kind: "success", text: parts.join("\n") };
    }
    case "freedom": {
      const parts = [pickLang("守卫自由面（无需授权即可执行）：", "Guard freedom surface (no authorization required):"), ""];
      for (const s of FREEDOM_SURFACE) parts.push(`  ✓ ${s}`);
      parts.push("", pickLang("守卫盲区（本引擎看不见/判不准——它不是安全边界）：", "Guard blind spots (invisible/imprecise — this engine is NOT a security boundary):"), "");
      for (const s of BLIND_SPOTS) parts.push(`  ⚠ ${s}`);
      parts.push("", pickLang("提示：被拦时先看拒绝文案里的「放行：…」段——那是本回合的具体放行条件。", "Tip: when blocked, read the \"放行 / how to unblock\" segment in the rejection text — it states this turn's exact unblock condition."));
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
      audit({ kind: "guard-command", rule: "__escape-gate", name: "逃生门请求", event: "command", reason: `/guard unlock ${minutes} 分钟（配置写保护）`, session: sessionIdOfInvocation(invocation) });
      return {
        kind: "success",
        text: `已解锁「配置写保护」${minutes} 分钟。现在可以让助手修改 rule-engine.json / rule-understanding.json / AGENTS.md；改完请执行 /guard lock 或等待自动恢复。`
      };
    }
    case "bypass": {
      const minutes = Math.min(Math.max(1, command.minutes), 60);
      state.bypassUntil = Date.now() + minutes * 60000;
      // 逃生门请求审计（机制批 M1）
      audit({ kind: "guard-command", rule: "__escape-gate", name: "逃生门请求", event: "command", reason: `/guard bypass ${minutes} 分钟（全部守卫）`, session: sessionIdOfInvocation(invocation) });
      return {
        kind: "success",
        text: `已临时放行全部守卫 ${minutes} 分钟。到期自动恢复，也可 /guard reload 后立即恢复。`
      };
    }
    case "approve": {
      // C4（2026-09-03）物理确认：用户亲手输入=词表无法误读；最小范围（类型+路径+时长）；无全局通配
      if (!loadPluginConfig().approveEnabled) {
        return { kind: "error", text: "/guard approve 未开启：请在 rule-engine.json 设 approveEnabled=true（设置页开关随后续版本）后使用" };
      }
      if (!APPROVE_TYPES().includes(command.type)) {
        return { kind: "error", text: `不支持的类型 ${command.type}（可用：${APPROVE_TYPES().join("/")}；any=全局通配被禁止——物理确认必须最小范围）` };
      }
      if (!command.path) return { kind: "error", text: "路径缺失：/guard approve <type> <路径> [min]（建议路径用双引号包裹，如 /guard approve write \"D:\\...\\file.json\" 10）" };
      const minutes = Math.min(Math.max(1, command.minutes), 720);
      const pfx = normalizePath(command.path);
      const sid = sessionIdOfInvocation(invocation);
      recordAuthorization(state, sid, {
        type: command.type,
        pathPrefix: pfx,
        source: "physical-confirm",
        expiresAt: Date.now() + minutes * 60000
      });
      audit({ kind: "guard-command", rule: "__physical-confirm", name: "物理确认授权", event: "command", reason: `/guard approve ${command.type} ${pfx} ${minutes}m`, session: sid });
      return {
        kind: "success",
        text: `已物理确认授权：${command.type}｜${pfx}｜${minutes} 分钟。仅该类型+该路径（含子路径）生效；/guard revoke 可立即撤销；到期自动失效。`
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
        session: sessionIdOfInvocation(invocation)
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
        parts.push(`  [${t}] ${e.kind || "?"}｜规则 ${e.rule || "?"}｜${e.name || ""}${e.errId ? `（ERR-${e.errId}）` : ""}${e.eventId ? `（${e.eventId}）` : ""}`);
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
    case "tools": {
      // v0.5.9：白名单可视化——永久（元数据）+ 本会话新增；revoke = 从持久化文件与会话集移除
      if (command.action === "revoke") {
        const target = command.target;
        const prev = readWhitelistMeta();
        const existed = prev.delete(target);
        writeFileSync(toolsWhitelistFilePath(), JSON.stringify([...prev.values()]), "utf8");
        state.unknownToolApproved?.delete(target);
        state.unknownToolSessionAdded?.delete(target);
        audit({
          kind: "guard-command",
          rule: "__whitelist",
          name: "白名单撤销",
          event: "command",
          reason: `/guard tools revoke ${target}（持久化+会话集同步移除）`,
          session: sessionIdOfInvocation(invocation)
        });
        return { kind: "success", text: `已撤销 ${target}${existed ? "" : "（原不在白名单）"}。` };
      }
      const meta = state.unknownToolApprovedMeta || new Map();
      const sessionAdded = state.unknownToolSessionAdded || new Set();
      const rows = [...(state.unknownToolApproved || [])].map((n) => {
        const m = meta.get(n) || {};
        let when = "未知";
        if (typeof m.time === "number") {
          try { when = new Date(m.time).toISOString(); } catch { when = "非法时间"; }
        }
        return `- ${n}${sessionAdded.has(n) ? "（本会话新增）" : ""} 时间=${when} 来源会话=${m.session || "未知"}`;
      });
      const text = rows.length
        ? `工具放行白名单（/guard tools）：\n${rows.join("\n")}\n\n撤销：/guard tools revoke <工具名>`
        : "工具放行白名单为空。";
      return { kind: "success", text };
    }
    case "mode": {
      if (!state.taskContract?.taskContractEnabled) return { kind: "error", text: "任务契约未启用：请先在规则引擎设置页开启总开关。" };
      const sid = sessionIdOfInvocation(invocation);
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
      const sid = sessionIdOfInvocation(invocation);
      const s = getSessionState(state, sid);
      const res = applyContract(s.contract, { ...command.patch, source: "guard-command" });
      if (res.changed) {
        s.contract = res.contract;
        audit({ kind: "task-contract", rule: "__task-contract", name: "任务预算更新", event: "command", reason: `/guard budget: ${contractSummary(s.contract)}`, session: sid });
      }
      return { kind: "success", text: `任务契约：${contractSummary(s.contract)}` };
    }
    case "contract": {
      const sid = sessionIdOfInvocation(invocation);
      const s = getSessionState(state, sid);
      const enabled = state.taskContract?.taskContractEnabled ? "开启" : "关闭（总开关未开启，命令不生效）";
      return { kind: "success", text: `任务契约（总开关：${enabled}）\n${contractSummary(s.contract)}` };
    }
    case "contract-categories": {
      if (!state.taskContract?.taskContractEnabled) return { kind: "error", text: "任务契约未启用：请先在规则引擎设置页开启总开关。" };
      const sid = sessionIdOfInvocation(invocation);
      const s = getSessionState(state, sid);
      const cats = command.categories;
      if (cats.length === 0) {
        s.contract = applyContract(s.contract, { source: "guard-command" }).contract;
        s.contract.categories = null;
        audit({ kind: "task-contract", rule: "__task-contract", name: "任务契约类别白名单清空", event: "command", reason: `/guard contract categories 清空（恢复不限制类别）`, session: sid });
        return { kind: "success", text: `任务契约：类别白名单已清空（${contractSummary(s.contract)}）` };
      }
      // 破坏类结构性排除：用户设置含 delete/move 等 → 拒绝（不因用户配置而放宽）
      const DESTRUCTIVE = ["delete", "move", "replace", "purge"];
      const bad = cats.filter((c) => DESTRUCTIVE.includes(c));
      if (bad.length) {
        return { kind: "error", text: `破坏类类别（${bad.join(",")}）永不可入契约白名单——任务契约只放行非破坏操作` };
      }
      s.contract = applyContract(s.contract, { source: "guard-command" }).contract;
      s.contract.categories = cats;
      audit({ kind: "task-contract", rule: "__task-contract", name: "任务契约类别白名单设定", event: "command", reason: `/guard contract categories ${cats.join(",")}`, session: sid });
      return { kind: "success", text: `任务契约：类别白名单 = [${cats.join(",")}]（${contractSummary(s.contract)}）` };
    }
    case "label": {
      const entries = readAuditLog(500);
      // E1（2026-08-28 阶段一）：支持 ERR-xxxxxx 短码定位（此前只认 eventId UUID——
      // 用户拿拦截提示里的 ERR 码无法打标，链路断在"两套标识符无映射"）
      const want = String(command.eventId || "").trim();
      const normalized = want.toUpperCase().startsWith("ERR-") ? want.slice(4).toUpperCase() : want;
      const found = entries.find(
        (e) => e.eventId === want || e.errId === normalized || e.errId === want || `ERR-${e.errId}` === want.toUpperCase()
      );
      if (!found) return { kind: "error", text: `未找到审计事件：${command.eventId}（提示：/guard log 可查最近记录；若为旧日志则拦截时未记录 ERR 码）` };
      state.labels.set(found.eventId, command.label);
      // 0.5.12（F2）：incorrect 打标同时写入命令指纹台账（持久化）——同指纹命令后续直接放行
      if (command.label === "incorrect" && (found.tool === "pwsh" || found.tool === "bash")) {
        try {
          const fp = labelFingerprint(JSON.parse(found.args || "{}").command || "");
          if (fp) {
            const sid = sessionIdOfInvocation(invocation);
            state.labelRows = upsertLabel(state.labelRows || [], labelEntry(fp, "incorrect", sid));
            saveLabelsToDisk(labelsFilePath(dshHome()), state.labelRows);
            audit({ kind: "task-label", rule: "__task-contract", name: "审计人工标注", event: "command", reason: `${found.eventId} = ${command.label}（来源 ERR-${found.errId || "?"}）+ 命令指纹放行已记录：${fp.slice(0, 100)}`, session: sid });
            return { kind: "success", text: `已标注 ${found.eventId} = ${command.label}；并记录命令指纹 ${fp.slice(0, 80)}（同指纹命令将放行：/guard label clear <指纹> 撤销）` };
          }
        } catch {
          // 指纹解析失败不阻断打标（保守：只记单条，不记指纹）
        }
      }
      audit({ kind: "task-label", rule: "__task-contract", name: "审计人工标注", event: "command", reason: `${found.eventId} = ${command.label}（来源 ERR-${found.errId || "?"}）`, session: sessionIdOfInvocation(invocation) });
      return { kind: "success", text: `已标注 ${found.eventId} = ${command.label}` };
    }
    case "label-clear": {
      const fp = command.fingerprint;
      const before = (state.labelRows || []).length;
      state.labelRows = (state.labelRows || []).filter((r) => r.fingerprint !== fp);
      saveLabelsToDisk(labelsFilePath(dshHome()), state.labelRows);
      audit({ kind: "task-label", rule: "__task-contract", name: "打标指纹撤销", event: "command", reason: `撤销命令指纹：${fp}（${before} → ${state.labelRows.length} 条）`, session: sessionIdOfInvocation(invocation) });
      return { kind: "success", text: `已撤销命令指纹 ${fp}（剩余 ${state.labelRows.length} 条）` };
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
  // 0.5.9：v2 对象数组（带 meta）与 v1 字符串数组兼容；meta 供 /guard tools 可视化
  try {
    const wlRaw = readFileSync(toolsWhitelistFilePath(), "utf8");
    const rows = parseWhitelist(wlRaw);
    state.unknownToolApproved = new Set(rows.map((r) => r.name));
    state.unknownToolApprovedMeta = new Map(rows.map((r) => [r.name, r]));
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
          const entryScript = state.localIntegrations?.entryScript;
          // A3-2（0.6.0）：入口脚本名从配置读取并转义；无配置不走本分支。
          // 边界裁决（v1.3 关键裁决 4）：正则保持无尾部 \b（保守匹配，xxx.mjs.bak 等变体同样命中）。
          if ((exec?.name === "pwsh" || exec?.name === "bash") && entryScript && new RegExp(`\\b${entryScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(cmd)) {
            const s7 = getSessionState(state, sessionIdOfExec(exec));
            // 2026-09-06 M7 修复：ask 授权答复（turn.askApproved）→ 豁免 approval-gap（12A 授权链已由 ask 建立）
            if (needsApprovalReminder(s7.turn.userText || "", { askApproved: !!s7.turn.askApproved })) {
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
            errId: hit.errId,
            session: sessionIdOfExec(exec) // P0-4：deny 审计补 session（2026-08-24 事故复盘：归属会话靠猜）
          });
          // 0.5.15：本回合 guard 命中缓冲（回合末裁决卡片数据源——全量记，含 __ 内部拦截）
          (() => {
            const sCard = getSessionState(state, sessionIdOfExec(exec));
            (sCard.turn.cardHits ||= []).push({
              tool: exec?.name || "",
              args: summarizeArgs(exec?.arguments || {}),
              ruleId: hit.ruleId,
              title: hit.title,
              reason: hit.reason,
              errId: hit.errId || ""
            });
          })();
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
          // D1（2026-08-28 阶段三）：改**陈述式**——旧文案"请直接执行"是命令，模型照做会越过
          // 用户（实弹：注入后模型跳过用户回复直接执行）；只陈述事实，决策权留给用户。
          if (hit.ruleId === "__already-authorized" || hit.ruleId === "__ask-rejected" || hit.ruleId === "__ask-throttle") {
            maybeInject(ctx, sessionIdOfExec(exec), {
              ruleId: hit.ruleId,
              reason: `${hit.title}（规则 ${hit.ruleId}）：本会话已存在相近授权记录或被拒记录；再次弹窗询问可能无法送达用户。可用普通文本说明。`
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
  // A2（阶段一，2026-08-28）：LLM 意图兜底同步等待——词表判"拦"（denyMutation）时，若 LLM
  // 预取仍在进行（llm-pending），在工具执行前同步等待结果（上限 300ms，超时按词表保守裁决）。
  // 根因：enrichIntentWithLlm 是异步预取，模型先发工具调用往往先于 LLM 返回 → 词表盲区
  // （转化/读取/展示 等未收录词）在拦截点直接判拦，LLM 兜底形同虚设（2026-08-28 实弹）。
  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      const sid2 = sessionIdOfExec(exec);
      const s2 = getSessionState(state, sid2);
      if (s2?.turn?.intentState === "llm-pending" && typeof s2.turn?.llmIntentPromise?.then === "function") {
        await Promise.race([
          s2.turn.llmIntentPromise,
          new Promise((resolve) => setTimeout(resolve, 300))
        ]);
      }
    } catch {
      // 等待失败不阻断：词表裁决兜底
    }
    return next();
  });
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

  // 0.9 机制 B（2026-08-24；0.5.9 修订——K-02/K-03 依据）：未归类工具首调按 unknownPolicy 处置：
  //   "ask"  = 官方 pre-execute ask 语义（approval 弹窗，allowed-once 才续行；无审批通道 → 官方自动 deny，
  //            fail-closed 由官方保证）；"deny" = 物理拒绝 + 提示（"允许使用 X" 会话白名路径恒可用）。
  //   历史教训（08-24 实测 ask 被自动放行 → 当时改 deny）：0.5.9 发布前必须实弹验证 ask 弹窗真实出现
  //   （K-02 门禁），验证不过则发布时默认保持 deny。
  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      if ((state.unknownToolApproved || new Set()).has(exec?.name)) return next(); // 会话内用户已批准
      if (toolClass(exec?.name, exec?.arguments || {}) !== "unknown") return next();
      // 0.5.9：unknownPolicy 默认 "deny"（K-02 门禁：ask 需实弹验证弹窗真实出现后才可默认；
      // 当前无真实 unknown 工具可触发实弹——分类表已全覆盖，等待未来真实场景验证后经配置切换）
      const policy = pluginConfig.unknownPolicy === "ask" ? "ask" : "deny";
      audit({
        kind: "unknown-tool",
        rule: "__unknown-tool",
        name: "未归类工具首调处置",
        event: "tools/pre-execute",
        tool: exec?.name,
        args: summarizeArgs(exec?.arguments),
        reason: `工具 ${exec.name} 不在规则引擎分类表：按 unknownPolicy=${policy} 首调处置（批准路径：官方弹窗批准 / 用户明确"允许使用 ${exec.name}"写入会话白名单；长期规则请补充工具分类表）`,
        session: sessionIdOfExec(exec)
      });
      if (policy === "ask") {
        return {
          kind: "ask",
          reason: `工具 ${exec.name} 未登记在规则引擎分类表：批准本次后放行；如需本会话持续放行请说"允许使用 ${exec.name}"。`
        };
      }
      return {
        kind: "deny",
        reason: `工具 ${exec.name} 尚未归类（新装插件？）：已拦截。如需使用请向用户说明用途并获取其"允许使用 ${exec.name}"的明确答复后重试（批准后本会话内放行）。`
      };
    } catch (error) {
      ctx.logger?.warn?.("[dsh-rule-engine] unknown-tool handling error", error);
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
      // 0.5.12（F5 批次 3）：补命令文本供类别白名单判定（categoryOfCommand 需要）
      action.commandText = exec?.arguments?.command || exec?.arguments?.code || "";
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
        return { kind: "deny", reason: `[guardian:contract] 【硬拦截】${dec.reason}（${dec.reasonCode}｜任务契约｜放行：${dec.nextStep || "请调整契约"}）` };
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
        return { kind: "deny", reason: `[guardian:contract] ${dec.reason}（任务契约｜${dec.nextStep || "请调整契约或停止该操作"}）` };
      }
      return next();
    } catch (error) {
      ctx.logger?.warn?.("[dsh-rule-engine] tools/pre-execute error", error);
      return next();
    }
  });

  // §1.3 行为闸（2026-09-08 第二批 A″）：批评/指错疑似回合 → 冻结全部写类工具（零调用）；
  // 只读/分析类不受限；标记为 turn 级，下一回合自动解除（用户可继续只读工作）。
  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      const sid = sessionIdOfExec(exec);
      const s = getSessionState(state, sid);
      if (!s?.turn?.criticismFrozen) return next();
      const freeze = criticismFreezeDecision(s, exec?.name, exec?.arguments);
      if (!freeze) return next();
      audit({
        kind: "criticism-freeze",
        rule: "22",
        name: "批评回合冻结写类工具",
        event: "tools/pre-execute",
        tool: exec?.name,
        args: summarizeArgs(exec?.arguments),
        reason: `疑似信号=${s.turn.criticismSuspect}（A″ 行为闸：批评不构成授权）`,
        session: sid
      });
      return {
        kind: "deny",
        reason: "[guardian:rule22] 【硬拦截】本回合命中批评/指错疑似信号——写类工具已冻结（A″ 行为闸）。请按四段模板回应：① 停止；② 归因四问；③ 三件套（事实/原因/方案）；④ 等指令。只读操作不受限。"
      };
    } catch (error) {
      ctx.logger?.warn?.("[dsh-rule-engine] criticism-freeze error", error);
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
        input: { hint: GUARD_HINT },
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
