// run-all.mjs - 依次运行全部单测（.mjs 化：避免 .js 被 Windows 脚本主机误打开弹窗）
import { useChineseLexicons, useChinesePatterns, useChineseTypeHints, useChineseVerbHints, useChineseScopeMarkers, useChineseRetryExempt, useChineseNaturalMode, useChineseInjectCommand, useChineseWhitelistAllow } from "./helpers.mjs";

// P8 小批 A/B（2026-09-08）：内置词表与检测正则已改为通用最小集（语言无关，随包发布）——
// 本仓库回归测试全部基于中文样本，故入口统一注入中文夹具（等价于本机 rule-engine.json 的
// lexicons / patterns 键）。必须在任何动态 import 之前执行：两者都是模块级状态。
{
  const res = useChineseLexicons();
  if (res.rejected.length > 0) {
    console.error("词表夹具注入失败:", JSON.stringify(res.rejected));
    process.exit(1);
  }
  const pres = useChinesePatterns();
  if (pres.rejected.length > 0) {
    console.error("检测正则夹具注入失败:", JSON.stringify(pres.rejected));
    process.exit(1);
  }
  useChineseTypeHints(); // 授权类型提示夹具（setTypeHints 无返回值 → 无 rejected 明细可查）
  useChineseVerbHints(); // 动作词表夹具（setVerbTypes／setVerbRe 亦无返回值）
  useChineseScopeMarkers(); // 范围标记夹具（setDelegationMarker／setSessionWide 亦无返回值）
  useChineseRetryExempt(); // 重试豁免词夹具（setRetryExempt 亦无返回值）
  useChineseNaturalMode(); // naturalMode 五键夹具（setNaturalMode 亦无返回值）
  useChineseInjectCommand(); // 注入文案命令词夹具（setInjectCommand 亦无返回值）
  useChineseWhitelistAllow(); // 白名单口令夹具（setWhitelistAllow 亦无返回值）
}

const tests = [
  "./parser.test.mjs",
  "./understander.test.mjs",
  "./authorization.test.mjs",
  // 域 2 第一枪（2026-09-21）：第二份许可词并入 lexicon.approval——独有词仍真 + 「行」有意分叉 + approval_exec 不随迁
  "./authorization-approval-merge.test.mjs",
  "./intent.test.mjs",
  "./guard.test.mjs",
  "./text-detect.test.mjs",
  "./version-guard.test.mjs",
  "./patterns.test.mjs",
  // B1 热词学习（2026-08-29）：自设 DSH_HOME + 动态 import（hotwords/intent 均运行时读 env）——守住 patterns 后、guard 前
  "./hotwords.test.mjs",
  "./consistency.test.mjs",
  "./silent-error.test.mjs",
  "./requirements-baseline.test.mjs",
  "./observability.test.mjs",
  "./phase1-granular.test.mjs",
  "./llm-understander.test.mjs",
  "./llm-intent.test.mjs",
  "./session-event.test.mjs",
  "./state.test.mjs",
  "./audit.test.mjs",
  "./contract.test.mjs",
  "./overengineering.test.mjs",
  "./task-contract-guard.test.mjs",
  "./consistency-live.test.mjs",
  "./runtime-smoke.mjs",
  // 官方事件结构集成测试置末尾：runtime-smoke 依赖"第一个动态 import index.js"
  //（自设 DSH_HOME 后加载）；本文件自包含规则集，放最后不受 ESM 模块缓存影响。
  "./session-events.integration.test.mjs",
  // phase1b 机制测试：自设 DSH_HOME + 自包含规则集 + import index.js——固定放最后（同缓存前提）
  "./phase1b-mechanism.test.mjs",
  // phase1c 批次 3 ask 链安全精化：同 phase1b 前提（自设 DSH_HOME + import index.js）——保持末尾
  "./phase1c-safechannel.test.mjs",
  // phase1d 批次 4 默认武装：纯函数测试（不 import index.js，安全位置）
  "./phase1d-armed.test.mjs",
  // phase1e 批次 5 文本健康：纯函数测试（不 import index.js）
  "./phase1e-texthealth.test.mjs",
  // phase1f O1 注入通道修复（批次 6）：同 session-events/phase1b/1c 前提（自设 DSH_HOME + import index.js）——保持末尾
  "./phase1f-inject.test.mjs",
  // v0.5.7 投递资格语义层：纯函数测试（不 import index.js，安全位置）——固定末尾（踩坑 83 ESM 缓存约定）
  "./semantic-gate.test.mjs",
  // v0.5.9 白名单 v2 存储格式：纯函数（不 import index.js）——紧随 semantic-gate 之后
  "./whitelist.test.mjs",
  // v0.5.10 分析通道/写类判定/已知坑召回：纯函数（不 import index.js）——固定末尾
  "./analysis-channel.test.mjs",
  // v0.5.10 建议1① ask 答复结构化：纯函数（authorization 依赖）——固定末尾
  "./classify-ask.test.mjs",
  // v0.5.11 规则 24 守卫链覆盖（跨工具一致性）：纯函数（自设 DSH_HOME，不 import index.js）——固定末尾
  "./guardchain-coverage.test.mjs",
  // v0.5.12 阶段一（2026-08-28）：A1 词表/A3 @引用/B1 只读/C1 授权统一/E1 打标——纯函数 + guardDecision 集成
  "./phase1-fix.test.mjs",
  // v0.5.13 阶段二+三：B2 委派/C2 中文路径/C3 ask 节流/D1-D3 注入/F1 规则2/F2 verify-gap 回归
  "./realcase-regression.test.mjs",
  // v0.5.12（F2 打标指纹，2026-08-30）：纯函数（label-fingerprint 独立无 index 依赖）——固定末尾
  "./label-fingerprint.test.mjs",
  // v0.5.12（F5 契约类别白名单，2026-08-30）：纯函数（contract 依赖）——固定末尾
  "./contract-categories.test.mjs",
  // T2 会话寻址（2026-08-31）：自设 DSH_HOME + import index.js（同 phase1b 缓存前提）——固定末尾
  "./session-addressing.test.mjs",
  // 分点级判定回归（2026-08-31，柱子 A/B/C）：用户三点消息锁定/条件句/对象锚定——纯函数，固定末尾
  "./clause-point-regression.test.mjs",
  // 回合末裁决摘要（0.5.15，turn-card）：纯函数，固定末尾
  "./turn-card.test.mjs",
  // Remote 签名一致性（2026-09-02）：client TYPERT_REMOTE 描述符参数 == host 方法签名参数
  // （rateTurnCard 加 blockIndex 漏改 client 致 expected 3 got 4 / [object Object]——两端同步锁定）
  "./remote-signature-consistency.test.mjs",
  // 判例登记链路（0.5.15，block 级/一次性/持久化）
  "./turn-card-verdict.test.mjs",
  // C4（2026-09-03）：物理确认类型/配置化 setTypeHints——纯函数，固定末尾
  "./approve.test.mjs",
  // P8 小批 A（2026-09-08）：词表配置化等价性 + 双层模型（自注入/自重置，纯函数）——固定末尾
  "./lexicon-config.test.mjs",
  // P8 小批 B（2026-09-08）：检测正则配置化等价性 + 双层模型（自注入/自重置，纯函数）——固定末尾
  "./patterns-config.test.mjs",
  // P8 小批 C（2026-09-08）：A″ 批评检测配置化 + 三态（含行为闸冻结，动态 import index.js）——固定末尾
  "./criticism-config.test.mjs",
  // 第三批小批 B 第一小域（2026-09-09）：text-detect/matcher 22 键 + self_cert_hints 映射等价性——固定末尾
  "./detect-config.test.mjs",
  // 第三批质量账本（2026-09-09）：签名确定性/落盘格式/窗口对比/默认关——固定末尾
  "./quality-ledger.test.mjs",
  // C4（批 3，2026-09-15）：/guard quality 查询入口（解析白名单 + COMMAND_SPECS 单一真源登记）——固定末尾
  "./guard-quality.test.mjs",
  // 第三批第 1 波（2026-09-09）：首启语言探测（纯函数）——固定末尾
  "./lang.test.mjs",
  // 第三批清淤 1a（2026-09-09）：文案层机制（取词/覆盖/插值/缺键可见）——固定末尾
  "./messages.test.mjs",
  // （2026-09-11 分层迁移：dualtrack --init 覆盖保护 / 工具目录分隔符兼容 / 判据 D 规则号门禁
  //  三项测试随其被测脚本（dualtrack-check.mjs、check-tool-coverage.mjs）一并迁出引擎包 →
  //  dsh-project/scripts/tests/（个人层——被测对象是维护者门禁脚本，不属通用层，不随发布物））
  // 分层架构 v3 · P1（2026-09-10）：措施类型注册表 + 旧名/kind 行为等价（纯函数）——固定末尾
  "./measure-kinds.test.mjs",
  // D2 修复（2026-09-10）：待决 ask 跨回合存活 + 授权登记（独立 DSH_HOME 试点反馈 ERR-M9Z47H）——固定末尾
  "./ask-pending-survives-turn.test.mjs",
  // B1+C1（2026-09-10）：官方 bundle 豁免 + 装配不一致死循环的收敛豁免——固定末尾
  "./b1c1-convergence.test.mjs",
  // D（2026-09-13）：M8 提示前移到 tool/result（自设 DSH_HOME + import index.js）——固定末尾
  "./m8-hint.test.mjs",
  // (c) 格式描述对象配置化（2026-09-21）：五处格式预设等价性 + 双层模型 + 拒绝面（纯函数，自注入/自重置）——固定末尾
  "./formats-config.test.mjs",
  // 第三批 hint 判定词迁配置层（2026-09-21）：hint_checks 映射键等价性 + 理解器 hints 集成（自注入/自重置）——固定末尾
  "./hint-checks-config.test.mjs",
  // 第三批 分点级意图判定词迁配置层（2026-09-21）：intent_checks 九子键等价性 + parseUserIntents 全产物——固定末尾
  "./intent-checks-config.test.mjs",
  // 第三批 过度工程/重复打转判定词迁配置层（2026-09-21）：overeng_checks 四子键等价性 + AND/NOT + 缓存活性——固定末尾
  "./overeng-checks-config.test.mjs",
  // 第三批 版本守卫判定词迁配置层（2026-09-21）：version_guard_checks 两子键等价性 + lineAnchor 同号放行/不同号拦截——固定末尾
  "./version-guard-checks-config.test.mjs",
  // 第三批 自证标记判定词迁配置层（2026-09-21）：self_cert_checks 两子键等价性 + 拼装公式 + 缓存活性——固定末尾
  "./self-cert-checks-config.test.mjs",
  // 域 2 第三枪（2026-09-22）：动作词表配置化等价性 + R6④ 精确配对 + 自注入/自重置——固定末尾
  "./verb-config.test.mjs",
  // 域 2 第四枪（2026-09-22）：范围标记（delegationMarker／sessionWide）配置化等价性 + 行为锁 + 自重置——固定末尾
  "./scope-config.test.mjs",
  // 域 2 第五枪（2026-09-22）：规则 1 重试豁免词（retryExempt）配置化等价性 + 行为锁 + 自重置——固定末尾
  "./retry-config.test.mjs",
  // 域 3 第一枪（2026-09-22）：naturalMode 五键配置化等价性 + 行为锁 + 自重置——固定末尾
  "./natural-mode-config.test.mjs",
  // 域 3 第二枪（2026-09-22）：注入文案命令词（injectCommand）配置化等价性 + D1 行为锁 + 自重置——固定末尾
  "./inject-config.test.mjs",
  // 域 3 第三枪（2026-09-22）：白名单口令（whitelistAllow）配置化等价性 + 捕获 + 自重置——固定末尾
  "./whitelist-allow-config.test.mjs",
  // 件 A（2026-09-22）：classifyAction 消费 toolClass 的 analysis（反例：pwsh --dry-run 仍 unknown）
  "./contract-analysis-class.test.mjs",
  // 件 E（2026-09-22）：node 调用带 --dry-run 视为只读（真 bump／写盘 cmdlet 同条／git push·commit 仍非只读）
  "./dry-run-readonly.test.mjs",
  // 件 B（2026-09-22）：契约拒绝与未归类工具拒绝写入 cardHits（回合卡片不再 clear）
  "./contract-card-hits.test.mjs",
  // 执行单 3-4 已选 (b)（2026-09-22）：被拦调用类型 → ask 授权类别（lastDeniedType ＋ 双类兜底）
  "./ask-auth-class.test.mjs",
  // unknownPolicy 取值矩阵（默认口径）：自设 DSH_HOME + import index.js（该支调用时现读配置）——固定末尾
  "./unknown-policy.test.mjs",
  // A3 规则 2 判定与投递（按 lane 记账/回合末只撤 getdate/合并一条投递/单一判定源）：自设 DSH_HOME + import index.js——固定末尾
  "./rule2-delivery.test.mjs"
];

for (const t of tests) {
  useChineseLexicons(); // 每个测试前重申夹具（防前序测试显式 reset/注入后未还原）
  useChinesePatterns();
  useChineseTypeHints(); // 同上：classify-ask 用 setTypeHints([]) 清 override，不重申则其后中文断言红
  useChineseVerbHints(); // 同上：verb override 同样会被显式 set／重置影响
  useChineseScopeMarkers(); // 同上：scope override 同样会被显式 set／重置影响
  useChineseRetryExempt(); // 同上：retry override 同样会被显式 set／重置影响
  useChineseNaturalMode(); // 同上：naturalMode override 同样会被显式 set／重置影响
  useChineseInjectCommand(); // 同上：injectCommand override 同样会被显式 set／重置影响
  useChineseWhitelistAllow(); // 同上：whitelistAllow override 同样会被显式 set／重置影响
  console.log(`\n== ${t} ==`);
  // consistency-live：真实环境守门测试——必须在真实 DSH_HOME 下运行（tmp 隔离 → SKIP 失去守门价值）
  // 特批：跑前暂存并删除 DSH_HOME（resolveDshHome 回落真实 ~/.dsh），跑后恢复
  if (t === "./consistency-live.test.mjs") {
    const saved = process.env.DSH_HOME;
    delete process.env.DSH_HOME;
    await import(t);
    if (saved !== undefined) process.env.DSH_HOME = saved;
    continue;
  }
  await import(t);
}

console.log("\nALL TESTS PASSED");
