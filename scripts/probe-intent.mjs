// probe-intent.mjs - 测"落"字为何被判问句（用户明确执行却拦）
import { parseUserIntents, shouldDenyMutation } from "../lib/core/intent.js";
const texts = [
  "2、连同上面这条一起落",
  "连上面这条一起落",
  "落",
  "全部一起落",
  "认可全部link不装npm形态",
  "1、认可形态 2、连上面这条一起落"
];
for (const t of texts) {
  const r = parseUserIntents(t);
  console.log(`"${t}" → hasExecute=${r.hasExecute} hasQuestion=${r.hasQuestion} types=${r.clauses.map((c) => c.type).join(",")}`);
}
