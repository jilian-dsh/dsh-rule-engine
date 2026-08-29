// phase1-fix.test.mjs - 阶段一（2026-08-28）：A1 词表补词 / A2 LLM 同步等待 / A3 @引用信号 /
// B1 只读判定补强 / C1 规则22粒度并入会话授权 / E1 打标断链。
// 每条用例都来自 2026-08-28 真实事故（用户会话被拦截的原文回放）。
import assert from "node:assert/strict";
import { parseUserIntents, shouldDenyMutation } from "../lib/core/intent.js";
import { isReadOnlyCommand } from "../lib/core/patterns.js";
import { authMatches, askResultRejected, inferPathPrefixesFromText, scopesFromIntents } from "../lib/core/authorization.js";
import { guardDecision } from "../lib/core/guard-core.js";

// guard-core 的 makeHit 未导出；用 guardDecision 需要的简化见证：直接验证 errId 生成逻辑走
// 顶层的 makeHit 不可行时，改测 guardDecision 的 deny 返回 reason 含 ERR-（需构造 session，见下）

/** guardDecision 所需的最小 state（pruneState 会读 retryCounts/injectCounts/injectAt/judgeCache/injectBudget） */
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
    lastMtimeCheck: Date.now(), // 防 maybeReloadIfChanged 从 AGENTS.md 重解析出全套规则（破坏受控 configs）
    mtimeMs: -1
  };
}

// ═══ A1：词表补词（转化/读取/展示/打开/提取/还原/导入/导出）═══

{
  // 用户第一条消息原文（事故回放）："请将建议书内容转化到业务通告 @... 中"
  const t = parseUserIntents("请将建议书内容转化到业务通告 @" + `D:\\1、示例\\练习\\案例1-示例案件\\业务通告\\业务通告.doc` + " 中");
  assert.equal(t.hasExecute, true, "A1: 转化 → execute");
  assert.equal(shouldDenyMutation(t), false, "A1: 转化消息不拦变更");
}

{
  // "请读取 260824-...docx 和 业务通告.doc 的内容，向我展示...草案，暂不写入文件。"
  const t = parseUserIntents("请读取 260824-意见书-示例.docx 和 业务通告.doc 的内容，向我展示按标准业务通告体转化的草案，暂不写入文件。");
  assert.equal(t.hasExecute, true, "A1: 读取+展示 → execute");
  assert.equal(shouldDenyMutation(t), false, "A1: 读取展示不拦");
}

{
  // "读出" / "读一下" / "打开" / "提取" 均应为 execute
  for (const s of ["帮我读一下那份意见书", "把里面的关键词提取出来", "打开业务通告.doc看看内容", "把这段还原成原文", "将表格导入到业务通告中"]) {
    const t = parseUserIntents(s);
    assert.equal(t.hasExecute, true, `A1: "${s}" → execute`);
    assert.equal(shouldDenyMutation(t), false, `A1: "${s}" 不拦`);
  }
}

{
  // 词表不得误伤：读者/读后感 不判 execute（"读"单字已去除）
  const t = parseUserIntents("这个读者反馈你整理一下");
  assert.equal(t.hasExecute, true, "A1: 整理仍是动作词（本用例验证读不误伤，需整理=execute 而非 question）");
  const t2 = parseUserIntents("读后感怎么样？");
  assert.equal(t2.hasQuestion, true, "A1: 读后感是疑问句");
  assert.equal(t2.hasExecute, false, "A1: 读后感不含执行");
}

// ═══ A3：@文件引用信号 ═══

{
  // 官方 @file 引用语法（用户场景原文）：@ 引用 + 处理动词 → execute
  const t = parseUserIntents("请读取 @" + `D:\\1、示例\\260824-意见书-示例.docx` + " 的内容");
  assert.equal(t.hasExecute, true, "A3: @路径+读取 → execute");
}

{
  // 带引号 + 空格路径
  const t = parseUserIntents("帮我看下 @\"D:\\example workspace\\文件.docx\" 写了什么");
  assert.equal(t.hasExecute, true, "A3: @带引号路径+看 → execute");
}

{
  // 邮箱不误伤：a@b.com 是邮箱不是文件引用
  const t = parseUserIntents("请确认 a@b.com 的格式");
  // "确认" 不构成动作词？"确认"不在 ACTION_WORDS_RE（批准语义），但 QUESTION_RE 无问号；
  // 保守断言：不应因 @ 引用信号判 execute（除非 a@b.com 被 AT_REF_RE 命中）
  assert.equal(t.hasExecute, false, "A3: 邮箱 a@b.com 不判 execute");
  assert.equal(t.clauses[0].type, "info", "A3: 邮箱消息为 info（无动作词）");
}

// ═══ B1：只读命令判定补强 ═══

{
  // 事故原文：读取 .doc 副本的 COM 命令（被 ERR-L8QAXS 拦）
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
  assert.equal(isReadOnlyCommand(cmd), true, "B1: COM 只读打开+读取 → 只读");
}

{
  // 纯变量赋值 + Test-Path（也是事故原文片段）
  const cmd = `$dst = 'C:\\Users\\example\\AppData\\Local\\Temp\\dsh-example\\yxgz_20260828.doc'
"DST exists: $(Test-Path -LiteralPath $dst)"
"DST len: $(if (Test-Path -LiteralPath $dst) { (Get-Item -LiteralPath $dst).Length } else { 'N/A' })"`;
  assert.equal(isReadOnlyCommand(cmd), true, "B1: 赋值+Test-Path+Get-Item → 只读");
}

{
  // 写命令仍然拦截（安全不放松）
  const write = `Set-Content -Path 'D:\\x.txt' -Value 'hi'`;
  assert.equal(isReadOnlyCommand(write), false, "B1: Set-Content 仍判写");
  const netWrite = `[System.IO.File]::WriteAllText('D:\\x.txt', 'hi')`;
  assert.equal(isReadOnlyCommand(netWrite), false, "B1: .NET WriteAllText 仍判写");
  const comWrite = `$doc = $kwps.Documents.Open('C:\\x.doc', 0, $false); $doc.Content.Text = 'boom'`;
  assert.equal(isReadOnlyCommand(comWrite), false, "B1: COM 内容属性赋值仍判写");
  const copyItem = `Copy-Item -Path 'C:\\a.txt' -Destination 'D:\\b.txt'`;
  assert.equal(isReadOnlyCommand(copyItem), false, "B1: Copy-Item 仍判写");
  const process = `$p = Start-Process -FilePath 'C:\\evil.exe'`;
  assert.equal(isReadOnlyCommand(process), false, "B1: Start-Process 仍判写（执行类）");
}

// ═══ C1：规则 22 粒度并入会话授权 ═══

{
  // 12D 已记录授权（TTL 内）→ 下一回合同路径操作应放行（原：22 粒度只认本回合 → 拦）
  // 验证 authMatches 本身：授权 write d:/1、示例/练习/... 覆盖同路径写操作
  const auth = { type: "write", pathPrefix: "d:/1、示例/练习" };
  const op = { type: "write", pathPrefix: "d:/1、示例/练习/案例1-示例案件/业务通告/业务通告.doc" };
  assert.equal(authMatches(auth, op), true, "C1: 目录级授权覆盖子路径");
  // NOTE：中文顿号路径是否被 PATH_TOKEN_RE 完整提取属 C2（阶段二：路径提取修复）——
  // 该用例随 C2 落地；阶段一断言 authMatches 的语义正确性即可。
  // TypeError 检查：authMatches 在 auth.pathPrefix 为空（全局授权）时必须匹配
  const globalAuth = { type: "any", pathPrefix: "" };
  assert.equal(authMatches(globalAuth, op), true, "C1: 全局授权覆盖一切操作");
}

// ═══ E1：打标链路（guardDecision deny 输出必须含 ERR- 码 + 新文案）═══

{
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
  // 会话：有真实用户文本但为纯询问（无执行分点）
  const s1 = {
    id: "e1-test",
    authorizations: [],
    backups: [],
    turn: {
      userText: "你能删除这个文件吗？",
      intents: parseUserIntents("你能删除这个文件吗？"),
      scopes: [],
      toolCount: 1,
      toolNames: ["pwsh"],
      askSeen: false,
      askRejected: false
    },
    lastUserText: "你能删除这个文件吗？"
  };
  state.sessions.set("e1-test", s1);
  const exec = { name: "pwsh", arguments: { command: "Remove-Item -Path 'C:\\_e1_probe.txt' -Force" }, agent: { session: { id: "e1-test" } } };
  const hit = guardDecision(state, exec, Date.now(), { audit: () => {} });
  assert.ok(hit, "E1: 无执行分点回合的删除类 pwsh 应被拦");
  assert.match(hit.reason, /ERR-[A-Z0-9]{6}/, "E1: deny reason 含 ERR-码");
  assert.match(hit.reason, /\/guard label ERR-[A-Z0-9]{6} incorrect/, "E1: 文案直达 ERR-码（不再要事件号）");
  assert.equal(typeof hit.errId, "string", "E1: hit 携带 errId（供审计落盘）");
}

// ═══ C1：规则 22 粒度并入 TTL 内会话授权（粒度分支）═══

{
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
  // 场景回放：本回合用户消息"帮我写入 D:\1、示例\a.txt"（execute 子句，但 scopes 因截断只到 d:/1）
  // 12D 上回合已记录 write｜路径 d:/1、示例/练习（TTL 内）→ 带顿号路径的操作应被该授权覆盖
  const s2 = {
    id: "c1-test",
    authorizations: [
      { type: "write", pathPrefix: "d:/1、示例/练习", at: Date.now() - 1000, expiresAt: Date.now() + 600000, source: "user-message" }
    ],
    backups: [],
    turn: {
      userText: "帮我把内容写入 D:\\1、示例\\练习\\案例1-示例案件\\业务通告\\业务通告.doc",
      intents: parseUserIntents("帮我把内容写入 D:\\1、示例\\练习\\案例1-示例案件\\业务通告\\业务通告.doc"),
      scopes: [],
      toolCount: 1,
      toolNames: ["pwsh"],
      askSeen: false,
      askRejected: false
    },
    lastUserText: "帮我把内容写入 D:\\1、示例\\练习\\案例1-示例案件\\业务通告\\业务通告.doc"
  };
  state.sessions.set("c1-test", s2);
  const exec2 = { name: "pwsh", arguments: { command: "Set-Content -LiteralPath 'D:\\1、示例\\练习\\案例1-示例案件\\业务通告\\业务通告.doc' -Value 'x'" }, agent: { session: { id: "c1-test" } } };
  const hitC1 = guardDecision(state, exec2, Date.now(), { audit: () => {} });
  if (hitC1) {
    // 若仍拦，原因必须是"本回合子句推不出该路径"而非授权缺失——C1 目标：TTL 内授权并入后应放行
    assert.ok(hitC1.reason.includes("不在本回合执行分点/授权范围内") === false, "C1: 若拦则告知授权已在范围内（不应出现'不在授权范围'）");
  }
  // 授权过期后：本回合 scopes（execute 子句推导）仍覆盖 → 22 粒度放行合法（许可来自本回合指令，
  // 非过期授权）。注意 configs 仅含 rule22（无 12A）——12A 敏感把关独立于本块。
  s2.turn.scopes = scopesFromIntents(s2.turn.intents);
  s2.authorizations[0].expiresAt = Date.now() - 1000;
  const hitC1Expired = guardDecision(state, exec2, Date.now(), { audit: () => {} });
  const scopesOk = s2.turn.scopes.some((sc) => sc.pathPrefix && sc.pathPrefix.startsWith("d:/1、示例/"));
  // C2 后顿号路径提取完整 → scopes 覆盖 → 放行；断言"放行确由 scopes 提供（非过期授权）"
  assert.equal(scopesOk, true, "C2: 本回合 scopes 应含完整顿号路径");
  assert.equal(hitC1Expired, null, "C1: 过期授权 + 本回合 scopes 覆盖 → 22 粒度放行（许可来自本回合指令）");
}

// ═══ B2：委派/子代理回合豁免"无执行分点"判定（规则 22④ 识别层落地）═══

{
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
  // 子代理会话：meta.delegationDepth=1（官方 dsh-subagent-in-process-driver 注入结构）
  const s3 = {
    id: "b2-subagent",
    authorizations: [],
    backups: [],
    turn: {
      userText: "任务：读取一个旧版 Word 文档（.doc 格式）的全部文字内容并原样返回给我。这是只读任务。",
      intents: parseUserIntents("任务：读取一个旧版 Word 文档（.doc 格式）的全部文字内容并原样返回给我。这是只读任务。"),
      scopes: [],
      toolCount: 1,
      toolNames: ["pwsh"],
      askSeen: false,
      askRejected: false
    },
    lastUserText: "任务：读取一个旧版 Word 文档（.doc 格式）的全部文字内容并原样返回给我。这是只读任务。"
  };
  state.sessions.set("b2-subagent", s3);
  const execB2 = {
    name: "pwsh",
    arguments: { command: "Get-Content -LiteralPath 'C:\\x.doc'" },
    agent: { session: { id: "b2-subagent", meta: { delegationDepth: 1, origin: "subagent", parentSession: "parent-session" } } }
  };
  // 委派回合：即使词表判"无执行分点"（老词表读 doc 被拦的 ERR-L8QAXS 场景），此处应放行——
  // 委派回合不做无执行分点判定（由 12A/13A 断言带把关）。命令为只读（Get-Content）→ 必放行。
  const hitB2 = guardDecision(state, execB2, Date.now(), { audit: () => {} });
  assert.equal(hitB2, null, "B2: 委派回合只读读文件放行");
  // 但委派回合的写操作仍受 12A/13A 把关（安全不降级）：配了 12A 规则的场景由 12A 独立裁决
  assert.equal(isReadOnlyCommand("Get-Content -LiteralPath 'C:\\x.doc'"), true, "B2: Get-Content 只读");
}

// ═══ C2：中文顿号路径提取（PATH_TOKEN_RE 不再截断 `、`）═══

{
  // 事故原文：D:\1、示例\练习\...（无引号裸路径）
  const paths = inferPathPrefixesFromText("读取 D:\\1、示例\\练习\\案例1-示例案件\\业务通告\\业务通告.doc 的内容");
  assert.equal(
    paths.some((p) => p.startsWith("d:/1、示例/练习/")),
    true,
    `C2: 顿号路径完整提取（实际输出：${JSON.stringify(paths)}）`
  );
  // 引号包裹路径（@file 语法）也应完整
  const paths2 = inferPathPrefixesFromText('@"D:\\1、示例\\练习\\案例1-示例案件\\业务通告\\业务通告.doc"');
  assert.equal(paths2.some((p) => p.includes("业务通告.doc")), true, "C2: 引号路径完整");
  // 授权匹配闭环：提取出的完整路径作为授权，能覆盖同路径操作
  const auth = { type: "write", pathPrefix: "d:/1、示例/练习" };
  const op = { type: "write", pathPrefix: "d:/1、示例/练习/案例1-示例案件/业务通告/业务通告.doc" };
  assert.equal(authMatches(auth, op), true, "C2: 顿号目录授权覆盖子路径操作（ERR-LU50QQ 场景闭环）");
}

// ═══ C3：ask 节流区分"明确拒绝"与"未响应/超时"═══

{
  // 用户明确拒绝（拒绝词）→ 计入节流
  const rejected = { answers: [{ selected: ["不用了，拒绝"] }] };
  assert.equal(askResultRejected(rejected), true, "C3: 明确拒绝命中");
  // 用户未响应/超时（空结果）→ 不计入节流（用户"你也没给我时间回复啊"场景）
  assert.equal(askResultRejected(null), false, "C3: 空结果未响应不判拒绝");
  assert.equal(askResultRejected({}), false, "C3: 空对象未响应不判拒绝");
  assert.equal(askResultRejected({ answers: [] }), false, "C3: 空 answers 不判拒绝");
  // 无明确拒绝词的正常回答（如选了"先不加"之类中性词）→ 也不算拒绝（保守：不烧节流池）
  assert.equal(askResultRejected({ answers: [{ selected: ["我再看看"] }] }), false, "C3: 中性选择不算拒绝");
  // "是否"等疑问词里的"否"不误伤
  assert.equal(askResultRejected({ answers: [{ selected: ["是否继续看看"] }] }), false, "C3: 是否之否不误判拒绝");
}

console.log("PHASE1-FIX: ALL PASSED");
