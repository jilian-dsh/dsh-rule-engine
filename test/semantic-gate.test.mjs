// semantic-gate.test.mjs - v0.5.7 投递资格语义层（纯函数测试，不 import index.js，安全位置）
import assert from "node:assert/strict";
import {
  shouldDetectTurn,
  shouldDeliver,
  INJECT_BUDGET_PER_HOUR
} from "../lib/core/semantic.js";
import { isSelfCertified } from "../lib/core/text-detect.js";
import { judgeCacheKey, judgeBudgetKey, JUDGE_DAILY_LIMIT } from "../lib/core/judge.js";
import { resolveRoute } from "../lib/core/llm-understander.js";
import {
  isNegatingSuggestion,
  isPromiseQuoteContext,
  isQuoteOrParaphraseContext,
  isReadOnlyCommand,
  isSensitiveToolCall,
  isVerificationCommand,
  isOutsideWorkspace,
  PROMISE_WORDS,
  TIME_WORDS,
  setWorkspaceRoot,
  setWorkspaceRoots,
  setSessionWorkspaceRoot
} from "../lib/core/patterns.js";

// ── 第 0 站：注入轮不检测 ────────────────────────────────────────────
assert.equal(shouldDetectTurn({ realUserSeen: true }), true, "真实用户在场 → 检测");
assert.equal(shouldDetectTurn({ realUserSeen: false }), false, "注入轮（无真实用户消息）→ 不检测");

// ── 投递资格闸：每规则一次 ───────────────────────────────────────────
const t0 = Date.now();
assert.equal(shouldDeliver({ now: t0, ruleId: "16", firstAt: null, budgetTimes: [] }).ok, true, "首次投递放行");
assert.equal(shouldDeliver({ now: t0, ruleId: "16", firstAt: t0, budgetTimes: [] }).reason, "dedup", "同规则同会话仅一次");
// __self-cert 聚合不参与每规则去重（内容每轮可变，总量由预算约束）
assert.equal(shouldDeliver({ now: t0, ruleId: "__self-cert", firstAt: t0, budgetTimes: [] }).ok, true, "聚合注入不去重");

// ── 投递资格闸：会话每小时预算 ───────────────────────────────────────
assert.equal(INJECT_BUDGET_PER_HOUR, 3, "预算 = 3 条/小时");
assert.equal(
  shouldDeliver({ now: t0, ruleId: "16", firstAt: null, budgetTimes: [t0 - 1000, t0 - 2000, t0 - 3000] }).reason,
  "budget",
  "一小时内已 3 条 → 预算拦截"
);
assert.equal(
  shouldDeliver({ now: t0, ruleId: "16", firstAt: null, budgetTimes: [t0 - 3600 * 1000 - 1] }).ok,
  true,
  "预算窗口外的旧记录不计"
);

// ── 已自证识别：标准格式识别，不迁就裸"自证"（v0.5.7 决定：不因执行者措辞放宽标准） ──
assert.equal(isSelfCertified("规则 16 已自证：不再重复同类提法", "16"), true, "标准格式仍识别");
assert.equal(
  isSelfCertified("等待你的指令，不再提出新建议。规则 16 自证：无新建议、无重复推销；只等待你的明确指令。", "16"),
  false,
  "裸'自证'不视为已自证（行为层负责写'已自证'，引擎不迁就）"
);
assert.equal(
  isSelfCertified("请按规则 16 用绑定检查格式提建议（规则 16，已记入 /guard log；下次回复请自证/纠正）", "16"),
  false,
  "引擎注入文本不得误判为已自证（防自我续注）"
);

// ── 裁决器常量与键 ──────────────────────────────────────────────────
assert.equal(JUDGE_DAILY_LIMIT, 50, "每日裁决预算 = 50 次/会话（用户拍板）");
assert.equal(typeof judgeCacheKey("16", "一段文本"), "string", "缓存键可生成");
assert.ok(judgeBudgetKey("s1").startsWith("s1:"), "预算键按会话+UTC 日期");
assert.notEqual(judgeCacheKey("16", "a"), judgeCacheKey("16", "b"), "不同文本不同缓存键");

// ── v0.5.7 路由修复防回归（实弹抓到的缺陷：provider 传 name 而非 id） ──
{
  // 场景：provider 的显示名(name) ≠ 标识(id)——本机 pi-ai 形态
  const fakeCtx = {
    llm: {
      listProviders: () => [{ id: "deepseek-official", name: "DeepSeek Official" }],
      listModels: async (provider) => {
        assert.equal(provider, "deepseek-official", "必须以 id 调用 listModels");
        return [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }];
      }
    }
  };
  const route = await resolveRoute(fakeCtx);
  assert.deepEqual(route, { provider: "deepseek-official", model: "deepseek-v4-flash" }, "路由解析出 provider.id 与模型");
}

// ── v0.5.7 P0-1：验证命令伴生识别 ──────────────────────────────────
assert.equal(isVerificationCommand('node "D:\\x\\test\\run-all.mjs"'), true, "run-all 全量测试");
// A2-7（0.6.0）：example-plugin-load 已从通用词表移除（本机脚本名）；通用验证脚本形态不受影响
assert.equal(isVerificationCommand("node scripts/verify-all.mjs"), true, "通用 verify-all 仍为验证类");
assert.equal(isVerificationCommand("node scripts/example-plugin-load.mjs dsh-rule-engine"), false, "A4-6: 本机脚本名不再入通用任务契约词表");
assert.equal(isVerificationCommand("npm run test"), true, "npm test");
assert.equal(isVerificationCommand('node -e "console.log(1)"'), false, "任意内联命令不算验证");

// ── v0.5.7 P0-2：只读模板带 --profile（只读命令被误拦根因） ──
assert.equal(isReadOnlyCommand("dsh --profile web --dump-config"), true, "带 profile 的 dump-config 只读");
assert.equal(isReadOnlyCommand("dsh --profile web --dump-config 2>&1 | Select-String 'usage'"), true, "管道过滤仍只读");
// ── v0.5.7 后续（用户点名漏词）：常见只读 cmdlet 补全 + 管道含写仍拦 ──
assert.equal(isReadOnlyCommand("Get-Item 'D:\\a' | Select-Object Name,Length"), true, "Select-Object 只读管道");
assert.equal(isReadOnlyCommand("Get-ChildItem | Where-Object Name -like '*.js' | Measure-Object"), true, "Where/Measure 只读链");
assert.equal(isReadOnlyCommand("Get-ChildItem | ForEach-Object { Remove-Item $_.FullName }"), false, "管道内写操作仍判变更（MUTATING 兜底）");

// ── v0.5.7 P0-3：多工作区（根随会话走；兜底=全局列表；跨工作区=外部需授权） ──
setWorkspaceRoots(["D:/ws-a", "D:/ws-b"]);
assert.equal(isOutsideWorkspace("D:/ws-b/x.js"), false, "全局列表任一命中=内部（兜底语义）");
assert.equal(isOutsideWorkspace("D:/elsewhere/x.js"), true, "不在任何已注册工作区=外部");
setSessionWorkspaceRoot("sx", "D:/ws-a");
assert.equal(isOutsideWorkspace("D:/ws-b/x.js", "sx"), true, "会话根下写其他工作区=外部（跨区需授权，安全语义）");
assert.equal(isOutsideWorkspace("D:/ws-a/x.js", "sx"), false, "会话根内=内部");
setWorkspaceRoots([]);
setSessionWorkspaceRoot("sy", "D:/ws-c");
assert.equal(isOutsideWorkspace("D:/ws-c/x.js", "sy"), false, "会话根独立于全局列表");
setWorkspaceRoot("D:/ws-a"); // 恢复单根兼容路径

// ── v0.5.7 复查修复：isSensitiveToolCall 透传会话根（生产调用点回归） ──
{
  setSessionWorkspaceRoot("sx", "D:/ws-a");
  assert.equal(
    isSensitiveToolCall("write", { file_path: "D:/ws-b/x.js" }, "sx"),
    true,
    "会话根下写其他工作区=敏感（要授权）"
  );
  assert.equal(
    isSensitiveToolCall("write", { file_path: "D:/ws-a/lib/x.js" }, "sx"),
    false,
    "会话根内写=不敏感（低风险新建豁免）"
  );
  assert.equal(
    isSensitiveToolCall("write", { file_path: "D:/ws-a/x.js" }),
    false,
    "无会话 id 时走全局列表（ws-a 在其中）"
  );
}

// ── v0.5.7 P0.5-5：承诺词引述语境 ──
assert.equal(isPromiseQuoteContext("认真一点，别说'保证'这样的词"), true, "引述不算承诺");
assert.equal(isPromiseQuoteContext("我保证能修好"), false, "真实承诺仍触发");

// ── v0.5.7 P0.5-6：否定/合规声明语境 ──
assert.equal(isNegatingSuggestion("不再提出新建议"), true);
assert.equal(isNegatingSuggestion("我建议用这个方案"), false);

// ── B3（2026-08-29）：无引号转述豁免 + 第一人称不豁免 + 时间词通用 ──
assert.equal(isQuoteOrParaphraseContext("用户之前说万无一失", PROMISE_WORDS), true, "B3: 无引号转述（用户说…）不触发");
assert.equal(isQuoteOrParaphraseContext("他提到过保证马上到", PROMISE_WORDS), true, "B3: 提到过+保证 不触发");
assert.equal(isQuoteOrParaphraseContext("我说保证马上到", PROMISE_WORDS), false, "B3: 第一人称'我说保证'仍按承诺（转述不了自己）");
assert.equal(isQuoteOrParaphraseContext("我保证能修好", PROMISE_WORDS), false, "B3: 裸承诺词仍触发");
assert.equal(isQuoteOrParaphraseContext("据用户转述昨天已确认", TIME_WORDS), true, "B3: 时间词转述语境不触发");
assert.equal(isQuoteOrParaphraseContext("我昨天完成了", TIME_WORDS), false, "B3: 第一人称时间词仍按未核对");

console.log("semantic-gate.test.mjs PASS");
