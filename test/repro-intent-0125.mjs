// 复现脚本：验证规则引擎意图解析对三种输入的行为
// 1) system-reminder 注入文本（来自 fa956898 会话 seq9/10）
// 2) 子代理委派任务文本（fa956898 会话 seq8）
// 3) 用户本会话的消息（“改进规则引擎以区分混合指令…”）
import { readFileSync } from "node:fs";
import { parseUserIntents, shouldDenyMutation } from "../lib/core/intent.js";
import { isQuestionMessage } from "../lib/core/authorization.js";

const LOG = "D:/example workspace/dsh-project/research/_extract/fa956898-5dd9-4a43-a18b-d71c2cb609e7.jsonl";
const lines = readFileSync(LOG, "utf8").split("\n");

function userTextOf(seq) {
  const line = lines.find((l) => l.includes(`"seq":${seq},"`) && l.includes('"type":"user/message"'));
  if (!line) return "";
  try {
    const obj = JSON.parse(line);
    const b = obj.data.content;
    if (typeof b === "string") return b;
    if (Array.isArray(b)) return b.map((x) => (x && x.type === "text" ? x.text : "")).join("\n");
  } catch {
    return "";
  }
  return "";
}

function report(label, text) {
  const intents = parseUserIntents(text);
  console.log(`\n===== ${label} =====`);
  console.log(`  长度: ${text.length}`);
  console.log(`  questionOnly(isQuestionMessage): ${isQuestionMessage(text)}`);
  console.log(`  hasExecute: ${intents.hasExecute}  hasPlan: ${intents.hasPlan}  hasQuestion: ${intents.hasQuestion}  ambiguous: ${intents.ambiguous}  confidence: ${intents.confidence}`);
  console.log(`  denyMutation(无ask): ${shouldDenyMutation(intents, false)}`);
  console.log(`  子句数: ${intents.clauses.length}`);
  for (const c of intents.clauses.slice(0, 5)) {
    console.log(`    [${c.id}] type=${c.type} tag=${c.tag} 前40字: ${c.raw.slice(0, 40).replace(/\s+/g, " ")}`);
  }
}

report("A. system-reminder seq9（AGENTS.md 全文）", userTextOf(9));
report("B. system-reminder seq10（技能目录）", userTextOf(10));
report("C. 委派任务 seq8（子代理任务描述）", userTextOf(8));
report("D. 用户本会话消息", "【改进规则引擎以区分混合指令】会话出现问题。给出弹窗后，显示\"question response rejected: not-pending\"，不允许我回复任何选项。");
report("E. 真实混合指令（含执行+疑问）", "【执行】请把结果写入文件。但是，规则 22 会不会误拦？");
