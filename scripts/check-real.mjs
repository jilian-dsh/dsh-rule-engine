// check-real.mjs - 只读校验：用真实 ~/.dsh/AGENTS.md 跑解析+理解，不写任何文件。
import { loadRules } from "../lib/core/parser.js";
import { understandAll } from "../lib/core/understander.js";

const parsed = loadRules();
if (!parsed.ok) {
  console.error(JSON.stringify({ ok: false, error: parsed.error }, null, 2));
  process.exit(1);
}
const configs = understandAll(parsed.rules);
const summary = {
  ok: true,
  ruleCount: parsed.rules.length,
  sections: [...new Set(parsed.rules.map((r) => r.section))],
  confidence: configs.reduce((acc, c) => {
    acc[c.confidence] = (acc[c.confidence] || 0) + 1;
    return acc;
  }, {}),
  actions: configs.reduce((acc, c) => {
    for (const a of c.actions) acc[a] = (acc[a] || 0) + 1;
    return acc;
  }, {})
};
console.log(JSON.stringify(summary, null, 2));
