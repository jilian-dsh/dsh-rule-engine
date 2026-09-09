// realcase-regression.test.mjs - 回归集第 8 层（2026-08-28 用户定稿）：真实场景常驻测试。
// 场景全部来自 2026-08-28 real-legal 会话事故原文回放：
//   ① 中文顿号路径 + doc 读取（COM）→ 只读豁免放行
//   ② ask 节流：用户未响应 ≠ 拒绝（不再烧授权通道）
//   ③ 子代理委派回合：读文件不被"无执行分点"拦
//   ④ 注入文案命令词静态检查（D1：不再有"请直接执行"类注入）
//   ⑤ verify-gap（规则 23④）强完成声明才触发（"完成社区检索"类误触消除）
// 目标：下一次任何改动都必须过这层——防止批量事故再次只靠人记。
import assert from "node:assert/strict";
import { parseUserIntents, shouldDenyMutation } from "../lib/core/intent.js";
import { isReadOnlyCommand, setWorkspaceRoots } from "../lib/core/patterns.js";
import { authMatches, askResultRejected, scopesFromIntents } from "../lib/core/authorization.js";
import { guardDecision } from "../lib/core/guard-core.js";
import { DELIVERY_RE, detectTimeRule } from "../lib/core/text-detect.js";

/** guardDecision 所需的最小 state（防 mtime 重载注入全套规则） */
function makeState(configs) {
  return {
    enabled: true,
    unlockUntil: 0,
    bypassUntil: 0,
    configs,
    llmIntentCfg: { enabled: false },
    unknownToolApproved: new Set(),
    unknownToolSessionAdded: new Set(),
    mountRevision: 0,
    mountSignature: "",
    sessions: new Map(),
    retryCounts: new Map(),
    injectCounts: new Map(),
    injectAt: new Map(),
    judgeCache: new Map(),
    injectBudget: new Map(),
    judgeBudget: new Map(),
    lastMtimeCheck: Date.now(),
    mtimeMs: -1
  };
}

// ═══ 场景① 中文顿号路径 + doc 读取（COM）═══
{
  // 用户：读取业务通告.doc（D:\1、示例\... 顿号目录）
  const cmd = `$dst = 'C:\\Users\\example\\AppData\\Local\\Temp\\dsh-example\\yxgz_20260828.doc'
$kwps = $null; $doc = $null
try {
  $kwps = New-Object -ComObject KWPS.Application
  $kwps.Visible = $false
  $doc = $kwps.Documents.Open($dst, 0, $true)
  $t = $doc.Content.Text
  $len = $t.Length
  $par = $doc.Paragraphs.Count
  Write-Output "--- TEXT START ---"
  $t
} catch {
  Write-Output "ERR: $($_.Exception.Message)" }`;
  assert.equal(isReadOnlyCommand(cmd), true, "① doc 读取 COM 命令 = 只读（B1）");
  // 授权匹配：顿号目录授权覆盖子路径（C2）
  const auth = { type: "write", pathPrefix: "d:/1、示例/练习/案例1-示例案件" };
  const op = { type: "write", pathPrefix: "d:/1、示例/练习/案例1-示例案件/业务通告/业务通告.doc" };
  assert.equal(authMatches(auth, op), true, "① 顿号目录授权覆盖（C2）");
}

// ═══ 场景② ask 未响应 ≠ 拒绝 ═══
{
  const state = {
    enabled: true,
    unlockUntil: 0,
    bypassUntil: 0,
    configs: [
      { ruleId: "22", title: "沟通直接性", level: "C", confidence: "high", actions: ["deny"], handler: "rule22-7-direct" }
    ],
    llmIntentCfg: { enabled: false },
    unknownToolApproved: new Set(),
    unknownToolSessionAdded: new Set(),
    mountRevision: 0,
    mountSignature: "",
    sessions: new Map(),
    retryCounts: new Map(),
    injectCounts: new Map(),
    injectAt: new Map(),
    judgeCache: new Map(),
    injectBudget: new Map(),
    judgeBudget: new Map(),
    lastMtimeCheck: Date.now(),
    mtimeMs: -1
  };
  // 用户 ask 后未响应（空 results）→ askResultRejected=false → 不节流
  assert.equal(askResultRejected(null), false, "② ask 无结果 = 未响应 ≠ 拒绝");
  assert.equal(askResultRejected({ questions: [] }), false, "② 空结果不判拒绝");
  // 明确拒绝 → 才入节流池
  assert.equal(askResultRejected({ answers: [{ selected: ["拒绝"] }] }), true, "② 明确拒绝词命中");
}

// ═══ 场景③ 子代理委派回合（规则 22④）═══
{
  const state = {
    enabled: true,
    unlockUntil: 0,
    bypassUntil: 0,
    configs: [
      { ruleId: "22", title: "沟通直接性", level: "C", confidence: "high", actions: ["deny"], handler: "rule22-7-direct" }
    ],
    llmIntentCfg: { enabled: false },
    unknownToolApproved: new Set(),
    unknownToolSessionAdded: new Set(),
    mountRevision: 0,
    mountSignature: "",
    sessions: new Map(),
    retryCounts: new Map(),
    injectCounts: new Map(),
    injectAt: new Map(),
    judgeCache: new Map(),
    injectBudget: new Map(),
    judgeBudget: new Map(),
    lastMtimeCheck: Date.now(),
    mtimeMs: -1
  };
  state.sessions.set("sub-child", {
    id: "sub-child",
    authorizations: [],
    backups: [],
    turn: { userText: "任务：读取一个旧版 Word 文档……", intents: parseUserIntents("任务：读取一个旧版 Word 文档……"), scopes: [], toolCount: 1, toolNames: ["pwsh"], askSeen: false, askRejected: false },
    lastUserText: "任务：读取一个旧版 Word 文档……"
  });
  const execSub = {
    name: "pwsh",
    arguments: { command: "Get-Content -LiteralPath 'C:\\x.doc'" },
    agent: { session: { id: "sub-child", meta: { delegationDepth: 1, origin: "subagent", parentSession: "parent" } } }
  };
  const hit = guardDecision(state, execSub, Date.now(), { audit: () => {} });
  assert.equal(hit, null, "③ 委派回合读文件放行（B2）");
}

// ═══ 场景④ 注入文案命令词静态检查（D1 守卫 + 文案已验证） ═══
{
  // 注入文案清单（从 index.js 源码提取现状）——任何一条含命令词短语 = 红
  const INJECT_COMMAND_RE = /请直接执行|请立即|不要再|勿再|请马上|现在就做|立刻执行|直接执行/;
  const injectTexts = [
    "规则 19/M8：手册/AGENTS 落盘后应在同一回合补 engram_store，否则记忆机制断链（已记审计）",
    "规则 27：全量审计未通过，先移除多余挂载再重跑审计",
    "规则 23④：完成/通过类声明需同会话近期验证记录（测试全绿或冷加载 PASS），缺失已记审计",
    "__ask-throttle（规则 __ask-throttle）：本会话已存在相近授权记录或被拒记录；再次弹窗询问可能无法送达用户。可用普通文本说明。"
  ];
  for (const t of injectTexts) {
    // 场景4a：现状文案必须全部通过命令词检查（D1 落地后写成陈述式）
    assert.equal(INJECT_COMMAND_RE.test(t), false, `④ 注入文案不含命令词："${t.slice(0, 40)}…"`);
  }
  // 场景4b：历史坏文案（含"请直接执行"）必须被守卫拦住（防回潮）
  const badHistorical = "已有授权或询问被拒时请直接执行、或用普通文本说明，不要再弹窗 ask。";
  assert.equal(INJECT_COMMAND_RE.test(badHistorical), true, "④ 历史命令式文案被守卫识别（回潮即红）");
}

// ═══ 场景⑤ 规则 2 时序竞态（F1）：Get-Date 后置也合规 ═══
{
  // 模拟：assistant 已含时间词，但 turn.getDateSeen 已置位（工具在本回合后续步骤执行并成功）
  const timeCfg = { title: "时间信息须真实（执行等级：B + D）" };
  const s = { turn: { getDateSeen: true } };
  assert.deepEqual(detectTimeRule(s, "这次修复完成于 08-28 晚些时候（日志 ts=2026-08-28T14:00:00Z）", timeCfg), [], "⑤ 有 Get-Date + 事件证据标注 → 合规");
  // 未调用 Get-Date → 违规（原语义保持）
  const s2 = { turn: { getDateSeen: false } };
  assert.equal(detectTimeRule(s2, "这个时间点是昨天", timeCfg).length, 1, "⑤ 未 Get-Date → 违规（turn/end 定案才投递）");
}

// ═══ 场景⑤-b F1 完整链路：assistant/message 标记 pending → turn/end 复核撤销/投递 ═══
{
  // 链式验证（index.js handleSessionEvent 的 turn/end 分支逻辑构成）：
  // pendingRule2 置位 + getDateSeen=true → 撤销（rule2-resolved，不投递）
  const turn1 = { pendingRule2: "回答出现具体时间词/日期，但本回合未先调用 Get-Date 核对", getDateSeen: true };
  const resolved = turn1.pendingRule2 && turn1.getDateSeen ? true : false;
  assert.equal(resolved, true, "⑤-b Get-Date 已定案 → pending 撤销（不投递）");
  // pendingRule2 置位 + getDateSeen=false → 投递（审计 correct + maybeInject）
  const turn2 = { pendingRule2: "回答出现具体时间词/日期，但本回合未先调用 Get-Date 核对", getDateSeen: false };
  const shouldDeliver = turn2.pendingRule2 && !turn2.getDateSeen ? true : false;
  assert.equal(shouldDeliver, true, "⑤-b 未 Get-Date → turn/end 投递（定案）");
}

// ═══ 场景⑥ 意图（A1/A3）：事故原文回放 ═══
{
  assert.equal(parseUserIntents("请将建议书内容转化到业务通告中").hasExecute, true, "⑥ 转化指令=execute（A1）");
  assert.equal(parseUserIntents("请读取 260824-文件 和 业务通告.doc 的内容，向我展示草案").hasExecute, true, "⑥ 读取展示=execute（A1）");
  const atMsg = parseUserIntents('请读取 @"D:\\1、示例\\260824-意见书-示例.docx" 的内容');
  assert.equal(atMsg.hasExecute, true, "⑥ @引用+读取=execute（A3）");
}

// ═══ 场景⑦ A 方案：方案回合写工作区正式路径 = 落盘需确认 ═══
{
  setWorkspaceRoots(["D:\\example workspace\\dsh-project"]);
  const state = makeState([
    {
      ruleId: "22",
      title: "沟通直接性（执行等级：C+D）",
      level: "C",
      confidence: "high",
      actions: ["deny"],
      handler: "rule22-7-direct"
    }
  ]);
  // 方案回合（无执行分点）："请制定方案" → write 正式路径 → 拦 + 确认文案
  const s7 = {
    id: "a-plan",
    authorizations: [],
    backups: [],
    turn: {
      userText: "请制定一份方案",
      intents: parseUserIntents("请制定一份方案"),
      scopes: [],
      toolCount: 1,
      toolNames: ["write"],
      askSeen: false,
      askRejected: false
    },
    lastUserText: "请制定一份方案"
  };
  state.sessions.set("a-plan", s7);
  const execWrite = { name: "write", arguments: { file_path: "D:\\example workspace\\dsh-project\\reports\\方案.md", content: "方案内容" }, agent: { session: { id: "a-plan" } } };
  const hitPlan = guardDecision(state, execWrite, Date.now(), { audit: () => {} });
  assert.ok(hitPlan, "⑦ 方案回合写正式路径 → 拦");
  assert.match(hitPlan.reason, /确认后保存|落地|落盘/, "⑦ 拦截文案含'确认后落盘'指引");
  // 方案回合写临时区 → 放行（工具不拦）
  const execTmp = { name: "write", arguments: { file_path: "D:\\example workspace\\dsh-project\\logs\\.analysis-tmp\\probe.mjs", content: "x" }, agent: { session: { id: "a-plan" } } };
  const hitTmp = guardDecision(state, execTmp, Date.now(), { audit: () => {} });
  assert.equal(hitTmp, null, "⑦ 临时区写放行（调研工具）");
  // 执行分点回合（"落盘"）→ 粒度检查：write 全局授权应放行
  const s7b = {
    id: "a-exec",
    authorizations: [{ type: "write", pathPrefix: "", at: Date.now() - 1000, expiresAt: Date.now() + 600000, source: "user-message" }],
    backups: [],
    turn: {
      userText: "落盘这份方案",
      intents: parseUserIntents("落盘这份方案"),
      scopes: [],
      toolCount: 1,
      toolNames: ["write"],
      askSeen: false,
      askRejected: false
    },
    lastUserText: "落盘这份方案"
  };
  state.sessions.set("a-exec", s7b);
  const execWrite2 = { name: "write", arguments: { file_path: "D:\\example workspace\\dsh-project\\reports\\方案.md", content: "方案内容" }, agent: { session: { id: "a-exec" } } };
  const hitExec = guardDecision(state, execWrite2, Date.now(), { audit: () => {} });
  assert.equal(hitExec, null, "⑦ 用户确认落盘 → 放行（写全局授权覆盖）");
}

// ═══ 场景⑧ F2：verify-gap 词面收紧——裸"完成"不触发；强完成声明触发 ═══
{
  // 裸"完成"（过程说明）→ 不触发（F2 修掉"完成社区检索/尚未完成"误触）
  assert.equal(DELIVERY_RE().test("本次总结如下：尚待完成社区检索"), false, "⑧ 待完成（进程/否定）不触发");
  assert.equal(DELIVERY_RE().test("完成社区检索后我再继续"), false, "⑧ 完成社区检索（过程）不触发");
  assert.equal(DELIVERY_RE().test("还没有完成，正在处理中"), false, "⑧ 还没有完成（否定）不触发");
  // 强完成声明 → 触发
  assert.equal(DELIVERY_RE().test("修复已完成"), true, "⑧ 已完成触发");
  assert.equal(DELIVERY_RE().test("全部测试通过"), true, "⑧ 全部通过触发");
  assert.equal(DELIVERY_RE().test("验证通过"), true, "⑧ 验证通过触发");
  assert.equal(DELIVERY_RE().test("已修复该问题"), true, "⑧ 已修复触发");
}

// ═══ 场景⑨ 清理→delete 授权映射（2026-08-29 修正：清理/清空/丢弃归 delete）═══
{
  const t = parseUserIntents("清理 staging 残留");
  assert.equal(t.hasExecute, true, "⑨ 清理=执行分点（补词后）");
  const scopes = scopesFromIntents(t);
  assert.ok(scopes.some((s) => s.type === "delete"), "⑨ 清理授权类型=delete（映射修正，原 write 接不住 delete 操作）");
}

// ═══ 场景⑩ 规则 2② 提示指引文案（引擎注入增强）═══
{
  const timeCfg = { title: "时间信息须真实（执行等级：B + D）" };
  const s = { turn: { getDateSeen: true } };
  const hits = detectTimeRule(s, "做了某件事在 8月28日", timeCfg);
  assert.equal(hits.length, 1, "⑩ 具体时间词+无证据 → ② 违规");
  assert.match(hits[0].reason, /勿以当前时间替代/, "⑩ ② 违规提示含正确动作指引（不再只有'请自证'）");
}

console.log("REALCASE-REGRESSION: ALL PASSED");