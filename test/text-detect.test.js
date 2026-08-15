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
const rule26 = understandRule({
  index: "26",
  title: "GitHub Release 发布规范（执行等级：D 自证）",
  level: "D",
  body: "- **触发**：发布 DSH 插件到 GitHub Release。\n- **检查**：确认正式 Release Asset。\n- **动作**：自证。\n- **豁免**：内部使用。"
});

const state = createState();
state.configs = [rule2, rule7, rule5, rule11, rule14, rule26];
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

// extractAssistantText
const msg = { content: [{ type: "text", text: "hello" }, { type: "image", text: "ignored" }] };
assert.equal(extractAssistantText(msg), "hello");

console.log("text-detect.test.js PASS");
