import assert from "node:assert/strict";
import {
  askQuestionCoreText,
  askResultApproved,
  askResultSelectedText,
  authMatches,
  describeOp,
  describeScopes,
  findMatchingAuth,
  inferPathPrefixFromText,
  inferPathPrefixesFromText,
  inferTypeFromText,
  inferTypesFromText,
  isAuthMessage,
  isDirectiveMessage,
  isQuestionMessage,
  isSessionWideAskText,
  operationOf,
  scopesFromIntents
} from "../lib/core/authorization.js";

// 操作范围推导
const op = operationOf("edit", { file_path: "D:\\example\\injector-pkg\\lib\\client.js" });
assert.equal(op.type, "write");
assert.equal(op.pathPrefix, "d:/example/injector-pkg/lib/client.js");

const cmdOp = operationOf("pwsh", { command: "Remove-Item -Path 'D:/tmp/a.txt' -Force" });
assert.equal(cmdOp.type, "delete");
assert.ok(cmdOp.pathPrefix.includes("d:/tmp/a.txt"), "command path extracted");

const backupOp = operationOf("pwsh", { command: "Copy-Item -LiteralPath 'D:/a.txt' -Destination 'D:/a.txt.bak' -Force" });
assert.equal(backupOp.type, "backup", "copy to .bak should be backup type");
const copyWriteOp = operationOf("pwsh", { command: "Copy-Item -LiteralPath 'D:/a.txt' -Destination 'D:/b.txt' -Force" });
assert.equal(copyWriteOp.type, "write", "copy to non-backup target should be write type");

// P0-1d：Copy-Item 源路径长于目标路径时，pathPrefix 必须取 Destination（真实写目标），
// 不能按"最长路径"误选源（13A 误拦根因）；pathPrefixes 保留源+目标双候选供授权匹配
const longSrcOp = operationOf("pwsh", {
  command: "Copy-Item 'D:/example/apps/comfy-desktop/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/Lib/site-packages/comfyui_workflow_templates_json/templates/video_minimax_h3_t2v.json' 'D:/example workspace/dsh-project/video_minimax_h3_t2v_local.json' -Force"
});
assert.equal(longSrcOp.pathPrefix, "d:/example workspace/dsh-project/video_minimax_h3_t2v_local.json", "pathPrefix is Destination even when source is longer");
assert.equal(longSrcOp.pathPrefixes.length, 2, "pathPrefixes keeps source + destination candidates");
assert.ok(longSrcOp.pathPrefixes.some((p) => p.includes("comfyui_workflow_templates_json")), "source kept in pathPrefixes for auth matching");

// 文本推断
assert.equal(inferTypeFromText("授权修改 D:\\example\\injector-pkg 下文件"), "write");
assert.equal(inferTypeFromText("允许删除 test/a.txt"), "delete");
assert.equal(inferTypeFromText("可以执行 git push"), "git");
assert.ok(inferPathPrefixFromText("允许修改 D:\\example\\injector-pkg\\lib\\client.js").includes("d:/example/injector-pkg/lib/client.js"));
assert.ok(
  inferPathPrefixFromText("Copy-Item -LiteralPath 'D:\\example workspace\\a.jsonl.zstd' -Destination 'D:\\example workspace\\b.jsonl.zstd'")
    .includes("d:/example workspace/a.jsonl.zstd"),
  "quoted path with spaces extracted"
);

// 范围匹配
const auth = { type: "write", pathPrefix: "d:/example/injector-pkg", at: 1 };
assert.equal(authMatches(auth, { type: "write", pathPrefix: "d:/example/injector-pkg/lib/client.js" }), true);
assert.equal(authMatches(auth, { type: "write", pathPrefix: "d:/other/file.js" }), false);
assert.equal(authMatches(auth, { type: "delete", pathPrefix: "d:/example/injector-pkg/x" }), false);

const found = findMatchingAuth([auth], { type: "write", pathPrefix: "d:/example/injector-pkg/lib/a.js" });
assert.ok(found, "matching auth found");

// 授权 TTL：过期记录不匹配
const expiredAuth = { type: "write", pathPrefix: "d:/example/injector-pkg", at: 1, expiresAt: Date.now() - 1000 };
assert.equal(findMatchingAuth([expiredAuth], { type: "write", pathPrefix: "d:/example/injector-pkg/lib/a.js" }), null, "expired auth ignored");
const validAuth = { type: "write", pathPrefix: "d:/example/injector-pkg", at: 1, expiresAt: Date.now() + 10000 };
assert.ok(findMatchingAuth([validAuth], { type: "write", pathPrefix: "d:/example/injector-pkg/lib/a.js" }), "valid auth matched");

// 询问 vs 授权
assert.equal(isQuestionMessage("修复这个影响插件本身吗"), true);
assert.equal(isQuestionMessage("可以，开始执行吧"), false);
assert.equal(isAuthMessage("可以，开始执行吧"), true);
assert.equal(isAuthMessage("修复这个影响插件本身吗"), false);
assert.equal(isDirectiveMessage("删除这个文件"), true);
assert.equal(isDirectiveMessage("修复这个影响插件本身吗"), false);

// ask 结果解析
assert.equal(askResultApproved({ answers: [{ selected: ["允许（推荐）"] }] }), true);
assert.equal(askResultApproved({ answers: [{ selected: ["不允许"] }] }), false);
assert.equal(askResultApproved({ answers: [{ selected: ["允许"], custom: "否" }] }), false);

// describeOp
assert.ok(describeOp({ type: "write", pathPrefix: "d:/x" }).includes("write"));

// E11：ask 授权记录的是源路径，backup/move 操作目标是目标路径，也应匹配
const srcAuth = { type: "backup", pathPrefix: "d:/a.txt", at: 1 };
const backupOp2 = operationOf("pwsh", { command: "Copy-Item -LiteralPath 'D:/a.txt' -Destination 'D:/a.txt.bak' -Force" });
assert.equal(backupOp2.type, "backup", "copy to .bak is backup type");
assert.equal(authMatches(srcAuth, backupOp2), true, "source-path auth matches backup op with dest path");
const moveTrashOp = operationOf("pwsh", { command: "Move-Item 'D:/example workspace/dsh-project/.dsh-meow' 'D:/example workspace/dsh-project/.backups/trash-x/.dsh-meow'" });
assert.equal(moveTrashOp.type, "backup", "move to trash is backup type");
const trashAuth = { type: "backup", pathPrefix: "d:/example workspace/dsh-project/.dsh-meow", at: 1 };
assert.equal(authMatches(trashAuth, moveTrashOp), true, "source-path auth matches move-to-trash op");

// ── 2026-08-24：词表统一（intent.js 单一来源，消灭两套疑问词不一致）──
{
  const { parseUserIntents } = await import("../lib/core/intent.js");
  for (const q of ["要不要继续", "这样可以吗", "影响大吗？"]) {
    assert.equal(isQuestionMessage(q), true, `isQuestionMessage(${q}) = true`);
    assert.equal(parseUserIntents(q).hasQuestion, true, `intent 亦判 ${q} 为询问（两表一致）`);
  }
  assert.equal(isQuestionMessage("请继续"), false, "执行句不是询问");
  assert.equal(parseUserIntents("请继续").hasExecute, true, "执行句是执行分点");
}

// ── 2026-08-24：APPROVAL_EXEC_RE（执行许可确认词，规则 22 粒度配套）──
assert.equal(isAuthMessage("确认方案"), false, "纯确认方案不构成执行许可");
assert.equal(isAuthMessage("确认理解"), false, "纯确认理解不构成执行许可");
assert.equal(isAuthMessage("确认，开始执行吧"), true, "确认+执行语构成执行许可");
assert.equal(isAuthMessage("同意，现在开始"), true, "同意+现在开始构成执行许可");
assert.equal(askResultApproved({ answers: [{ selected: ["确认方案"] }] }), false, "ask 结果纯确认方案不算批准");
assert.equal(askResultApproved({ answers: [{ selected: ["确认，开始执行"] }] }), true, "ask 结果带执行语算批准");
assert.equal(askResultApproved({ answers: [{ selected: ["按交接文档全部推进项执行（推荐）"] }] }), true, "ask 选项含执行动作算批准");
assert.equal(askResultApproved({ answers: [{ selected: ["只做第 1 项回合粒度升级"] }] }), true, "ask 选项含做/升级动作算批准");

// ── 2026-08-24：scopesFromIntents（规则 22 粒度范围推导）──
{
  const { parseUserIntents } = await import("../lib/core/intent.js");
  const mixed = parseUserIntents("1. 删除 D:/tmp/a.txt\n2. 给出方案");
  const scopes = scopesFromIntents(mixed);
  assert.equal(scopes.length, 1, "仅 execute 子句生成授权范围");
  assert.equal(scopes[0].type, "delete", "删除子句推导 delete 类型");
  assert.ok(scopes[0].pathPrefix.includes("d:/tmp/a.txt"), "删除子句保留路径");
  assert.equal(parseUserIntents("执行吧").hasExecute, true, "宽泛执行仍是 execute");
  const broadScopes = scopesFromIntents(parseUserIntents("执行吧"));
  assert.equal(broadScopes.length, 1, "宽泛执行也有一个范围");
  assert.equal(broadScopes[0].type, "any", "宽泛执行推导 any 类型（不被误限为 command）");
  assert.equal(broadScopes[0].pathPrefix, "", "宽泛执行全局路径");
  // 2026-08-31（宽泛指令缺陷锁定）："按流程执行残余一处理" 类无具体操作的宽泛指令
  // → any/全局（规则 22⑤ 宽泛指令=全局范围；不得收窄为 analysis/command——本会话 ERR-VXAYE4 反例）
  const flowScopes = scopesFromIntents(parseUserIntents("请按流程执行残余一处理"));
  assert.equal(flowScopes.length, 1, "宽泛流程指令一个范围");
  assert.equal(flowScopes[0].type, "any", "宽泛流程指令推导 any（不被误限为 analysis/command）");
  assert.equal(flowScopes[0].pathPrefix, "", "宽泛流程指令全局路径");
  assert.ok(describeScopes(scopes).includes("delete"), "describeScopes 可读");
}

// ── 2026-08-24：ask 授权范围修复（选项描述不得放大全局 TTL）──
{
  const qs = [
    {
      question: "是否删除 D:/x?",
      header: "删除确认",
      options: [{ label: "允许", description: "仅会话内说明，不跨会话保留" }]
    }
  ];
  assert.equal(askQuestionCoreText(qs).includes("仅会话内说明"), false, "core text 不含选项描述");
  assert.equal(askQuestionCoreText(qs).includes("是否删除"), true, "core text 含问题");
  assert.equal(askResultSelectedText({ answers: [{ selected: ["允许"], custom: "" }] }), "允许", "selected text 提取");
  assert.equal(isSessionWideAskText("仅会话内说明"), false, "“仅会话内说明”不算会话级范围");
  assert.equal(isSessionWideAskText("全部推进项"), true, "“全部推进项”算会话级范围");
  assert.equal(isSessionWideAskText("本会话"), true, "“本会话”算会话级范围");
}

// ── 2026-08-24：多操作/多路径范围推导（“修改 A、删除 B”不得只覆盖单一 type/最长路径）──
{
  const { parseUserIntents } = await import("../lib/core/intent.js");
  const multi = parseUserIntents("修改 D:/a.txt 并删除 D:/b.txt");
  const scopes = scopesFromIntents(multi);
  const types = scopes.map((s) => s.type).sort();
  assert.ok(types.includes("write") && types.includes("delete"), "多操作子句同时推导 write+delete");
  assert.ok(scopes.some((s) => s.pathPrefix.includes("d:/a.txt")), "路径 A 被覆盖");
  assert.ok(scopes.some((s) => s.pathPrefix.includes("d:/b.txt")), "路径 B 被覆盖");
  assert.deepEqual([...inferTypesFromText("修改并删除")].sort(), ["delete", "write"], "inferTypesFromText 返回全部命中类型");
  assert.ok(inferPathPrefixesFromText("改 D:/a.txt 和 D:/b.txt").length === 2, "inferPathPrefixesFromText 返回全部路径");
}

// ── 2026-08-25 RB-05：只读/审查类词 → analysis 类型（置末位，不抢变更语义）──
{
  assert.equal(inferTypeFromText("审查这个配置"), "analysis", "审查 → analysis");
  assert.equal(inferTypeFromText("阅读交接文档"), "analysis", "阅读 → analysis");
  assert.equal(inferTypeFromText("验证一下结果"), "analysis", "验证 → analysis");
  assert.equal(inferTypeFromText("修改 A 并审查 B"), "write", "修改并审查 → write 优先（analysis 置末位）");
  assert.equal(inferTypeFromText("删除该文件"), "delete", "删除 → delete（回归）");
  assert.deepEqual([...inferTypesFromText("查看并修改")].sort(), ["analysis", "write"], "inferTypesFromText 全命中含 analysis");
}

// ── 2026-08-31：skill 词残留收紧（12B 禁用后，"Skill"名词不再触发技能类判定）──
{
  // VCI2RX 实证：gh repo create 描述含 "Skill" → 曾被判 skill 类误拦
  assert.notEqual(inferTypeFromText("gh repo create dsh-rule-engine-usage --description rule-engine usage guide"), "skill", "名词 Skill 不再命中（VCI2RX 防线）");
  // 真实技能操作仍识别（skill 工具/目录管理）
  assert.equal(inferTypeFromText("调用 skill 查看技能目录"), "skill", "技能调用仍判 skill");
  assert.equal(inferTypeFromText("skill enable example-usage-manual"), "skill", "skill 工具命令仍判 skill");
  assert.equal(inferTypeFromText("禁用技能 rules-manager"), "skill", "技能禁用仍判 skill");
}

console.log("authorization.test.js PASS");
