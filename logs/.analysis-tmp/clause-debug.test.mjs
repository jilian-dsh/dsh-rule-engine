import { parseUserIntents } from "../lib/core/intent.js";
import { scopesFromIntents } from "../lib/core/authorization.js";
// 用户第 1 轮消息（三条分点：问/问/指令）
const msg = [
  "1、按发布习惯，这个脚本需要push吗",
  "2、建 skill 远程仓库并推送",
  "3、推送完成后将插件和skill地址一起发给我，我请朋友提提意见"
].join("\n");
const it = parseUserIntents(msg);
console.log("=== 整条消息 ===");
console.log("hasExecute:", it.hasExecute, "| hasQuestion:", it.hasQuestion, "| hasPlan:", it.hasPlan);
console.log("=== 分点级（clauses） ===");
for (const c of it.clauses) {
  console.log(`[${c.id}] type=${c.type} raw=${JSON.stringify(c.raw)} hasAction=${c.hasAction} hasQuestion=${c.hasQuestion} deferred=${c.deferred}`);
}
console.log("=== 授权范围（scopes，整条并集） ===");
console.log(JSON.stringify(scopesFromIntents(it)));
