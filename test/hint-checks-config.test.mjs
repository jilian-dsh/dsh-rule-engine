// hint-checks-config.test.mjs - 检查文本 → hint 判定词迁配置层（第三批，2026-09-21）
//
// ① 等价性证明方式（不循环）：LEGACY = 迁移前 understander.js hintPatterns 里 10 条内联正则的
//    **逐字快照**（硬编码于本文件）；「迁移前实现」= 直接用这 10 条编；
//    「迁移后实现」= 从 patterns 的 **hint_checks 映射键**（patMap）取 source 后编同一条。
//    要求：逐 hint、逐样本等价（含 hint 顺序）。
// ② 双层模型：内置默认语言无关（无中文）／个人层注入中文夹具后恢复旧行为。
// ③ 集成：understandRule() 的 hints 字段（hintPatterns 的唯一公开入口）与旧快照逐样本等价。
import assert from "node:assert/strict";
import { understandRule, HINT_CHECK_KEYS } from "../lib/core/understander.js";
import { patMap, setPatterns, resetPatterns } from "../lib/core/patterns.js";
import { TEST_PATTERNS_ZH, useChinesePatterns } from "./helpers.mjs";

// ── ① 迁移前基线：10 条内联正则逐字快照（顺序即 hint 产出顺序）──
const LEGACY = [
  ["ask", "ask_user_question|授权|弹框", "i"],
  ["time", "get-date|时间词|昨天|今天", "i"],
  ["skill", "skill|技能", "i"],
  ["sensitive", "git\\s+(push|commit)|敏感操作|授权", "i"],
  ["backup", "删除|覆盖|备份|验证", "i"],
  ["manual", "手册", "i"],
  ["retry", "重试|连续失败|第\\s*3\\s*次", "i"],
  ["runtime-verify", "运行时验证|mock|启动|实测", "i"],
  ["source", "URL|来源|出处|引用", "i"],
  ["language", "中文|英文|语言", "i"]
];
// 前置两条（inline-command / bom-write）不属本枪范围，但为复现完整 hints 输出，快照一并保留
const LEGACY_PRE = [
  ["inline-command", "node\\s+-e|node\\s+-p|pwsh\\s+-c|--eval|--print|-Command\\b", "i"],
  ["bom-write", "set-content|out-file|add-content|writealltext|utf8bom", "i"]
];

function hintsLegacy(checkText) {
  const hints = [];
  for (const [key, src, flags] of [...LEGACY_PRE, ...LEGACY]) {
    if (new RegExp(src, flags).test(checkText)) hints.push(key);
  }
  return [...new Set(hints)];
}

/** 迁移后实现（照抄 understander.hintPatterns 的取值口径：patMap → 无 flags 编译 → 顺序遍历） */
function hintsViaMap(checkText) {
  const hints = [];
  const map = patMap("hint_checks");
  for (const key of [...LEGACY_PRE.map(([k]) => k), ...HINT_CHECK_KEYS]) {
    let src;
    if (key === "inline-command" || key === "bom-write") {
      src = LEGACY_PRE.find(([k]) => k === key)[1];
    } else {
      src = map[key];
    }
    if (typeof src !== "string" || src.length === 0) continue;
    if (new RegExp(src, "i").test(checkText)) hints.push(key);
  }
  return [...new Set(hints)];
}

// ── ② 样本池（覆盖全部 10 子键 ＋ 未命中 ＋ 空值 ＋ 英文）──
const SAMPLES = [
  "该任务首次工具调用前，会话内未 grep/read 过手册",
  "回答中出现时间表述前必须先调用 Get-Date 核对",
  "动过 node_modules 或 link 插件源码后必须验证依赖闭包",
  "用户给出模糊指令时，先列出具体执行清单",
  "删除/覆盖/迁移文件前必须先备份",
  "带 **检查（引擎硬拦）**：内联命令被硬拦",
  "重试第三次即硬拦",
  "交付前必须附运行时验证证据",
  "引用内部文档须标注来源",
  "中英混排 text",
  "runtime verification required before delivery",
  "no keywords here at all",
  "",
  "授权 与 手册 同时命中"
];

// ── ③ 默认（内置）层：语言无关 ──
resetPatterns();
const builtin = patMap("hint_checks");
assert.deepEqual(Object.keys(builtin).sort(), [...HINT_CHECK_KEYS].sort(), "内置默认子键＝10 个且与 HINT_CHECK_KEYS 一致");
for (const [k, v] of Object.entries(builtin)) {
  assert.doesNotMatch(v, /[\u4e00-\u9fff]/, `内置默认 hint_checks.${k} 含中文（应语言无关）`);
}

// ── ④ 个人层（中文夹具）注入后：与迁移前逐 hint 等价 ──
const injected = useChinesePatterns();
assert.deepEqual(injected.rejected, [], "中文夹具注入无拒绝");
const zh = patMap("hint_checks");
for (const [key, src] of LEGACY) {
  assert.equal(zh[key], src, `hint_checks.${key} 的中文 source 与 LEGACY 逐字一致`);
}
for (const s of SAMPLES) {
  assert.deepEqual(hintsViaMap(s), hintsLegacy(s), `逐 hint 等价（含顺序）：${JSON.stringify(s.slice(0, 24))}`);
}

// ── ⑤ 集成：understandRule().hints 与旧快照等价（hintPatterns 的唯一公开入口）──
for (const s of SAMPLES) {
  const cfg = understandRule({ index: "T", title: "t", section: "s", level: "A", body: `- **触发**：t。\n- **检查**：${s}\n- **动作**：a。\n- **豁免**：无。` });
  assert.deepEqual(cfg.hints, hintsLegacy(s), `understandRule hints 等价：${JSON.stringify(s.slice(0, 24))}`);
}
// 隔离验证：重置后回退内置默认（语言无关）——中文源不再生效，证明判定确经配置层取值
resetPatterns();
const builtinAgain = patMap("hint_checks");
assert.equal(builtinAgain.manual, "manual", "重置后回退内置英文默认（中文「手册」已不再生效）");
assert.doesNotMatch(builtinAgain.manual, /[\u4e00-\u9fff]/, "回退后的 manual 无中文");
useChinesePatterns(); // 还原夹具，避免影响后续测试

console.log("hint-checks-config.test.mjs PASS");
