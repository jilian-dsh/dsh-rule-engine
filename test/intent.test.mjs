import assert from "node:assert/strict";
import { isEngineInjectedMessage, isInjectedContextMessage, parseUserIntents, shouldDenyMutation, stripInjectedContext } from "../lib/core/intent.js";

// 数字列表混合意图
const mixed = parseUserIntents(`1. 开始蒸馏
2. 给出 PV 设计方案，确认后再做
3. 为什么目标会循环？
4. 只读检查一下当前配置文件`);

assert.equal(mixed.source, "numbered-list", "numbered list detected");
assert.equal(mixed.hasExecute, true, "mixed numbered list has execute");
assert.equal(mixed.hasPlan, true, "mixed numbered list has plan");
assert.equal(mixed.hasQuestion, true, "mixed numbered list has question");
assert.equal(mixed.ambiguous, false, "mixed numbered list not ambiguous");
assert.deepEqual(
  mixed.clauses.map((c) => c.type),
  ["execute", "plan", "question", "execute"],
  "numbered clause types (2026-08-25 RB-05：只读检查类词入 ACTION_RE → 第 4 子句 info→execute)"
);

// 纯方案列表：无执行授权
const planOnly = parseUserIntents(`1. 给出方案
2. 确认后再做`);
assert.equal(planOnly.hasExecute, false, "plan-only has no execute");
assert.equal(planOnly.hasPlan, true, "plan-only has plan");
assert.equal(shouldDenyMutation(planOnly), true, "plan-only denies mutation");

// 标签解析
const tagged = parseUserIntents(`【执行】开始蒸馏
【方案】给 PV 设计方案，确认后再做
【问询】为什么目标会循环？`);
assert.equal(tagged.source, "labels", "tags detected");
assert.equal(tagged.hasExecute, true, "tagged has execute");
assert.equal(tagged.hasPlan, true, "tagged has plan");
assert.equal(tagged.hasQuestion, true, "tagged has question");

// “可以执行吗？”是询问，不是执行授权
const canExec = parseUserIntents("可以执行吗？");
assert.equal(canExec.hasExecute, false, "can-execute-question is not execute");
assert.equal(canExec.hasQuestion, true, "can-execute-question is question");
assert.equal(shouldDenyMutation(canExec), true, "can-execute-question denies mutation");

// “请给出执行方案”是方案请求，不是直接执行
const planPhrase = parseUserIntents("请给出执行方案");
assert.equal(planPhrase.hasExecute, false, "give-plan phrase is not execute");
assert.equal(planPhrase.hasPlan, true, "give-plan phrase is plan");

// 数字+中文顿号列表
const cnList = parseUserIntents(`1、删除 D:/tmp/a.txt
2、为什么？`);
assert.equal(cnList.source, "numbered-list", "cn-number list detected");
assert.equal(cnList.clauses[0].type, "execute", "first cn item execute");
assert.equal(cnList.clauses[1].type, "question", "second cn item question");
assert.equal(cnList.hasExecute, true, "cn list has execute");

// 单条纯问询保持原语义
const singleQuestion = parseUserIntents("你的执行方案难道没问题吗？");
assert.equal(singleQuestion.hasExecute, false, "single question no execute");
assert.equal(singleQuestion.hasQuestion, true, "single question is question");
assert.equal(shouldDenyMutation(singleQuestion), true, "single question denies mutation");

// askSeen 可解除禁止
assert.equal(shouldDenyMutation(planOnly, true), false, "askSeen lifts plan-only denial");

// ── 2026-08-23 修复：混合指令/系统注入识别 ──────────────────────────────
// 标题 + 正文拆分：标题含动作词 → 执行分点（“改进”此前不被识别 → 整条被判无执行分点）
const titledMessage = parseUserIntents("【改进规则引擎以区分混合指令】会话出现问题。给出弹窗后，显示“question response rejected: not-pending”，不允许我回复任何选项。");
assert.equal(titledMessage.clauses.length, 2, "【标题】+正文 拆为两个子句");
assert.equal(titledMessage.clauses[0].type, "execute", "标题子句含动作词 → execute");
assert.equal(titledMessage.hasExecute, true, "混合消息 hasExecute = true");
assert.equal(titledMessage.hasQuestion, false, "正文无疑问词（子句级）");
assert.equal(shouldDenyMutation(titledMessage), false, "混合消息不再误拦");

// 标准【执行】标签 + 疑问正文保持保守（规则 22⑨：标签与正文冲突 → 待确认）
const mixedTag = parseUserIntents("【执行】请把结果写入文件。但是，规则 22 会不会误拦？");
assert.equal(mixedTag.ambiguous, true, "标准标签+疑问正文 → ambiguous 保守");

// 扩充动作词表：继续/调查/改进
for (const [phrase, label] of [
  ["请继续", "继续"],
  ["请继续调查", "继续调查"],
  ["请改进规则引擎", "改进"],
  ["可以，继续调查", "可以继续调查"]
]) {
  assert.equal(parseUserIntents(phrase).hasExecute, true, `${label} 是执行分点`);
}

// 系统注入文本检测
assert.equal(isInjectedContextMessage("<system-reminder>\n规则全文含【执行】示例与“为什么/是否”\n</system-reminder>"), true, "system-reminder 被判为系统注入");
assert.equal(isInjectedContextMessage("你是《问镜》全量蒸馏子代理。请…并落盘结果。"), false, "委派任务不是系统注入");
assert.equal(isInjectedContextMessage("正常工作消息，不含标签"), false, "普通消息不是系统注入");
// 引擎自我注入消息检测（防止自我续授权）
assert.equal(isEngineInjectedMessage("[规则引擎] 已有授权，无需重复询问：请直接执行"), true, "引擎注入消息被识别");
assert.equal(isEngineInjectedMessage("正常工作消息"), false, "普通消息不是引擎注入");

// ── 2026-08-24：状态信号（规则 22⑩）+ 词表统一 ──────────────────────────
for (const [phrase, label] of [
  ["我已重启", "我已重启"],
  ["我已输入 /guard unlock", "我已输入"],
  ["重启完成", "重启完成"],
  ["已输入", "已输入"],
  ["unlock 已输入", "unlock 已输入"],
  ["好了", "好了"],
  ["done", "done"]
]) {
  const it = parseUserIntents(phrase);
  assert.equal(it.hasStatus, true, `${label} 是状态信号`);
  assert.equal(shouldDenyMutation(it), false, `${label} 不触发拦截`);
}
// 危险词排除：含删除不算状态信号
const dangerous = parseUserIntents("我已删除 D:/x/a.txt");
assert.equal(dangerous.hasStatus, false, "含危险动作词不是状态信号");
// 状态信号不影响既有判定
assert.equal(parseUserIntents("继续").hasExecute, true, "继续仍是执行分点");
assert.equal(parseUserIntents("我可以继续吗").hasQuestion, true, "疑问仍是问询");
// 词表统一（authorization 的疑问词并入 intent 后一致判定）
for (const q of ["要不要继续", "这样可以吗", "影响大吗"]) {
  assert.equal(parseUserIntents(q).hasQuestion, true, `${q} 判为询问`);
}

// ── 2026-08-24：同行编号列表切分（"1、A 2、B" 同一行，真实用户消息形态）──
const inlineNums = parseUserIntents("1、请补充进事故报告 2、请继续完善方案的其他部分");
assert.equal(inlineNums.clauses.length, 2, "同行编号切分为两个子句");
assert.equal(inlineNums.clauses[0].type, "execute", "子句1 执行（补充）");
assert.equal(inlineNums.hasExecute, true, "同行混合列表 hasExecute = true（不误判整条 plan）");
// 编号前非空白不误切（"执行第2、3条"保持单子句）
assert.equal(parseUserIntents("执行第2、3条").clauses.length, 1, "句内序号不切分");

// ── 2026-08-24：注入剥离（合并注入 + 真实消息 → 只留真实消息；纯注入 → 空）──
assert.equal(
  stripInjectedContext("<system-reminder>\n规则全文含【执行】示例与“为什么/是否”\n</system-reminder>\n我已重启"),
  "我已重启",
  "合并事件剥离注入后保留用户文本"
);
assert.equal(
  stripInjectedContext("<system-reminder>\n只有注入内容\n</system-reminder>"),
  "",
  "纯注入 → 空串（跳过）"
);
assert.equal(stripInjectedContext("无障碍回复"), "无障碍回复", "无注入原样返回");
assert.equal(
  parseUserIntents(stripInjectedContext("<system-reminder>\n注入\n</system-reminder>\n我已重启")).hasStatus,
  true,
  "剥离后状态信号识别正常"
);

// ── 2026-08-24：词表补「实施」──
assert.equal(parseUserIntents("实施").hasExecute, true, "「实施」是执行分点（词表补充）");
assert.equal(parseUserIntents("开始实施").hasExecute, true, "开始实施 放行");

// ── 2026-08-24：词表补「写/保存」等单字动作词（踩坑 72：用户明确指令曾被拦）──
for (const [phrase, label] of [
  ["统一写一份交接文档", "写"],
  ["请把结果保存下来", "保存"],
  ["保存到 D:/x", "保存到路径"],
  ["写下结论", "写下"]
]) {
  assert.equal(parseUserIntents(phrase).hasExecute, true, `「${label}」是执行分点（词表补充）`);
}

// ── 2026-08-24：补「改/补/修/做」单字动作词（用户“给我改”曾被拦）──
for (const [phrase, label] of [
  ["给我改", "改"],
  ["补上", "补"],
  ["修一下", "修"],
  ["做", "做"],
  ["跑", "跑（单字动作词补充，用户“3、跑”曾被吞——分点下第 3 条）"]
]) {
  assert.equal(parseUserIntents(phrase).hasExecute, true, `「${label}」是执行分点（单字动作词补充）`);
}

// ── 2026-08-28：分点混合消息中单独"跑"不被问句掩没（用户"1、问 2、问 3、跑"实测被拦根因）──
{
  const mixed = parseUserIntents("1、为什么预算会满？2、检查时间规则？3、跑");
  assert.equal(mixed.hasExecute, true, "分点混合：第 3 条「跑」= 执行分点，不被问句掩盖（词表补充后）");
  assert.equal(mixed.clauses[2].type, "execute", "第 3 子句类型 = execute");
}
// ── 2026-08-28：换行版同样分点（用户原话"我是换行发的，总之不管换不换行都需要分点"）──
{
  const nl = parseUserIntents("1、为什么预算会满？\n2、你的 GET DATE 规则提醒是让你查当前时间吗？\n3、跑");
  assert.equal(nl.hasExecute, true, "换行分点：第 3 条「跑」= 执行分点（用户换行发）");
  assert.equal(nl.clauses.length, 3, "换行分点 = 3 个子句");
  assert.equal(nl.clauses[2].type, "execute", "换行第 3 子句 = execute");
}

// ── 2026-08-25 RB-05 词表攻坚：进行/完成（引用式）/只读类/产出类 动词 ──
for (const [phrase, label] of [
  ["请进行词表攻坚", "进行"],
  ["先完成A+C", "完成（引用式指令）"],
  ["完成 A 和 C 两项", "完成（多项引用）"],
  ["审查这个配置", "审查"],
  ["阅读交接文档", "阅读"],
  ["查看当前状态", "查看"],
  ["核对一下清单", "核对"],
  ["检查一下配置", "检查"],
  ["验证一下结果", "验证"],
  ["对照手册确认", "对照"],
  ["请产出交接文档", "产出"],
  ["编写测试用例", "编写"],
  ["生成报告", "生成"]
]) {
  assert.equal(parseUserIntents(phrase).hasExecute, true, `「${label}」是执行分点（RB-05 词表补充）`);
}
// 防回归 II（2026-08-25）：疑问形态优先（“检查文件是否正确”= 问句语义，保持 question 保守判定）
assert.equal(parseUserIntents("检查文件是否正确").hasQuestion, true, "检查…是否… = 疑问优先（保守语义）");
// 防回归：状态信号/疑问仍是 status/question（不得因“完成”入表而误判）
assert.equal(parseUserIntents("我已完成重启").hasStatus, true, "我已完成重启 = 状态信号（防回归）");
assert.equal(parseUserIntents("已完成").hasStatus, true, "已完成 = 状态信号（防回归）");
assert.equal(parseUserIntents("完成了吗？").hasQuestion, true, "完成了吗？= 疑问（防回归）");
assert.equal(parseUserIntents("先完成A+C").hasQuestion, false, "先完成A+C 非疑问");
// 命令式隔离（2026-08-25 RB-05）：行首裸“完成/重启 + 宾语”不是状态信号
assert.equal(parseUserIntents("完成 A 和 C 两项").hasStatus, false, "完成 A 和 C 两项 非状态信号");
assert.equal(parseUserIntents("完成 A 和 C 两项").hasExecute, true, "完成 A 和 C 两项 = 执行分点");
assert.equal(parseUserIntents("重启服务").hasStatus, false, "重启服务 非状态信号（命令）");
assert.equal(parseUserIntents("重启服务").hasExecute, true, "重启服务 = 执行分点");
// 2026-08-25 补词（现场：“已经重启clash”被当无执行分点拦）：已经+动作(+宾语连写) = 状态信号
assert.equal(parseUserIntents("已经重启clash").hasStatus, true, "已经重启clash = 状态信号（带宾语连写）");
assert.equal(parseUserIntents("已经重启").hasStatus, true, "已经重启 = 状态信号");
assert.equal(parseUserIntents("已经执行迁移").hasStatus, true, "已经执行迁移 = 状态信号");
// 2026-08-25 现场二：“选择①”被拦（“选择”不在动作词表）→ 补词
assert.equal(parseUserIntents("选择①").hasExecute, true, "选择① = 执行分点（词表补充）");
assert.equal(parseUserIntents("采纳方案").hasExecute, true, "采纳 = 执行分点（词表补充）");
// 只读词不因 PLAN_RE 抢跑（评估/分析仍按方案类处理，语义=展示/评估请求）
assert.equal(parseUserIntents("评估这个风险").hasPlan, true, "评估 = 方案类（PLAN_RE 保持）");
// 2026-08-31（方案+执行误判修复）："按已有方案执行/上述方案执行" = 执行分点
//（方案词 + 强执行语 + 无产出请求词；区别于"给出执行方案"=方案请求）
assert.equal(parseUserIntents("按已有方案顺序依次执行").hasExecute, true, "按已有方案顺序依次执行 = 执行分点");
assert.equal(parseUserIntents("上述方案执行").hasExecute, true, "上述方案执行 = 执行分点");
assert.equal(parseUserIntents("请按方案执行").hasExecute, true, "请按方案执行 = 执行分点");
assert.equal(parseUserIntents("按方案继续").hasExecute, true, "按方案继续 = 执行分点");
// 反例（防回归）：产出请求仍为方案类
assert.equal(parseUserIntents("提供设计方案").hasExecute, false, "提供设计方案 ≠ 执行分点");
assert.equal(parseUserIntents("我需要一个方案").hasExecute, false, "我需要一个方案 ≠ 执行分点");

console.log("intent.test.mjs PASS");
