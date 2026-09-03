import assert from "node:assert/strict";
import { createState, getSessionState } from "../lib/core/state.js";
import { understandRule } from "../lib/core/understander.js";
import { detectViolations, extractAssistantText } from "../lib/core/text-detect.js";

const rule2 = understandRule({
  index: "2",
  title: "时间信息须真实（执行等级：B）",
  level: "B",
  body: "- **触发**：回答含时间词。\n- **检查**：写时间前必须 Get-Date。\n- **动作**：审计+纠正。\n- **豁免**：无。"
});
const rule7 = understandRule({
  index: "7",
  title: "承诺保守（执行等级：B）",
  level: "B",
  body: "- **触发**：回答含承诺。\n- **检查**：绝对化承诺词。\n- **动作**：纠正。\n- **豁免**：无。"
});
const rule5 = understandRule({
  index: "5",
  title: "引用标注出处（执行等级：B 弱）",
  level: "B弱",
  body: "- **触发**：回答含 URL。\n- **检查**：含 URL 无出处。\n- **动作**：审计。\n- **豁免**：无。"
});
const rule11 = understandRule({
  index: "11",
  title: "语言（执行等级：B 弱）",
  level: "B弱",
  body: "- **触发**：中文提问。\n- **检查**：回答几乎全英文。\n- **动作**：审计。\n- **豁免**：无。"
});
const rule14 = understandRule({
  index: "14",
  title: "汇报规范（执行等级：D）",
  level: "D",
  body: "- **触发**：汇报/总结。\n- **检查**：一次性完整汇报。\n- **动作**：自证。\n- **豁免**：无。"
});
const rule21 = understandRule({
  index: "21",
  title: "规则管理（执行等级：M）",
  level: "M",
  body: "- **触发**：规则的新增/修改/删除/禁用。\n- **检查**：选项即边界；未选项不得自行纳入。\n- **动作**：自证。\n- **豁免**：无。"
});
const rule22 = understandRule({
  index: "22",
  title: "沟通直接性（执行等级：D）",
  level: "D",
  body: "- **触发**：所有交流场景。\n- **检查**：被指出错误时主动给出原因/改正/防再犯。\n- **动作**：自证。\n- **豁免**：无。"
});
const rule26 = understandRule({
  index: "26",
  title: "GitHub Release 发布规范（执行等级：D 自证）",
  level: "D",
  body: "- **触发**：发布 DSH 插件到 GitHub Release。\n- **检查**：确认正式 Release Asset。\n- **动作**：自证。\n- **豁免**：内部使用。"
});
const rule27 = understandRule({
  index: "27",
  title: "插件挂载唯一性与重启前全量审计（执行等级：C+D）",
  level: "C+D",
  body: "- **触发**：新增/修改/移除/升级 DSH 插件装配；或准备重启。\n- **检查**：装配变更后先跑全量审计；重启前有审计通过记录。\n- **动作**：缺审计通过记录先跑审计。\n- **豁免**：官方 bundle 自身装配；只读查看装配。"
});
const rule19 = understandRule({
  index: "19",
  title: "知识必沉淀（执行等级：D）",
  level: "D",
  body: "- **触发**：学到新 DSH 知识/踩坑/发现手册有误。\n- **检查**：版本记录≠完成，须同步正文。\n- **豁免**：无。"
});
const rule10 = understandRule({
  index: "10",
  title: "新会话上下文恢复（执行等级：D）",
  level: "D",
  body: "- **触发**：新会话 / 用户提及旧会话或旧项目。\n- **检查**：如实说明默认不自动继承；按优先级恢复。\n- **豁免**：无。"
});
const rule12c = understandRule({
  index: "12C",
  title: "下载与网络（执行等级：D）",
  level: "D",
  body: "- **触发**：下载外部资源 / 网络访问。\n- **检查**：需代理先告知；下载后校验；排查先测连通性。\n- **豁免**：无。"
});
const rule13b = understandRule({
  index: "13B",
  title: "会话与提交铁律（执行等级：D 强）",
  level: "D强",
  body: "- **触发**：会话文件替换/修复、git 提交。\n- **检查**：三层验证一次跑完。\n- **豁免**：无。"
});
const rule15 = understandRule({
  index: "15",
  title: "文件版本与处置（执行等级：D）",
  level: "D",
  body: "- **触发**：判断文件版本/用途/处置。\n- **检查**：不凭 mtime/文件名判断新旧。\n- **豁免**：无。"
});

const state = createState();
state.configs = [rule2, rule7, rule5, rule11, rule14, rule21, rule22, rule26, rule27, rule19, rule10, rule12c, rule13b, rule15];
const session = getSessionState(state, "s1");

// 时间词未 Get-Date
session.turn.getDateSeen = false;
let hits = detectViolations({ configs: state.configs, session, text: "我昨天完成了" });
assert.ok(hits.some((h) => h.ruleId === "2"), "time word violation");

// Get-Date 后不报（仅"过去事件时间"仍需证据标注——新规则 2②；纯当前时间词无此要求）
session.turn.getDateSeen = true;
hits = detectViolations({ configs: state.configs, session, text: "现在是 2 点" });
assert.ok(!hits.some((h) => h.ruleId === "2"), "no time violation after Get-Date（当前时间词无需证据）");
// ── 0.5.11 规则 2②：具体时间词 + 无事件证据 → 违规；"之前"模糊词不命中；带证据标注合规 ──
{
  // 模糊词"之前"不命中检测（用户定稿：只有具体时间词才命中）
  assert.ok(!detectViolations({ configs: state.configs, session, text: "之前我统计过 13 条" }).some((h) => h.ruleId === "2"), "「之前」模糊词不命中规则 2");
  // 具体时间词 + 已 Get-Date 但无事件证据标注 → 违规（规则 2②：Get-Date 当前时间≠过去事件证据）
  const hNoEv = detectViolations({ configs: state.configs, session, text: "8 月 27 日晚上统计出 13 条" });
  assert.ok(hNoEv.some((h) => h.ruleId === "2"), "具体时间词无事件证据标注 → 违规（规则 2②）");
  // 具体时间词 + 事件证据标注 → 合规
  assert.ok(!detectViolations({ configs: state.configs, session, text: "8 月 27 日晚上统计出 13 条（日志 ts=2026-08-27T15:21:05Z）" }).some((h) => h.ruleId === "2"), "带日志 ts 证据标注 → 合规");
}

// ── A1（2026-09-03）：时间词拆组——历史日期不要求 Get-Date 只要求证据锚；当下词仍要求 Get-Date ──
{
  session.turn.getDateSeen = false;
  // 历史日期 + 无 Get-Date + 证据标注 → 合规（A1：不再误报"未先核对"）
  assert.ok(!detectViolations({ configs: state.configs, session, text: "商店复检完成于 2026-09-03 03:25（来源：issue 更新 19:25Z）" }).some((h) => h.ruleId === "2"), "A1: 历史日期+来源标注 → 合规（不要求 Get-Date）");
  // 历史日期 + commit 锚 → 合规
  assert.ok(!detectViolations({ configs: state.configs, session, text: "推送完成于 2026年9月3日（commit 99db4ec）" }).some((h) => h.ruleId === "2"), "A1: 历史日期+commit 锚 → 合规");
  // 历史日期 + 无锚 → 违规（②）
  assert.ok(detectViolations({ configs: state.configs, session, text: "复检在 2026-09-03 03:25" }).some((h) => h.ruleId === "2"), "A1: 历史日期无证据锚 → 违规（规则 2②）");
  // 当下词 + 无 Get-Date → 违规（①，拆组后仍命中）
  assert.ok(detectViolations({ configs: state.configs, session, text: "刚才收到复检" }).some((h) => h.ruleId === "2"), "A1: 当下词无 Get-Date → 仍违规（①）");
  // 历史日期转述豁免（B3 语义覆盖到历史日期组）
  assert.ok(!detectViolations({ configs: state.configs, session, text: "你说 2026-09-03 复检过" }).some((h) => h.ruleId === "2"), "A1: 历史日期转述不触发");
  session.turn.getDateSeen = true;
  // 历史日期 + 版本行锚 → 合规
  assert.ok(!detectViolations({ configs: state.configs, session, text: "手册 v4.147 落盘（2026-09-03）" }).some((h) => h.ruleId === "2"), "A1: 历史日期+版本行锚 → 合规");
}

// 承诺词
hits = detectViolations({ configs: state.configs, session, text: "包在我身上，肯定能修好" });
assert.ok(hits.some((h) => h.ruleId === "7"), "promise violation");

// URL 无出处
hits = detectViolations({ configs: state.configs, session, text: "见 https://example.com/doc" });
assert.ok(hits.some((h) => h.ruleId === "5"), "url without source violation");

// 中文提问 + 英文回答
session.lastUserText = "帮我写插件";
hits = detectViolations({ configs: state.configs, session, text: "This is a completely English answer with many words here." });
assert.ok(hits.some((h) => h.ruleId === "11"), "language violation");

// 中文提问 + 中文可见回答但英文思维链
hits = detectViolations({
  configs: state.configs,
  session,
  text: "这是中文回答",
  reasoningText: "This is an English chain of thought with enough words here."
});
assert.ok(hits.some((h) => h.ruleId === "11" && h.reason.includes("思维链")), "reasoning language violation");

// D 级自证泛化：规则 14 触发
hits = detectViolations({ configs: state.configs, session, text: "这次总结如下：已完成插件开发" });
assert.ok(hits.some((h) => h.ruleId === "14"), "generic self-cert for rule14");

// 规则 26：发布/Release 未提正式 Asset → 触发自证；已提 Attach binaries → 不触发
hits = detectViolations({ configs: state.configs, session, text: "已发布 Release，附件已上传" });
assert.ok(hits.some((h) => h.ruleId === "26"), "rule26 self-cert triggered");
hits = detectViolations({ configs: state.configs, session, text: "已通过 Attach binaries 上传正式 Asset" });
assert.ok(!hits.some((h) => h.ruleId === "26"), "rule26 not triggered when formal asset mentioned");

// 规则 27：全局装配变更且本会话未审计时，提“重启/装配”触发自证；已提审计通过则不触发
session.mountAuditRevision = 0;
hits = detectViolations({ configs: state.configs, session, text: "准备重启 DSH", mountRevision: 1 });
assert.ok(hits.some((h) => h.ruleId === "27"), "rule27 self-cert triggered when mount dirty");
session.mountAuditRevision = 1;
hits = detectViolations({ configs: state.configs, session, text: "已跑全量审计通过，MOUNT CONSISTENT，可以重启", mountRevision: 1 });
assert.ok(!hits.some((h) => h.ruleId === "27"), "rule27 not triggered when audit passed mentioned");
hits = detectViolations({ configs: state.configs, session, text: "准备重启 DSH", mountRevision: 0 });
assert.ok(!hits.some((h) => h.ruleId === "27"), "rule27 not triggered when mount clean");

// 规则 21：越界补充触发自证；明确“仅按勾选/未选项单独确认”不触发
hits = detectViolations({ configs: state.configs, session, text: "我顺便补充了一个未勾选项" });
assert.ok(hits.some((h) => h.ruleId === "21"), "rule21 self-cert triggered for out-of-scope supplement");
hits = detectViolations({ configs: state.configs, session, text: "仅按勾选实现，未选项需单独确认" });
assert.ok(!hits.some((h) => h.ruleId === "21"), "rule21 not triggered when scope boundary stated");

// 规则 22：只道歉不给出原因/改正/防再犯触发自证；完整回应不触发
hits = detectViolations({ configs: state.configs, session, text: "抱歉，我错了" });
assert.ok(hits.some((h) => h.ruleId === "22"), "rule22 self-cert triggered for apology without fix");
hits = detectViolations({ configs: state.configs, session, text: "抱歉，原因是... 改正如下... 防再犯机制是..." });
assert.ok(!hits.some((h) => h.ruleId === "22"), "rule22 not triggered when reason/fix/prevention provided");

// 规则 19⑥：只报版本记录未列正文同步触发；已列正文/说明无需同步不触发
hits = detectViolations({ configs: state.configs, session, text: "已记入版本记录 v3.66" });
assert.ok(hits.some((h) => h.ruleId === "19"), "rule19 self-cert triggered for version-record-only");
hits = detectViolations({ configs: state.configs, session, text: "已记入版本记录 v3.66，正文已同步到第 4 章" });
assert.ok(!hits.some((h) => h.ruleId === "19"), "rule19 not triggered when body sync mentioned");
hits = detectViolations({ configs: state.configs, session, text: "只加了版本记录，本次无需同步正文，理由：仅规则正文变更" });
assert.ok(!hits.some((h) => h.ruleId === "19"), "rule19 not triggered when no-sync reason stated");

// 新增 D 级自证提示：10 / 12C / 13B / 15
hits = detectViolations({ configs: state.configs, session, text: "新会话默认不继承，我先恢复旧项目" });
assert.ok(hits.some((h) => h.ruleId === "10"), "rule10 self-cert triggered");
hits = detectViolations({ configs: state.configs, session, text: "开始下载，可能需要 Clash" });
assert.ok(hits.some((h) => h.ruleId === "12C"), "rule12C self-cert triggered");
hits = detectViolations({ configs: state.configs, session, text: "会话修复完成，fromRestore 已跑" });
assert.ok(hits.some((h) => h.ruleId === "13B"), "rule13B self-cert triggered");
hits = detectViolations({ configs: state.configs, session, text: "这个文件版本不确定，先保留" });
assert.ok(hits.some((h) => h.ruleId === "15"), "rule15 self-cert triggered");

// 注入噪音治理 v0.5.6（建议2/3 已自证抑制）：同回复含"规则 X 已按/已自证"标记 → 该规则不再重复命中
hits = detectViolations({ configs: state.configs, session, text: "本次总结：已按规则 14 一次性说明所有要点" });
assert.ok(!hits.some((h) => h.ruleId === "14"), "rule14 self-cert suppressed when already self-certified");
hits = detectViolations({ configs: state.configs, session, text: "建议已按规则 16 合并提出并说明理由" });
assert.ok(!hits.some((h) => h.ruleId === "16"), "rule16 self-cert suppressed when already self-certified");
// 未带标记仍触发（回归保护）
hits = detectViolations({ configs: state.configs, session, text: "本次总结如下，另有两项建议待补充" });
assert.ok(hits.some((h) => h.ruleId === "14"), "rule14 still triggers without self-cert mark");

// C2 统计：detected / suppressed 计数（含聚合纯函数）
{
  const s3 = getSessionState(state, "s3");
  s3.turn.getDateSeen = true;
  detectViolations({ configs: state.configs, session: s3, text: "本次总结：已按规则 14 一次性说明所有要点" });
  assert.equal(s3.ruleStats["14"].detected, 1, "detected counted");
  assert.equal(s3.ruleStats["14"].suppressed, 1, "suppressed counted");
  detectViolations({ configs: state.configs, session: s3, text: "本次总结如下" });
  assert.equal(s3.ruleStats["14"].detected, 2, "second detected");
  assert.equal(s3.ruleStats["14"].suppressed, 1, "no second suppression");
  const { aggregateRuleStats } = await import("../lib/service.js");
  const rows = aggregateRuleStats([s3]);
  const row = rows.find((r) => r.ruleId === "14");
  assert.ok(row && row.detected === 2 && row.suppressed === 1, "aggregateRuleStats merges");
}

// v0.5.7 真实文本回放（2026-08-26 12:37 那轮原文）：词表原样仍产生规则 16 嫌疑（不迁就措辞、
// 不放宽标准），但命中必须带 awaitingJudge 标记——"词表只产嫌疑，是否错误由裁决层确认"。
{
  const s8 = getSessionState(state, "s8");
  s8.turn.getDateSeen = true;
  const realText = "等待你的指令，不再提出新建议。规则 16 自证：无新建议、无重复推销；只等待你的明确指令。";
  const cfg16 = understandRule({
    index: "16",
    title: "建议提出规范（执行等级：D 强）",
    level: "D强",
    body: "- **触发**：建议。\n- **检查**：绑定检查格式。\n- **动作**：自证。"
  });
  const hs = detectViolations({ configs: state.configs.concat([cfg16]), session: s8, text: realText });
  const h16 = hs.find((h) => h.ruleId === "16");
  assert.ok(h16, "真实文本仍产生规则 16 嫌疑（词表原样、未放宽）");
  assert.equal(h16.awaitingJudge, true, "嫌疑带 awaitingJudge 标记（供裁决层确认错误）");
}

// v0.5.7 P0.5-5/6：引述承诺词不算违规；否定/合规声明不构成"重复提议"传播
{
  const s9 = getSessionState(state, "s9");
  s9.turn.getDateSeen = true;
  const cfg16b = understandRule({
    index: "16",
    title: "建议提出规范（执行等级：D 强）",
    level: "D强",
    body: "- **触发**：建议。\n- **检查**：绑定检查格式。\n- **动作**：自证。"
  });
  let hs = detectViolations({ configs: state.configs, session: s9, text: "正确说法是把'保证'改成保守表述" });
  assert.ok(!hs.some((h) => h.ruleId === "7"), "引述'保证'不算承诺（P0.5-5）");
  hs = detectViolations({ configs: state.configs.concat([cfg16b]), session: s9, text: "我不再建议用旧方案了" });
  assert.ok(!hs.some((h) => h.ruleId === "16" && h.reason.includes("重复建议")), "否定声明不构成重复提议（P0.5-6）");
}

// extractAssistantText
const msg = { content: [{ type: "text", text: "hello" }, { type: "image", text: "ignored" }] };
assert.equal(extractAssistantText(msg), "hello");

// B3（2026-08-29 检测层锁定）：无引号转述不触发规则 7；时间词转述不触发规则 2
{
  const sB3 = getSessionState(state, "sb3");
  sB3.turn.getDateSeen = true;
  let hs = detectViolations({ configs: state.configs, session: sB3, text: "用户之前说万无一失，但引用需要标注来源" });
  assert.ok(!hs.some((h) => h.ruleId === "7"), "B3: 无引号转述'万无一失'不算承诺");
  const cfg2 = understandRule({
    index: "2",
    title: "时间信息须真实（执行等级：B + D）",
    level: "B+D",
    body: "- **触发**：时间。\n- **检查**：先核对。\n- **动作**：审计。"
  });
  const cfg7 = understandRule({
    index: "7",
    title: "承诺保守（执行等级：B）",
    level: "B",
    body: "- **触发**：承诺。\n- **检查**：检测。\n- **动作**：审计。"
  });
  hs = detectViolations({ configs: state.configs.concat([cfg2]), session: sB3, text: "你说昨天就提交了" });
  assert.ok(!hs.some((h) => h.ruleId === "2"), "B3: 时间词转述（你说昨天…）不触发规则 2");
  hs = detectViolations({ configs: state.configs.concat([cfg2]), session: sB3, text: "我昨天完成了" });
  assert.ok(hs.some((h) => h.ruleId === "2"), "B3: 第一人称时间词仍触发规则 2");
  hs = detectViolations({ configs: state.configs.concat([cfg7]), session: sB3, text: "我说保证今天修好" });
  assert.ok(hs.some((h) => h.ruleId === "7"), "B3: 第一人称'我说保证'仍按承诺处理");
}

// ── 规则 5 扩展 / 规则 31（2026-09-01 用户拍板：先查后说/查证纪律）──
const rule31 = understandRule({
  index: "31",
  title: "查证纪律（执行等级：B + D）",
  level: "B+D",
  body: "- **触发**：任何回合。\n- **检查**：查证目标/撞墙分析/高频查询。\n- **动作**：审计+注入；D 级自证。\n- **豁免**：只读展示。"
});
const cfgWith31 = state.configs.concat([rule31]);

// 规则 5 扩展：内部文档引用 + 近 3 回合无查询 → 命中
{
  const s = getSessionState(state, "s5a");
  s.turn.number = 10;
  s.lastQueryTurn = -1;
  const hs = detectViolations({ configs: cfgWith31, session: s, text: "按手册踩坑 93 的做法执行" });
  assert.ok(hs.some((h) => h.ruleId === "5" && h.reason.includes("内部文档")), "rule5 内部引用无依据命中");
}
// 近 3 回合内有查询 → 不命中
{
  const s = getSessionState(state, "s5b");
  s.turn.number = 10;
  s.lastQueryTurn = 8;
  const hs = detectViolations({ configs: cfgWith31, session: s, text: "按手册踩坑 93 的做法执行" });
  assert.ok(!hs.some((h) => h.ruleId === "5" && h.reason.includes("内部文档")), "rule5 近3回合有查询不命中");
}
// 窗口外（>3 回合前）→ 命中
{
  const s = getSessionState(state, "s5c");
  s.turn.number = 10;
  s.lastQueryTurn = 6;
  const hs = detectViolations({ configs: cfgWith31, session: s, text: "手册写了这个流程" });
  assert.ok(hs.some((h) => h.ruleId === "5" && h.reason.includes("内部文档")), "rule5 窗口外命中");
}
// 已标注来源 → 不命中
{
  const s = getSessionState(state, "s5d");
  s.turn.number = 10;
  s.lastQueryTurn = -1;
  const hs = detectViolations({ configs: cfgWith31, session: s, text: "按手册踩坑 93 执行（来源：手册踩坑 93）" });
  assert.ok(!hs.some((h) => h.ruleId === "5" && h.reason.includes("内部文档")), "rule5 标注来源不命中");
}
// 无引用词 → 不命中
{
  const s = getSessionState(state, "s5e");
  s.turn.number = 10;
  s.lastQueryTurn = -1;
  const hs = detectViolations({ configs: cfgWith31, session: s, text: "这个方案我觉得可以" });
  assert.ok(!hs.some((h) => h.ruleId === "5" && h.reason.includes("内部文档")), "rule5 无引用词不命中");
}
// 规则 31：同工具 ≥3 次 + 无验证语 → 命中
{
  const s = getSessionState(state, "s31a");
  s.turn.number = 5;
  s.turn.pendingToolCalls.set("c1", { name: "grep", args: { pattern: "a" } });
  s.turn.pendingToolCalls.set("c2", { name: "grep", args: { pattern: "b" } });
  s.turn.pendingToolCalls.set("c3", { name: "grep", args: { pattern: "c" } });
  const hs = detectViolations({ configs: cfgWith31, session: s, text: "继续确认", reasoningText: "" });
  assert.ok(hs.some((h) => h.ruleId === "31"), "rule31 同工具≥3次无验证目标命中");
}
// 思维链有验证目标语 → 不命中
{
  const s = getSessionState(state, "s31b");
  s.turn.number = 5;
  s.turn.pendingToolCalls.set("c1", { name: "grep", args: { pattern: "a" } });
  s.turn.pendingToolCalls.set("c2", { name: "grep", args: { pattern: "b" } });
  s.turn.pendingToolCalls.set("c3", { name: "grep", args: { pattern: "c" } });
  const hs = detectViolations({ configs: cfgWith31, session: s, text: "继续确认", reasoningText: "验证目标：确认 X 与 Y 的对应关系，交叉核对两处源码" });
  assert.ok(!hs.some((h) => h.ruleId === "31"), "rule31 思维链有验证目标不命中");
}
// 仅 2 次 → 不命中
{
  const s = getSessionState(state, "s31c");
  s.turn.number = 5;
  s.turn.pendingToolCalls.set("c1", { name: "grep", args: { pattern: "a" } });
  s.turn.pendingToolCalls.set("c2", { name: "grep", args: { pattern: "b" } });
  const hs = detectViolations({ configs: cfgWith31, session: s, text: "继续确认", reasoningText: "" });
  assert.ok(!hs.some((h) => h.ruleId === "31"), "rule31 2次不命中");
}
// rule31 D 级 hint：撞墙词 → self-certify
{
  const s = getSessionState(state, "s31d");
  const hs = detectViolations({ configs: cfgWith31, session: s, text: "撞了南墙，我换个方式" });
  assert.ok(hs.some((h) => h.ruleId === "31" && h.kind === "self-certify"), "rule31 D级 hint 命中");
}

// rule22 批评形态（用户消息）→ correct 命中；正常疑问不命中
{
  const s = getSessionState(state, "s22a");
  s.lastUserText = "你聋了吗？你疯了？？？？？？";
  const hs = detectViolations({ configs: [{ ...rule22, confidence: "high" }], session: s, text: "好的", reasoningText: "" });
  assert.ok(hs.some((h) => h.ruleId === "22" && h.kind === "correct"), "rule22 批评形态命中");
}
{
  const s = getSessionState(state, "s22b");
  s.lastUserText = "你确认已落盘了吗？请回答";
  const hs = detectViolations({ configs: [{ ...rule22, confidence: "high" }], session: s, text: "好的", reasoningText: "" });
  assert.ok(!hs.some((h) => h.ruleId === "22"), "rule22 正常疑问不命中");
}
// rule22 弱点反问形态（"你怎么还在做！"式）→ 只产嫌疑（self-certify + mode=criticism，交 judge 裁决）
{
  const s = getSessionState(state, "s22c");
  s.lastUserText = "你怎么还在做！";
  const hs = detectViolations({ configs: [{ ...rule22, confidence: "high" }], session: s, text: "好的", reasoningText: "" });
  const hit = hs.find((h) => h.ruleId === "22");
  assert.ok(hit, "rule22 反问指责形态命中");
  assert.equal(hit.kind, "self-certify", "弱形态=嫌疑（不直接投递）");
  assert.equal(hit.mode, "criticism", "嫌疑带 criticism 模式（judge 专用 prompt）");
}
{
  const s = getSessionState(state, "s22d");
  s.lastUserText = "你又错了";
  const hs = detectViolations({ configs: [{ ...rule22, confidence: "high" }], session: s, text: "好的", reasoningText: "" });
  const hit = hs.find((h) => h.ruleId === "22");
  assert.ok(hit && hit.kind === "self-certify", "rule22 又错了=弱嫌疑");
}
// rule22 普通技术疑问（"怎么用"式）→ 进入嫌疑（由 judge 判定为 false=不打扰）——设计即"宽嫌疑、模型定论"
{
  const s = getSessionState(state, "s22e");
  s.lastUserText = "这个功能怎么用？";
  const hs = detectViolations({ configs: [{ ...rule22, confidence: "high" }], session: s, text: "好的", reasoningText: "" });
  assert.ok(hs.some((h) => h.ruleId === "22" && h.kind === "self-certify"), "rule22 普通技术疑问=嫌疑（judge 裁决不打扰）");
}

console.log("text-detect.test.js PASS");
