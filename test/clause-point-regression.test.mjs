// clause-point-regression.test.mjs — 分点级判定回归（柱子 A/B/C，2026-08-31）
// 用例来源：用户真实三点消息（1 问句 / 2 执行 / 3 条件句）——
//   1️⃣ 按发布习惯，这个脚本需要push吗          （问句 → 零授权）
//   2️⃣ 建 skill 远程仓库并推送                  （执行 → 授权，对象=显式命名才锚定）
//   3️⃣ 推送完成后将插件和skill地址一起发给我     （条件句 → 零授权——不得把"推送"当本条动作）
// 锁定：跨分点借授权失效（1/3 不贡献授权池）；"推引擎仓库"不得被 skill 分点授权放行。
import assert from "node:assert/strict";
import { parseUserIntents } from "../lib/core/intent.js";
import { scopesFromIntents, extractActionObjects, authMatches } from "../lib/core/authorization.js";

const msg = [
  "1、按发布习惯，这个脚本需要push吗",
  "2、建 skill 远程仓库并推送",
  "3、推送完成后将插件和skill地址一起发给我，我请朋友提提意见"
].join("\n");

const it = parseUserIntents(msg);
const scopes = scopesFromIntents(it);
console.log("DEBUG clauses:", JSON.stringify(it.clauses.map((c) => ({ id: c.id, type: c.type, raw: c.raw, hasAction: c.hasAction }))));

// ── C：条件句识别 ──
{
  const c3 = it.clauses.find((c) => c.id === "3");
  assert.equal(c3.type, "conditional", "3号分点=conditional（'推送完成后'=条件句，非执行分点）");
  const c1 = it.clauses.find((c) => c.id === "1");
  assert.equal(c1.type, "question", "1号分点=question（问句）");
  const c2 = it.clauses.find((c) => c.id === "2");
  assert.equal(c2.type, "execute", "2号分点=execute（明确执行）");
}

// ── A：分点隔离——仅 2 号产生授权，1/3 零贡献 ──
{
  assert.ok(scopes.length > 0, "有授权范围（来自 2 号）");
  assert.ok(scopes.every((s) => s.clauseId === "2"), "授权全部归属 2 号分点（1/3 号零贡献）");
  assert.ok(scopes.every((s) => s.clauseId !== "1" && s.clauseId !== "3"), "问句/条件句分点不产生授权");
}

// ── B：对象锚定（显式命名才锚定；类别词不锚定） ──
{
  assert.deepEqual(extractActionObjects("建 dsh-rule-engine-usage 远程仓库并推送"), ["dsh-rule-engine-usage"], "实体名对象锚定");
  assert.deepEqual(extractActionObjects("建 skill 远程仓库并推送"), [], "类别概念词（skill）不锚定（防误拦）");
  // 锚定后：推"其他仓库"不匹配（授权=命名对象）
  const auth = { type: "git", pathPrefix: "", object: ["dsh-rule-engine-usage"] };
  const opSame = { type: "git", pathPrefix: "", commandText: "git push https://github.com/x/dsh-rule-engine-usage.git" };
  const opOther = { type: "git", pathPrefix: "", commandText: "git push https://github.com/jilian-dsh/dsh-rule-engine.git" };
  assert.equal(authMatches(auth, opSame), true, "对象命中 → 匹配");
  assert.equal(authMatches(auth, opOther), false, "对象不命中（推其他仓库）→ 不匹配");
  // 未锚定对象 → 不收紧
  const authLoose = { type: "git", pathPrefix: "" };
  assert.equal(authMatches(authLoose, opOther), true, "未锚定 → 维持既有宽度");
}

// ── 反例防回归：不带条件词的正常指令仍判 execute ──
{
  const normal = parseUserIntents("请推送 dsh-rule-engine-usage 仓库到 GitHub");
  assert.equal(normal.clauses[0].type, "execute", "无条件词指令=execute（conditional 不误伤）");
}

console.log("clause-point-regression.test.js PASS");
