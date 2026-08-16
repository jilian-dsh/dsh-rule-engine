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

const state = createState();
state.configs = [rule2, rule7, rule5, rule11, rule14, rule21, rule22, rule26, rule27];
const session = getSessionState(state, "s1");

// 时间词未 Get-Date
session.turn.getDateSeen = false;
let hits = detectViolations({ configs: state.configs, session, text: "我昨天完成了" });
assert.ok(hits.some((h) => h.ruleId === "2"), "time word violation");

// Get-Date 后不报
session.turn.getDateSeen = true;
hits = detectViolations({ configs: state.configs, session, text: "我昨天完成了" });
assert.ok(!hits.some((h) => h.ruleId === "2"), "no time violation after Get-Date");

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

// extractAssistantText
const msg = { content: [{ type: "text", text: "hello" }, { type: "image", text: "ignored" }] };
assert.equal(extractAssistantText(msg), "hello");

console.log("text-detect.test.js PASS");
